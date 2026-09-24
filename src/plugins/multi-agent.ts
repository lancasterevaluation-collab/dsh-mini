/**
 * 多智能体插件：主从派发
 *
 * 一个 agent 的价值有上限 —— 它的上下文是有限的。当子任务"过程很长、结论很短"时
 * （把 20 个文件读一遍、从三个角度审一段代码、分别核对几批事实），
 * 让主 agent 自己做完，就意味着**所有中间信息都要挤进它的上下文**。
 *
 * 派发解决的正是这件事：
 *
 *     主 agent ──spawn_agent──► 子 agent #1（独立会话 · 独立工具集 · 独立步数预算）
 *              ──spawn_agent──► 子 agent #2
 *              ◄──── 只有结论回到主 agent 的上下文 ────
 *
 * ── ★ 隔离是**真的**，不是"再开个循环" ★ ──────────────────────────────
 *
 * 每个子 agent 拿到三样独立的东西，它们都由既有机制提供、这里一行都没新造：
 *
 * | 隔离项 | 靠什么 | 来自第几步 |
 * |---|---|---|
 * | 独立会话（各写各的日志） | `session/factory` | 第 7 步 |
 * | 独立工具集（看不见别人的工具） | `subsetTools()` + 作用域 | 第 2、5 步 |
 * | 独立循环与预算 | `new Agent({ maxSteps })` | 第 8 步 |
 *
 * 这就是"DSP 级"和"玩具"的差别在功能上的体现：**加一个多智能体，没有改循环**。
 * 如果当初把子 agent 做成 `agent.ts` 里的一个 `if (isSubagent)`，这里就得动核心代码。
 *
 * ── 为什么工具是"批量"而不是"单个" ★ ──────────────────────────────────
 *
 * 因为 `kernel/agent.ts` 的工具调用是**串行**的（第 8 步的取舍：一个一个来，
 * 日志顺序才清楚）。如果 `spawn_agent` 一次只能派一个，那么"并行派发三件事"
 * 就会退化成串行 —— 而并行恰恰是派发最主要的收益之一。
 * 所以接口上直接给了 `tasks: string[]`：一次调用，内部并发。
 *
 * ── 代价（诚实清单）──────────────────────────────────────────────────
 *
 * 1. **子 agent 不能反问**：它看不到主对话，也无法向主 agent 提问。
 *    所以派发必须"一次说清"—— 任务描述含糊时它会自己脑补。
 * 2. **预算是独立的、也是有限的**：子 agent 撞到步数上限时只能中途停下，
 *    主 agent 拿到的是"没做完 + 卡在哪"。
 * 3. **不继承守卫链**：子 agent 的工具调用会过它自己的守卫（如果配了），
 *    但父 agent 那条链的策略不会自动传下去 —— 这是刻意留的简化。
 */

import { Agent } from '../kernel/agent.ts'
import { subsetTools } from '../framework/scope.ts'
import type { TurnStatus } from '../kernel/agent.ts'
import type { Provider } from '../kernel/llm.ts'
import type { Tool, ToolRegistry, ToolResult } from '../kernel/tools.ts'
import type { Session } from '../kernel/session.ts'
import type { Plugin } from '../framework/context.ts'
import type { SessionFactory } from './session.ts'
import type { RetryService } from './retry.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 派发了一个子智能体。 */
    'subagent/spawned': { task: string; sessionId: string; tools: number; maxSteps: number }
    /** 一个子智能体跑完了（含失败与超预算）。 */
    'subagent/finished': {
      task: string
      sessionId: string
      status: string
      steps: number
      durationMs: number
    }
  }
}

/** 一次派发请求。 */
export interface SubagentRequest {
  /** 要交给子智能体的任务（必须自包含：它看不到主对话）。 */
  readonly task: string
  /** 限制子智能体能看到哪些工具；不给 = 与父 agent 相同的工具集。 */
  readonly tools?: readonly string[]
  /** 子智能体的步数预算；不给用 `defaultMaxSteps`。 */
  readonly maxSteps?: number
}

/** 一次派发的结果。 */
export interface SubagentResult {
  readonly task: string
  readonly status: TurnStatus
  readonly steps: number
  readonly output: string
  readonly sessionId: string
  readonly durationMs: number
  /** 失败原因（正常结束时为空串）。 */
  readonly error: string
}

/** 子智能体服务。 */
export interface SubagentService {
  /**
   * 派发一个子智能体。
   * @param request 派发请求
   * @returns 它的结论
   */
  spawn(request: SubagentRequest): Promise<SubagentResult>
  /**
   * 并发派发多个子智能体。
   * @param requests 请求列表
   * @returns 与输入顺序一致的结果
   */
  spawnMany(requests: readonly SubagentRequest[]): Promise<SubagentResult[]>
}

