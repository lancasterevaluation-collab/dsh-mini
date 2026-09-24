/**
 * 能力插件 ⑥ ｜ agent-loop：把循环装成服务，并给它三个扩展点
 *
 * 第 8 步已经写出了循环（`kernel/agent.ts`）。那为什么还需要这个文件？
 *
 * 因为**循环本身和"这一次任务该怎么跑"是两件事**：
 *
 *   - 循环只做"请求 → 工具 → 再请求"（第 8 步，纯能力，不依赖框架）
 *   - "用哪个 provider、哪个会话、哪条守卫链、要不要重试"是**组装决定**
 *     （第 3–6 步的框架层该管的事）
 *
 * 在这之前，组装写在每个演示的 `new Agent({...})` 里 —— 换 provider 要改演示。
 * 现在它从 ctx 上**取**服务：装什么插件，就有什么 agent。
 *
 * ── 三个扩展点，都在"任务开始之前/之后"这个自然的接缝上 ────────────────
 *
 *   | 事件 | 时机 | 谁会用 |
 *   |---|---|---|
 *   | `agent/task-ready` | 任务即将交给模型**之前**，可以改写任务文本 | 第 12 步的 nudge（把提醒拼进来） |
 *   | `agent/turn-start` | 一个 turn 开始 | 诊断（第 15 步）挂观察器 |
 *   | `agent/turn-end` | 一个 turn 结束（含失败、取消） | nudge 判定"该提醒了吗"、记忆写入 |
 *
 * ★ 注意 `agent/task-ready` 的返回值语义：**返回字符串就替换任务**。
 *   这和 waterfall 的"每一级都能改变往下传的东西"是同一个形状 ——
 *   所以 nudge 不需要循环里有任何 `if (nudge)`。
 */

import { Agent, DEFAULT_MAX_STEPS } from '../kernel/agent.ts'
import { CheckpointStore, checkpointDirOf } from '../kernel/checkpoint.ts'
import type { TurnResult } from '../kernel/agent.ts'
import type { Session } from '../kernel/session.ts'
import type { SessionStats } from '../kernel/session.ts'
import type { Provider } from '../kernel/llm.ts'
import type { ToolRegistry } from '../kernel/tools.ts'
import type { Approver, GuardChain } from '../kernel/guard.ts'
import type { GuardServices } from './guard.ts'
import type { RetryService } from './retry.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /**
     * 任务文本即将交给模型。**waterfall**：监听器返回字符串即替换任务。
     */
    'agent/task-ready': { readonly task: string; readonly sessionId: string }
    /** 一个 turn 开始。 */
    'agent/turn-start': { readonly task: string; readonly turn: number }
    /** 一个 turn 结束（正常、超步数、取消、出错都会到）。 */
    'agent/turn-end': {
      readonly task: string
      readonly result: TurnResult
      readonly session: Session
    }
  }
}

/** 配置文件里这一段能写什么。 */
export interface AgentLoopConfig {
  /** 最多走几步。 */
  readonly maxSteps?: number
  /** 覆盖工具的工作目录（不写就用 tools 插件提供的）。 */
  readonly workspace?: string
  /** 是否开启检查点（写文件前自动拍快照）。默认开启。 */
  readonly checkpoints?: boolean
}

/** 解析后的循环配置。 */
export interface AgentLoopSpec {
  readonly maxSteps: number
  readonly workspace: string | undefined
  readonly checkpoints: boolean
}

/**
 * 解析循环配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws maxSteps 不是正整数时
 */
export function resolveAgentLoopSpec(config: AgentLoopConfig | undefined): AgentLoopSpec {
  const raw = config ?? {}
  const maxSteps = raw.maxSteps ?? DEFAULT_MAX_STEPS
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`agent-loop 插件：maxSteps 必须是正整数，收到 ${String(raw.maxSteps)}`)
  }
  return { maxSteps, workspace: raw.workspace, checkpoints: raw.checkpoints ?? true }
}

