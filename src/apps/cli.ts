/**
 * 第 11 步 ｜ 应用层：一个真正的 CLI 入口
 *
 * 到第 10 步为止，跑一个任务都要写一个演示文件。这一步把它收成一条命令：
 *
 *     node src/apps/cli.ts "看看这个目录里有什么，然后读一下 README"
 *
 * ── 应用层的位置：它是**唯一**被允许"知道全部"的地方 ─────────────────────
 *
 *     apps/        选 profile → 装载 → 跑任务 → 报告      ← 你在这里
 *     profiles/    配置即组合（JSON）
 *     plugins/     能力，每个只认识自己的依赖
 *     framework/   容器、事件、作用域、装载器
 *     kernel/      纯能力，不认识上面任何人
 *
 * 所以这个文件**不做业务判断**：它不 `if (type === 'x')`，不构造 provider，
 * 不决定重试策略。它只做两件事 —— **装载**与**报告**。
 * 一旦发现自己在 CLI 里写业务逻辑，那说明有个插件没写完。
 *
 * ── 三个必须做对的细节 ────────────────────────────────────────────────
 *
 * ① **dump 是配置系统的解药**："改了配置但没生效"是这类系统最经典的故障，
 *    而 `--dump` 能让"最终生效的行"直接可读。所以它排在任何执行之前。
 *
 * ② **退出码要真实**：装载失败、任务失败都不该以 0 退出，
 *    否则 `cli.ts ... && echo ok` 这种用法会说谎。
 *
 * ③ **卸载要发生**：进程退出前把插件卸载掉。演示里看不出差别，
 *    但它保证了"资源释放写在插件的 disposer 里"这件事真的被验证过。
 */

import { resolve } from 'node:path'
import { loadProfile } from '../framework/loader.ts'
import type { LoadedProfile } from '../framework/loader.ts'
import type { AgentService } from '../plugins/agent-loop.ts'
import type { RetryService } from '../plugins/retry.ts'
import type { SessionEvent } from '../kernel/session.ts'

/** 命令行参数解析结果。 */
interface CliArgs {
  readonly task: string
  readonly profile: string
  readonly patches: readonly string[]
  readonly dumpOnly: boolean
  readonly maxSteps: number | undefined
}

/** 本文件所在目录 —— 默认 profile 路径相对于它，保证从任意 cwd 都能跑。 */
const HERE = import.meta.dirname

/**
 * 解析命令行参数。
 * @param argv `process.argv.slice(2)`
 * @returns 解析结果
 * @throws 用法错误时（缺任务、未知开关）
 */
function parseArgs(argv: readonly string[]): CliArgs {
  let profile = resolve(HERE, '../../profiles/agent.json')
  const patches: string[] = []
  let dumpOnly = false
  let maxSteps: number | undefined
  const words: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--profile') {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error('--profile 后面要跟文件路径')
      profile = resolve(value)
    } else if (token === '--patch') {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error('--patch 后面要跟文件路径')
      patches.push(resolve(value))
    } else if (token === '--max-steps') {
      index += 1
      const value = Number(argv[index])
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-steps 必须是正整数')
      maxSteps = value
    } else if (token === '--dump') {
      dumpOnly = true
    } else if (token.startsWith('--')) {
      throw new Error(`未知开关：${token}`)
    } else {
      words.push(token)
    }
  }

  const task = words.join(' ').trim()
  if (!dumpOnly && task === '') {
    throw new Error('缺少任务描述。用法：node src/apps/cli.ts "任务描述"')
  }

  return { task, profile, patches, dumpOnly, maxSteps }
}

