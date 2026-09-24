/**
 * 交互式对话框（终端版）
 *
 * 到这一步为止，`cli.ts` 是"一条命令跑一个任务然后退出"。
 * 这个文件把它变成**坐在那里跟你聊天的东西**：
 *
 *     你 › 看看这个目录里有什么
 *       ⚙ list_dir
 *       ✓ README.md
 *     助手 › （离线规则模式）工作目录里有 3 个条目：README.md、important.txt、notes.txt
 *
 * ── 为什么"多轮对话"几乎不用写代码 ★ ──────────────────────────────────
 *
 * 这是第 7 步那个决定换来的红利：会话日志是**唯一真相**，
 * 而 `Agent.run()` 每次都会往同一个会话里 append 一条 `user/message`。
 * 于是只要**复用同一个会话**，模型下一轮就自动看得到前面全部历史 ——
 * 对话框自己一行消息数组都没维护。
 *
 * 反过来说：如果循环当初自己维护了一个 `messages` 数组，
 * "多轮对话"就会变成"给那个数组追加"，而"它和日志一致"就成了额外负担 ——
 * 这类系统到最后总会出现"界面上看到的和模型看到的不是一回事"。
 *
 * ── ★ 为什么用事件驱动，而不是 `await rl.question()` ★ ────────────────
 *
 * 因为它**不可测试**。Node 的 `readline` 在 stdin 不是 TTY 时（管道、重定向文件）
 * 会把整个输入一次性读完并 emit 成 `line` 事件；此时第二个 `question()`
 * 永远等不到数据，表现为 `Detected unsettled top-level await` 然后进程静默退出。
 *
 * 也就是说：用 `question()` 写的对话框，**只有人手敲才能验证**，
 * 而"只能人工验证"的东西在这个项目里等于没有验收。
 * 改成 `line` 事件 + 串行队列之后，管道输入和真人在终端敲是同一套代码路径 ——
 * 于是 `verify.ts` 能自动跑它。
 *
 * ── 代价（要知道自己在放弃什么）──────────────────────────────────────
 *
 * 1. **上下文只增不减**：聊得越久，每次请求带的历史越长（真模型下会撞上下文上限）。
 *    对策是 `/new` 重开会话；自动压缩本项目没做。
 * 2. **没有流式输出**：回答是整段出现的，不是逐字蹦出来的。
 * 3. **终端里的"美观"有上限**：颜色和缩进就是全部手段 —— 所以另有 Web GUI。
 *
 * 运行：
 *     node src/apps/repl.ts
 *     node src/apps/repl.ts --profile profiles/chat-deepseek.json
 *     cmd /c "node src/apps/repl.ts < 输入.txt"     # 批处理模式（也可用于自动化验收）
 */

import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { resolve } from 'node:path'
import { loadProfile } from '../framework/loader.ts'
import type { LoadedProfile } from '../framework/loader.ts'
import { listModes, resolveMode } from './shared-mode.ts'
import type { ResolvedMode } from './shared-mode.ts'
import { ToolRegistry } from '../kernel/tools.ts'
import type { AgentService } from '../plugins/agent-loop.ts'
import type { RetryService } from '../plugins/retry.ts'
import type { LLMSpec } from '../plugins/llm.ts'
import type { Session, SessionEvent } from '../kernel/session.ts'

/** 本文件所在目录 —— 默认 profile 相对它，保证从任意 cwd 都能跑。 */
const HERE = import.meta.dirname

// ============================================================
// 一、终端着色：零依赖下"美观"的全部手段
// ============================================================