/** agent 服务：应用层（第 11 步的 CLI）只需要认识它。 */
export interface AgentService {
  /**
   * 跑一个任务，直到模型收工、步数用尽或被取消。
   * @param task 用户的任务描述
   * @param signal 取消信号
   * @returns 这次 turn 的结局
   */
  runTask(task: string, signal?: AbortSignal): Promise<TurnResult>
  /** 这个 agent 正在写的会话。 */
  readonly session: Session
  /** 会话统计（步数、工具调用、重试…）。 */
  stats(): SessionStats
}

/** agent-loop 插件。 */
export const agentLoopPlugin: Plugin = {
  name: 'agent-loop',
  // ★ 只声明"我必须有"的依赖：没有模型、工具、日志就没有循环可言
  inject: ['llm', 'tools', 'session'],
  apply(ctx, config) {
    const spec = resolveAgentLoopSpec(config as AgentLoopConfig | undefined)

    const provider = ctx.require<Provider>('llm')
    const tools = ctx.require<ToolRegistry>('tools')
    const session = ctx.require<Session>('session')
    const workspace = spec.workspace ?? ctx.require<string>('workspace')

    // 这三个是**可选**依赖：不装 retry / guard 插件，循环照样能跑
    const retry = ctx.get<RetryService>('retry')
    const guards = ctx.get<GuardServices>('guards')
    const approver = ctx.get<Approver>('approver')
    const checkpoints = spec.checkpoints ? new CheckpointStore(workspace) : undefined

    let lastChain: GuardChain | undefined

    const service: AgentService = {
      session,
      async runTask(task, signal) {
        // ★ 模式提供的系统提示词：写进日志（`session/system-prompt`），
        //   再由 deriveMessages 派生成 role: 'system' 的消息 ——
        //   于是"模型当时看到的提示词是什么"是可查的，而不是内存里的隐状态。
        const prompt = ctx.get<string>('prompt')
        if (typeof prompt === 'string' && prompt !== '') {
          session.setSystemPrompt(prompt, ctx.get<string>('prompt/mode'))
        }

        await ctx.emit('agent/turn-start', { task, turn: session.stats().turns + 1 })

        // ★ 扩展点 ①：任务在交给模型前可以被改写（nudge 就挂在这里）
        const rewritten = await ctx.emit('agent/task-ready', { task, sessionId: session.id })
        const finalTask = typeof rewritten === 'string' && rewritten !== '' ? rewritten : task
        if (finalTask !== task) {
          console.log(`[agent-loop] 任务被扩展点改写：${finalTask.length} 字符（原 ${task.length}）`)
        }

        // ★ 每个任务一条新守卫链：配额、循环计数都该与任务同寿
        lastChain = guards?.factory.create()
        retry?.reset()

        const agent = new Agent({
          provider,
          tools,
          session,
          workspace,
          maxSteps: spec.maxSteps,
          ...(retry !== undefined ? { requestErrorHook: retry.hook } : {}),
          ...(lastChain !== undefined ? { guards: lastChain } : {}),
          ...(approver !== undefined ? { approver } : {}),
          ...(checkpoints !== undefined ? { checkpoints } : {}),
        })

        const result = await agent.run(finalTask, signal)
        await ctx.emit('agent/turn-end', { task: finalTask, result, session })
        return result
      },
      stats: () => session.stats(),
    }

    ctx.provide('agent', service)
    ctx.provide('agent/checkpoints', checkpoints ?? null)
    ctx.provide('agent/spec', spec)

    console.log(
      `[agent-loop] 已装载：maxSteps=${spec.maxSteps}；workspace=${workspace}；` +
        `retry=${retry === undefined ? '未装' : '已装'}；guard=${guards === undefined ? '未装' : '已装'}；` +
        `checkpoints=${checkpoints === undefined ? '关' : checkpointDirOf(workspace)}`,
    )
  },
}

export default agentLoopPlugin