/** 配置文件里这一段能写什么。 */
export interface MultiAgentConfig {
  /** 子智能体默认的步数预算。 */
  readonly defaultMaxSteps?: number
  /** 同时最多允许几个子智能体在跑。 */
  readonly maxConcurrent?: number
  /** 子智能体是否继承父 agent 的提示词（默认继承，并追加一段"你是子智能体"）。 */
  readonly inheritPrompt?: boolean
  /** 是否把 `spawn_agent` 工具注册进工具表（默认注册）。 */
  readonly exposeTool?: boolean
}

/** 解析后的配置。 */
export interface MultiAgentSpec {
  readonly defaultMaxSteps: number
  readonly maxConcurrent: number
  readonly inheritPrompt: boolean
  readonly exposeTool: boolean
}

/** 子智能体的合成提示词里额外加的那段。 */
const SUBAGENT_PREAMBLE = [
  '你是一个**子智能体**，被主智能体派来独立完成一件子任务。',
  '',
  '- 你看不到主对话，也没法反问：把任务描述当作全部背景。',
  '- 你的答复会被主智能体直接采用，所以要**给结论**（做了什么、结果是什么、卡在哪）。',
  '- 不要复述你调用了哪些工具 —— 那些记在你自己的会话日志里。',
  '- 预算有限，撞到上限就停下来并说明进度。',
].join('\n')

/**
 * 解析多智能体配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws 数值非法时
 */
export function resolveMultiAgentSpec(config: MultiAgentConfig | undefined): MultiAgentSpec {
  const raw = config ?? {}
  const defaultMaxSteps = raw.defaultMaxSteps ?? 8
  const maxConcurrent = raw.maxConcurrent ?? 4

  if (!Number.isInteger(defaultMaxSteps) || defaultMaxSteps < 1) {
    throw new Error(`multi-agent 插件：defaultMaxSteps 必须是正整数，收到 ${String(raw.defaultMaxSteps)}`)
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`multi-agent 插件：maxConcurrent 必须是正整数，收到 ${String(raw.maxConcurrent)}`)
  }

  return {
    defaultMaxSteps,
    maxConcurrent,
    inheritPrompt: raw.inheritPrompt ?? true,
    exposeTool: raw.exposeTool ?? true,
  }
}

/** multi-agent 插件。 */
export const multiAgentPlugin: Plugin = {
  name: 'multi-agent',
  inject: ['llm', 'tools', 'session'],
  apply(ctx, config) {
    const spec = resolveMultiAgentSpec(config as MultiAgentConfig | undefined)

    const provider = ctx.require<Provider>('llm')
    const parentTools = ctx.require<ToolRegistry>('tools')
    const parentSession = ctx.require<Session>('session')
    const workspace = ctx.require<string>('workspace')
    const factory = ctx.get<SessionFactory>('session/factory')
    const retry = ctx.get<RetryService>('retry')
    const prompt = ctx.get<string>('prompt') ?? ''

    let counter = 0

    const spawn = async (request: SubagentRequest): Promise<SubagentResult> => {
      const started = Date.now()
      counter += 1
      const id = `sub-${counter}-${Date.now().toString(36)}`

      // ① 独立会话：子智能体的全部过程写进它自己的日志
      const childSession = factory === undefined
        ? new (await import('../kernel/session.ts')).Session(id)
        : factory.create(id)

      // ② 独立工具集：只给它该看到的那些（作用域 + 子集，第 2、5 步的能力）
      const childTools = request.tools === undefined
        ? parentTools
        : subsetTools(parentTools, request.tools)

      const maxSteps = request.maxSteps ?? spec.defaultMaxSteps
      await ctx.emit('subagent/spawned', {
        task: request.task,
        sessionId: id,
        tools: childTools.names().length,
        maxSteps,
      })

      // ③ 独立循环：同一个 Agent 类，不同的依赖 —— 没有为"子智能体"新写任何循环代码
      const agent = new Agent({
        provider,
        tools: childTools,
        session: childSession,
        workspace,
        maxSteps,
        ...(retry !== undefined ? { requestErrorHook: retry.hook } : {}),
      })

      let status: TurnStatus = 'error'
      let steps = 0
      let output = ''
      let error = ''

      try {
        if (prompt !== '' && spec.inheritPrompt) {
          childSession.setSystemPrompt(`${prompt}\n\n---\n\n${SUBAGENT_PREAMBLE}`, 'subagent')
        } else {
          childSession.setSystemPrompt(SUBAGENT_PREAMBLE, 'subagent')
        }

        const result = await agent.run(request.task)
        status = result.status
        steps = result.steps
        output = result.text
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        output = ''
      }

      const durationMs = Date.now() - started
      await ctx.emit('subagent/finished', { task: request.task, sessionId: id, status, steps, durationMs })

      return { task: request.task, status, steps, output, sessionId: id, durationMs, error }
    }

    const spawnMany = async (requests: readonly SubagentRequest[]): Promise<SubagentResult[]> => {
      const results: SubagentResult[] = []
      // 分批并发：一次放出全部会让"某个子智能体卡住"变成整体卡住，
      // 也不利于观察；分批之后 maxConcurrent 就是一个真实的节流阀。
      for (let index = 0; index < requests.length; index += spec.maxConcurrent) {
        const batch = requests.slice(index, index + spec.maxConcurrent)
        results.push(...(await Promise.all(batch.map((item) => spawn(item)))))
      }
      return results
    }

    const service: SubagentService = { spawn, spawnMany }
    ctx.provide('subagent', service)

    if (spec.exposeTool) {
      const register = ctx.get<(tool: Tool) => void>('tools/register')
      const tool = createSpawnTool(service, parentTools)
      if (register !== undefined) register(tool)
      else parentTools.register(tool)
    }

    console.log(
      `[multi-agent] 已装载：defaultMaxSteps=${spec.defaultMaxSteps} maxConcurrent=${spec.maxConcurrent}` +
        `；工具=${spec.exposeTool ? '已暴露 spawn_agent' : '未暴露'}`,
    )

    void parentSession
  },
}

