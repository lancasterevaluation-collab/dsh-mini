/**
 * 模式系统演示：五个模式，同一套内核，不同的装配
 *
 * 运行：  node src/demos/demo-modes.ts
 *
 * 这个演示要做三件事：
 *   1. 列出全部模式，对比它们的工具集（**装配确实不同**）
 *   2. 让 PTC 模式真的写一段程序、跑起来（**PTC 省了多少上下文**）
 *   3. 让多智能体模式真的派发子智能体（**隔离是真的**）
 *
 * ── 为什么演示里要自己写 provider ★ ───────────────────────────────────
 *
 * 因为 `MockProvider` 的脚本是写死的（它只会 `list_dir → read_file`），
 * `LocalProvider` 只认几条关键词 —— 它们都**演不出"模型写程序"和"模型派发子任务"**。
 * 所以这里用一个按脚本走的 provider：它按顺序吐出"要调什么工具"，
 * 于是 PTC 与多智能体这两条最难演示的路径都能被真实跑一遍。
 */

import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { Agent } from '../kernel/agent.ts'
import type { ChatMessage, LLMResponse, Provider } from '../kernel/llm.ts'
import { ToolRegistry } from '../kernel/tools.ts'
import type { Session } from '../kernel/session.ts'
import { loadProfile } from '../framework/loader.ts'
import { listModes, resolveMode } from '../apps/shared-mode.ts'
import type { LoadedProfile } from '../framework/loader.ts'
import type { GuardServices } from '../plugins/guard.ts'
import type { Approver } from '../kernel/guard.ts'

const HERE = import.meta.dirname
const CHAT_PROFILE = resolve(HERE, '../../profiles/chat.json')

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 一条脚本指令。 */
interface Step {
  readonly content?: string
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[]
}

/**
 * 按脚本走的 provider：演"模型想做什么"。
 *
 * 它存在的唯一理由是：**PTC 与多智能体这两条路径，只有模型主动发起才跑得起来**，
 * 而现成的 mock/local provider 都不会主动发起。
 */
class ScriptedProvider implements Provider {
  #script: Step[]
  #index = 0

  constructor(script: readonly Step[]) {
    this.#script = [...script]
  }

  async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
    const last = messages[messages.length - 1]