/** 打印事件流摘要 —— 只挑有信息量的事件，避免把 600 条日志刷屏。 */
function summarizeEvents(events: readonly SessionEvent[]): void {
  const keep = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/guard', 'assistant/attempt'])
  const lines: string[] = []
  for (const event of events) {
    if (!keep.has(event.type)) continue
    const data = event.data as Record<string, unknown>
    if (event.type === 'user/message') lines.push(`  #${event.seq} 用户：${String(data.text).slice(0, 60)}`)
    else if (event.type === 'assistant/message') {
      const calls = Array.isArray(data.toolCalls) ? data.toolCalls.length : 0
      const text = String(data.content ?? '').replace(/\s+/g, ' ').slice(0, 50)
      lines.push(`  #${event.seq} 模型：${text === '' ? '(无文本)' : text}${calls > 0 ? ` → 要调用 ${calls} 个工具` : ''}`)
    } else if (event.type === 'tool/call') lines.push(`  #${event.seq}   调用 ${String(data.name)}`)
    else if (event.type === 'tool/result') lines.push(`  #${event.seq}   结果 ${data.isError === true ? '✗' : '✓'} ${String(data.content).split('\n')[0]?.slice(0, 60)}`)
    else if (event.type === 'tool/guard') lines.push(`  #${event.seq}   ★ 守卫 ${String(data.verdict)} by ${String(data.byRule)}`)
    else if (event.type === 'assistant/attempt') lines.push(`  #${event.seq}   ↻ 失败尝试 ${String(data.attempt)}：${String(data.code)}`)
  }
  console.log(lines.join('\n'))
}

/**
 * 装载 profile、跑一个任务、报告结果。整个流程的**唯一**入口。
 * @param args 解析好的参数
 * @returns 进程退出码
 */
async function main(args: CliArgs): Promise<number> {
  let loaded: LoadedProfile | undefined
  try {
    loaded = await loadProfile(args.profile, args.patches)

    console.log('\n======== 生效的配置 ========')
    loaded.dump()

    if (args.dumpOnly) return 0

    const ctx = loaded.ctx
    const agent = ctx.get<AgentService>('agent')
    if (agent === undefined) {
      console.error('\n✗ 这个 profile 里没有 agent 服务 —— 检查是否装载了 agent-loop 插件。')
      return 1
    }

    const controller = new AbortController()
    process.on('SIGINT', () => {
      console.log('\n收到中断信号，正在取消任务…')
      controller.abort()
    })

    console.log(`\n======== 开始任务 ========\n${args.task}\n`)

    const started = Date.now()
    const result = await agent.runTask(args.task, controller.signal)
    const elapsed = Date.now() - started

    console.log('\n======== 事件流 ========')
    summarizeEvents(agent.session.events)

    const stats = agent.stats()
    console.log('\n======== 结果 ========')
    console.log(`  状态        ${result.status}`)
    console.log(`  步数        ${result.steps}`)
    console.log(`  输出        ${result.text === '' ? '(无)' : result.text}`)
    console.log(`  耗时        ${elapsed} ms`)
    console.log(`  工具调用    ${stats.toolCalls}（失败 ${stats.toolErrors}）`)
    console.log(`  守卫        deny=${stats.guardDenials} ask=${stats.guardAsks}`)
    console.log(`  失败尝试    ${stats.attempts}`)
    console.log(`  消息数      ${stats.messages}（这就是模型看到的全部）`)

    const retry = ctx.get<RetryService>('retry')
    if (retry !== undefined) {
      const retryStats = retry.stats()
      console.log(`  重试        决定重试 ${retryStats.retries} 次；按错误码 ${JSON.stringify(retryStats.byCode)}`)
    }

    // ★ 退出码要真实：被取消和出错都不是成功
    return result.status === 'complete' ? 0 : 2
  } catch (error) {
    console.error('\n✗ 运行失败：', error instanceof Error ? error.message : error)
    return 1
  } finally {
    // 卸载：让每个插件的 disposer 真的被跑到（配置文件路径、快照目录等都在这里收尾）
    loaded?.unloadAll()
  }
}

const exitCode = await main(parseArgs(process.argv.slice(2)))
process.exitCode = exitCode