/** 极简 ANSI 着色。Windows 10+ 终端与现代终端都支持。 */
const paint = {
  bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
  cyan: (text: string): string => `\x1b[36m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
  red: (text: string): string => `\x1b[31m${text}\x1b[0m`,
  gray: (text: string): string => `\x1b[90m${text}\x1b[0m`,
}

// ============================================================
// 二、命令行参数
// ============================================================

/** 解析结果。 */
interface ReplArgs {
  readonly profile: string
  readonly patches: readonly string[]
  /** 可变：`/mode <id>` 会在运行时改它并重装。 */
  mode: string | undefined
  readonly showAllEvents: boolean
}

/**
 * 解析参数。
 * @param argv `process.argv.slice(2)`
 * @returns 解析结果
 * @throws 未知开关时
 */
function parseArgs(argv: readonly string[]): ReplArgs {
  let profile = resolve(HERE, '../../profiles/chat.json')
  const patches: string[] = []
  let mode: string | undefined
  let showAllEvents = false

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
    } else if (token === '--mode') {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error('--mode 后面要跟模式 id（用 --list-modes 看有哪些）')
      mode = value
    } else if (token === '--events') {
      showAllEvents = true
    } else if (token.startsWith('--')) {
      throw new Error(`未知开关：${token}`)
    }
  }

  return { profile, patches, mode, showAllEvents }
}

// ============================================================
// 三、装载与渲染
// ============================================================

/** 一次装载之后要长期持有的引用。 */
interface Booted {
  readonly loaded: LoadedProfile
  readonly mode: ResolvedMode
  readonly agent: AgentService
  readonly session: Session
  readonly retry: RetryService | undefined
  readonly spec: LLMSpec | undefined
}

/** 把一条事件渲染成一行灰字。返回 `undefined` 表示这类事件不值得显示。 */
function renderEvent(event: SessionEvent): string | undefined {
  const data = event.data as Record<string, unknown>
  if (event.type === 'tool/call') return `  ⚙ ${String(data.name)}`
  if (event.type === 'tool/result') {
    const first = String(data.content).split('\n')[0]?.slice(0, 70) ?? ''
    return `  ${data.isError === true ? '✗' : '✓'} ${first}`
  }
  if (event.type === 'tool/guard') return `  🛡 守卫拦下（${String(data.byRule)}）`
  if (event.type === 'assistant/attempt') return `  ↻ 重试 ${String(data.attempt)}：${String(data.code)}`
  return undefined
}

/**
 * 装载 profile，并把事件流接到终端上。
 * @param args 参数
 * @param announce 是否打印欢迎信息（重装时不重复打印）
 * @returns 本次装载的结果
 * @throws profile 里没有 agent 服务时
 */
async function boot(args: ReplArgs, announce: boolean): Promise<Booted> {
  // 模式：解析 → 作为"装载前加工"的钩子交给装载器（与 CLI 走同一条路径）
  const mode = await resolveMode(args.mode)
  const loaded = await loadProfile(args.profile, args.patches, { transformRows: mode.transformRows })
  const ctx = loaded.ctx

  const agent = ctx.get<AgentService>('agent')
  if (agent === undefined) {
    throw new Error('这个 profile 里没有 agent 服务 —— 检查是否装载了 agent-loop 插件。')
  }

  const spec = ctx.get<LLMSpec>('llm/spec')

  if (announce) {
    console.log(paint.bold('\n  dsh-mini · 对话框'))
    console.log(paint.cyan(`  模式       ${mode.summary.id} · ${mode.summary.name}`))
    console.log(paint.gray(`  工具       ${(ctx.get<ToolRegistry>('tools')?.names() ?? []).join(', ')}`))
    console.log(paint.gray(`  profile    ${args.profile}`))
    console.log(paint.gray(`  模型       ${spec?.kind ?? '?'}（${spec?.model ?? '?'}）`))
    console.log(paint.gray(`  工作目录   ${ctx.get<string>('workspace') ?? '?'}`))
    if (spec?.kind === 'local') {
      console.log(paint.yellow('  ⚠ 离线规则模式：只认几条关键词，不是真模型。'))
      console.log(paint.yellow('    要真正的对话：设置 DEEPSEEK_API_KEY 后加 --profile profiles/chat-deepseek.json'))
    }
    console.log(paint.gray('\n  输入 /help 看命令，/exit 退出。\n'))
  }

  // 实时反馈：工具调用与守卫拦截直接打在终端上。
  // ★ 走的是第 4 步的事件机制，而不是在循环里插打印语句 ——
  //   所以这个文件对 agent 的内部逻辑一无所知。
  ctx.on('session/event', (payload, next) => {
    if (args.showAllEvents) {
      console.log(paint.gray(`  · ${payload.event.type}`))
    } else {
      const line = renderEvent(payload.event)
      if (line !== undefined) console.log(paint.gray(line))
    }
    return next()
  })

  return { loaded, mode, agent, session: agent.session, retry: ctx.get<RetryService>('retry'), spec }
}

/** 帮助文本。 */
const HELP = [
  paint.bold('  命令'),
  '    /help     显示这份帮助',
  '    /mode     看当前模式与可用模式；/mode <id> 直接切换',
  '    /new      开一个新会话（重新装载，清空对话上下文）',
  '    /stats    当前会话统计',
  '    /dump     打印最终生效的插件配置',
  '    /spec     打印生效的模型配置',
  '    /exit     退出（Ctrl+C 也行）',
  '',
  paint.bold('  五个模式（--mode <id> 启动，或 /mode <id> 切换）'),
  '    standard     常规：四个文件工具',
  '    ptc          含常规 + run_program（写程序批量调工具，中间结果不进上下文）',
  '    minimal      只有一个终端工具 run_command（对照组）',
  '    creator      写技能 / 写插件，改造系统本身',
  '    multi-agent  派发子智能体（各有独立会话与工具集）',
  '',
  paint.bold('  离线模式下能问什么'),
  '    看看这个目录里有什么',
  '    读一下 notes.txt',
  '    介绍这个项目',
  '    帮助',
].join('\n')

/**
 * 跑一个对话框会话。
 *
 * 输入用**事件 + 串行队列**处理，而不是 `await rl.question()` —— 原因见文件头。
 * @returns 进程退出码
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const interactive = stdin.isTTY === true
  let loadedRef: LoadedProfile | undefined

  try {
    let state = await boot(args, true)
    loadedRef = state.loaded

    // terminal: false 时 readline 不回显、不管光标 —— 这正是管道输入需要的
    const rl = createInterface({ input: stdin, output: stdout, terminal: interactive })
    const prompt = paint.cyan('你 › ')

    /** 处理一行输入。返回 `true` 表示要退出。 */
    const handle = async (raw: string): Promise<boolean> => {
      const line = raw.trim()
      if (line === '') return false

      if (line.startsWith('/')) {
        const [command] = line.slice(1).split(/\s+/)

        if (command === 'exit' || command === 'quit') return true

        if (command === 'help') {
          console.log(HELP)
          return false
        }

        if (command === 'new') {
          // 真正生效的做法：卸载再重新装载。
          // 为什么不"换个 Session 对象"？因为 agent 服务在装载时就绑定了会话 ——
          // 重装是唯一不破坏"服务在装载期确定"这条规则的做法。
          state.loaded.unloadAll()
          state = await boot(args, false)
          loadedRef = state.loaded
          console.log(paint.gray(`\n  已开新会话（${state.session.id}），对话上下文已清空。\n`))
          return false
        }

        if (command === 'mode') {
          const target = line.slice(1).split(/\s+/)[1]

          if (target === undefined) {
            const available = await listModes()
            console.log(paint.bold(`\n  当前模式：${state.mode.summary.id} · ${state.mode.summary.name}`))
            console.log(paint.gray(`  ${state.mode.summary.description}`))
            console.log(paint.gray(`  工具：${state.mode.summary.tools.join(', ')}`))
            console.log(paint.bold('\n  可用模式'))
            for (const item of available) {
              const mark = item.id === state.mode.summary.id ? paint.green('  ← 当前') : ''
              console.log(`    ${item.id.padEnd(14)} ${item.name}${mark}`)
            }
            console.log(paint.gray('\n  切换：/mode <id>\n'))
            return false
          }

          // ★ 切换模式 = 改参数 + 重装。
          //   不给"运行时热换装配"留后门：服务与工具都在装载期确定（第 3 步的取舍），
          //   所以换模式就该老老实实走一遍装载 —— 那条路径有回滚、有依赖校验、有 dump。
          args.mode = target
          state.loaded.unloadAll()
          state = await boot(args, false)
          loadedRef = state.loaded
          console.log(paint.green(`\n  已切到模式 ${state.mode.summary.id}（${state.mode.summary.name}）`))
          console.log(paint.gray(`  工具现在是：${state.mode.summary.tools.join(', ')}\n`))
          return false
        }

        if (command === 'stats') {
          const stats = state.session.stats()
          console.log(paint.gray(`  轮次=${stats.turns} 步数=${stats.steps} 工具=${stats.toolCalls}（失败 ${stats.toolErrors}）`))
          console.log(paint.gray(`  消息=${stats.messages} 重试=${stats.attempts} 守卫拒绝=${stats.guardDenials} 问人=${stats.guardAsks}`))
          if (state.retry !== undefined) {
            const rs = state.retry.stats()
            console.log(paint.gray(`  重试裁决：重试 ${rs.retries} 次，按错误码 ${JSON.stringify(rs.byCode)}`))
          }
          return false
        }

        if (command === 'dump') {
          console.log()
          state.loaded.dump()
          return false
        }

        if (command === 'spec') {
          console.log()
          console.log(JSON.stringify(state.spec, null, 2))
          return false
        }

        console.log(paint.red(`  未知命令：/${command}（输入 /help）`))
        return false
      }

      // ── 普通输入 = 一次任务 ──
      const started = Date.now()
      try {
        const result = await state.agent.runTask(line)
        const elapsed = Date.now() - started

        console.log()
        if (result.text !== '') {
          console.log(`${paint.green('助手 ›')} ${result.text}`)
        } else {
          console.log(paint.yellow(`助手 › （没有文本输出；状态 ${result.status}）`))
        }
        console.log(paint.gray(`  ${result.status} · ${result.steps} 步 · ${elapsed} ms\n`))
      } catch (error) {
        console.log()
        console.log(paint.red(`  任务失败：${error instanceof Error ? error.message : String(error)}\n`))
      }
      return false
    }

    if (interactive) {
      rl.setPrompt(prompt)
      rl.prompt()
    }

    // ★ 串行队列：readline 会把多行一次性吐出来，而 runTask 是异步的。
    //   不排队的话两行输入会并发跑两个任务，日志会交错。
    let chain: Promise<void> = Promise.resolve()
    let shouldExit = false

    const finished = new Promise<void>((resolveFinished) => {
      rl.on('line', (raw) => {
        chain = chain.then(async () => {
          if (shouldExit) return
          shouldExit = await handle(raw)
          if (shouldExit) {
            rl.close()
            return
          }
          if (interactive) rl.prompt()
        })
      })

      rl.on('close', () => {
        resolveFinished()
      })

      if (interactive) {
        rl.on('SIGINT', () => {
          shouldExit = true
          rl.close()
        })
      }
    })

    await finished
    await chain // 等最后一行处理完，否则输出会被截断

    console.log(paint.gray('\n  再见。\n'))
    return 0
  } catch (error) {
    console.error(`\n启动失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    loadedRef?.unloadAll()
  }
}

process.exitCode = await main()