/**
 * 造 `spawn_agent` 工具。
 * @param service 子智能体服务
 * @param parentTools 父 agent 的工具表（用于校验子任务里写的工具名）
 * @returns 工具定义
 */
function createSpawnTool(service: SubagentService, parentTools: ToolRegistry): Tool {
  return {
    name: 'spawn_agent',
    description: [
      '把一个**自包含**的子任务派发给子智能体：它有独立会话、独立工具集、独立步数预算，',
      '跑完后只把结论交还给你（中间过程不占你的上下文）。',
      '',
      '两种用法：',
      '  · task: "把 X 做完并给出结论"        —— 派一个',
      '  · tasks: ["做 A", "做 B", "做 C"]    —— 一次派多个，它们会并发跑',
      '',
      '适合：过程长结论短、或彼此独立可以并行的事。',
      '不适合：只做一两步的事；或需要你看着中间结果再决定下一步的事。',
      '',
      '注意：子智能体看不到你们的对话、也无法反问你 —— 任务描述要写完整，并说清"什么叫完成"。',
    ].join('\n'),
    sideEffect: 'none',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '单个子任务' },
        tasks: {
          type: 'array',
          description: '多个子任务（与 task 二选一；给了这个就并发派发）',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          description: '限制子智能体能用的工具（不给则与当前相同）',
          items: { type: 'string' },
        },
        maxSteps: { type: 'number', description: '子智能体的步数预算' },
      },
    },
    async handler(args): Promise<ToolResult> {
      const single = typeof args.task === 'string' ? args.task.trim() : ''
      const many = Array.isArray(args.tasks)
        ? args.tasks.map((item) => String(item).trim()).filter((item) => item !== '')
        : []

      if (single === '' && many.length === 0) {
        return { content: '要给 task 或 tasks。', isError: true }
      }

      // 工具名校验放在派发之前：让"写错了工具名"当场报错，
      // 而不是等子智能体自己发现"我没有这个工具"
      const requested = Array.isArray(args.tools) ? args.tools.map((item) => String(item)) : undefined
      if (requested !== undefined) {
        const unknown = requested.filter((name) => parentTools.get(name) === undefined)
        if (unknown.length > 0) {
          return {
            content: `子任务指定的工具里有不存在的：${unknown.join(', ')}；可用：${parentTools.names().join(', ')}`,
            isError: true,
          }
        }
      }

      const requests: SubagentRequest[] = (single !== '' ? [single] : many).map((task) => ({
        task,
        ...(requested !== undefined ? { tools: requested } : {}),
        ...(typeof args.maxSteps === 'number' ? { maxSteps: args.maxSteps } : {}),
      }))

      const started = Date.now()
      const results = requests.length === 1
        ? [await service.spawn(requests[0] as SubagentRequest)]
        : await service.spawnMany(requests)

      const blocks = results.map((result, index) => [
        `── 子智能体 ${index + 1} ──────────────────────────`,
        `任务：${result.task}`,
        `状态：${result.status}（${result.steps} 步，会话 ${result.sessionId}）`,
        result.error === '' ? '' : `错误：${result.error}`,
        '结论：',
        result.output.trim() === '' ? '（没有给出文本结论）' : result.output.trim(),
      ].filter((line) => line !== '').join('\n'))

      const header = `（派发 ${results.length} 个子智能体，共耗时 ${Date.now() - started} ms）`
      const failed = results.filter((item) => item.status !== 'complete').length
      const body = [header, ...blocks].join('\n\n')

      return failed === 0 ? { content: body, isError: false } : { content: body, isError: true }
    },
  }
}

export default multiAgentPlugin