    // 刚拿到工具结果 → 走到脚本的下一步
    if (last?.role === 'tool') {
      const step = this.#script.shift()
      return toResponse(step, this.#index++)
    }

    // 第一次（或还没开始）→ 取脚本当前项
    return toResponse(this.#script.shift(), this.#index++)
  }
}

/** 把脚本项转成一个响应。 */
function toResponse(step: Step | undefined, index: number): LLMResponse {
  if (step === undefined) {
    return { content: '（脚本已用完，收工）', toolCalls: [], usage: {} }
  }
  if (step.toolCalls === undefined) {
    return { content: step.content ?? '', toolCalls: [], usage: {} }
  }
  return {
    content: step.content ?? '',
    toolCalls: step.toolCalls.map((call, position) => ({
      id: `script-${index}-${position}`,
      name: call.name,
      arguments: call.arguments,
      rawArguments: JSON.stringify(call.arguments),
      parseError: '',
    })),
    usage: {},
  }
}

/** 按某个模式装载一套装配。 */
async function loadWithMode(modeId: string): Promise<{ loaded: LoadedProfile; modeId: string }> {
  const mode = await resolveMode(modeId)
  const loaded = await loadProfile(CHAT_PROFILE, [], { transformRows: mode.transformRows })
  return { loaded, modeId }
}

/** 用自定义 provider 在已装载的装配里跑一个任务。 */
async function runWith(
  loaded: LoadedProfile,
  provider: Provider,
  task: string,
  maxSteps: number,
): Promise<{ readonly status: string; readonly steps: number; readonly text: string; readonly session: Session }> {
  const ctx = loaded.ctx
  const session = ctx.require<Session>('session')

  // ★ 守卫要**手工接上**：真实路径里这件事由 `plugins/agent-loop.ts` 做，
  //   而这个演示绕过了它直接 new Agent —— 忘了接就等于演示里没有守卫，
  //   写源码也不会被拦（第一次跑这个演示时正是这么错的）。
  const guards = ctx.get<GuardServices>('guards')
  const approver = ctx.get<Approver>('approver')
  const chain = guards?.factory.create()

  const agent = new Agent({
    provider,
    tools: ctx.require<ToolRegistry>('tools'),
    session,
    workspace: ctx.require<string>('workspace'),
    maxSteps,
    ...(chain !== undefined ? { guards: chain } : {}),
    ...(approver !== undefined ? { approver } : {}),
  })

  const result = await agent.run(task)
  return { status: result.status, steps: result.steps, text: result.text, session }
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：五个模式，五套装配
  // ==========================================================
  console.log('======== 演示 1：五个模式的装配差异 ========')

  const modes = await listModes()
  for (const summary of modes) {
    const mode = await resolveMode(summary.id)
    const loaded = await loadProfile(CHAT_PROFILE, [], { transformRows: mode.transformRows })
    const tools = loaded.ctx.require<ToolRegistry>('tools').names()
    const hasSubagent = loaded.ctx.get('subagent') !== undefined
    const promptMode = loaded.ctx.get<string>('prompt/mode')

    console.log(
      `  ${summary.id.padEnd(13)} 工具=[${tools.join(', ')}]` +
        `${hasSubagent ? ' +spawn_agent' : ''}　提示词=${promptMode}`,
    )
    loaded.unloadAll()
  }
  console.log('\n★ 同一份 profile、同一套内核，只有 `modes/*.json` 不同 —— 装配就不同。')

  // ==========================================================
  // 演示 2：PTC 模式真的在跑程序
  // ==========================================================
  console.log('\n======== 演示 2：PTC 模式写程序批量干活 ========')

  const ptc = await loadWithMode('ptc')
  try {
    // 模型"写"的这段程序：读 3 个文件 + 列目录 = 4 次工具调用，只回一行统计
    const program = `
const names = ['README.md', 'notes.txt', 'important.txt']
const texts = []
for (const name of names) {
  const text = await tools.read_file({ path: name })
  texts.push({ name, lines: text.split('\\n').length, bytes: text.length })
}
const listing = await tools.list_dir({ path: '.' })
console.log('统计结果：')
for (const item of texts) console.log('  ' + item.name + ' → ' + item.lines + ' 行 / ' + item.bytes + ' 字节')
console.log('工作目录条目数：', listing.split('\\n').filter(Boolean).length)
globalThis.result = { files: texts.length, entries: listing.split('\\n').filter(Boolean).length }
`

    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'run_program', arguments: { program } }] },
      { content: '统计完成，见上面的结果。' },
    ])

    const result = await runWith(ptc.loaded, provider, '统计工作目录里的文件', 4)
    show('PTC 模式的结果', { status: result.status, steps: result.steps, text: result.text })

    const toolResults = result.session.events.filter((event) => event.type === 'tool/result')
    show('进上下文的工具结果', toolResults.map((event) => {
      const data = event.data as { content: string; isError: boolean }
      return `${data.isError ? '✗' : '✓'} ${data.content.split('\n')[0]}`
    }))
    console.log('\n★ 程序内部调了 4 次工具，但**上下文里只有 1 条 tool/result** ——')
    console.log('  这就是 PTC 的核心收益：中间结果留在程序里，不进对话。')
  } finally {
    ptc.loaded.unloadAll()
  }

  // ==========================================================
  // 演示 3：最小模式只有一个 shell
  // ==========================================================
  console.log('\n======== 演示 3：最小模式只有一个终端工具 ========')

  const minimal = await loadWithMode('minimal')
  try {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'run_command', arguments: { command: 'node --version' } }] },
      { content: '看到 Node 版本了。' },
    ])
    const result = await runWith(minimal.loaded, provider, '看看 node 版本', 3)
    show('最小模式的结果', { status: result.status, steps: result.steps })

    const first = result.session.events.find((event) => event.type === 'tool/result')
    show('run_command 的输出', String((first?.data as { content: string } | undefined)?.content ?? '(无)').split('\n').slice(0, 4).join('\n'))
  } finally {
    minimal.loaded.unloadAll()
  }

  // ==========================================================
  // 演示 4：多智能体模式派发子智能体
  // ==========================================================
  console.log('\n======== 演示 4：多智能体模式派发子智能体 ========')

  const multi = await loadWithMode('multi-agent')
  try {
    show('装配里有没有 subagent 服务', multi.loaded.ctx.get('subagent') !== undefined)
    show('工具表（spawn_agent 由 multi-agent 插件注册）', multi.loaded.ctx.require<ToolRegistry>('tools').names())

    // 主 agent 一次派发两个子任务；子智能体自己也用脚本 provider（简单跑两步）
    const provider = new ScriptedProvider([
      {
        toolCalls: [{
          name: 'spawn_agent',
          arguments: {
            tasks: [
              '数一数工作目录里有几个文件（用 list_dir）',
              '读一下 notes.txt 的第一行（用 read_file）',
            ],
          },
        }],
      },
      { content: '两个子智能体都回来了，结论如上。' },
    ])

    const result = await runWith(multi.loaded, provider, '派两个子任务', 5)
    show('主 agent 的结果', { status: result.status, steps: result.steps })

    const spawnResult = result.session.events.find((event) => event.type === 'tool/result')
    const text = String((spawnResult?.data as { content: string } | undefined)?.content ?? '')
    console.log('\n子智能体的返回（进主 agent 上下文的就是这一段）：')
    console.log(text.split('\n').slice(0, 24).map((line) => `  ${line}`).join('\n'))
    console.log('\n★ 注意每个子智能体都有自己的 sessionId —— 它们的过程写在自己的会话日志里，')
    console.log('  主 agent 的上下文只留下结论。')
  } finally {
    multi.loaded.unloadAll()
  }

  // ==========================================================
  // 演示 5：模式决定的不只是工具，还有权限
  // ==========================================================
  console.log('\n======== 演示 5：创造模式的写权限分级 ========')

  const creator = await loadWithMode('creator')
  try {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{
          name: 'write_skill',
          arguments: {
            name: 'demo-generated-skill',
            description: '（演示生成）检查工作目录里的文件数量',
            triggers: ['数文件', '检查目录'],
            body: '## 步骤\n\n1. 用 list_dir 列出工作目录\n2. 数其中的条目\n3. 报告数量\n',
          },
        }],
      },
      { content: '技能写好了。' },
    ])
    const result = await runWith(creator.loaded, provider, '把这段流程记成技能', 3)
    show('写技能的结果', { status: result.status, steps: result.steps })

    const skillResult = result.session.events.find((event) => event.type === 'tool/result')
    show('工具返回', (skillResult?.data as { content: string } | undefined)?.content)

    // 写插件是 irreversible：默认守卫会要求审批，而审批人是"一律拒绝"
    const pluginProvider = new ScriptedProvider([
      {
        toolCalls: [{
          name: 'write_plugin',
          arguments: { name: 'demo-generated-plugin', source: 'export default { name: "x", apply() {} }' },
        }],
      },
      { content: '被拒绝了，我换个方式。' },
    ])
    const blocked = await runWith(creator.loaded, pluginProvider, '写一个插件', 3)
    const guardEvent = blocked.session.events.find((event) => event.type === 'tool/guard')
    show('写源码被守卫拦下', {
      裁决: (guardEvent?.data as { verdict?: string } | undefined)?.verdict ?? '(没有拦截记录)',
      规则: (guardEvent?.data as { byRule?: string } | undefined)?.byRule ?? '',
    })
    console.log('\n★ 技能（数据）可以自己写，源码（机制）默认要人工审批 —— 这个摩擦是有意的。')

    // 演示要留下启发，不要留下垃圾：把刚才写进去的技能删掉
    const generated = resolve(HERE, '../../skills/demo-generated-skill.md')
    const removed = await rm(generated, { force: true }).then(() => true, () => false)
    console.log(`\n（已清理演示写入的 skills/demo-generated-skill.md：${removed ? '删除成功' : '文件不存在'}）`)
  } finally {
    creator.loaded.unloadAll()
  }
}

await main()
