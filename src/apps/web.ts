/**
 * Web GUI：在浏览器里跟 agent 对话
 *
 * 终端对话框（`repl.ts`）能干活，但终端里的"美观"上限就是颜色加缩进。
 * 这个文件把它搬进浏览器 —— 仍然是**零依赖**：`node:http` 提供服务，
 * 前端是一个自包含的 HTML 文件，通过 **SSE** 接收实时事件。
 *
 * ── 为什么是"服务端 + 浏览器"而不是 Electron ──────────────────────────
 *
 * Electron 要 `npm install` 几百兆的东西，而本机 npm 不可用 —— 那不是取舍，那是不可行。
 * 而 `node:http` 是内置的，浏览器是现成的：这套组合的代价是"得开个浏览器、得占一个端口"，
 * 换来的是**真正的图形界面**：CSS 能做终端做不到的事（渐变、圆角、动效、折叠卡片、自适应布局）。
 *
 * ── ★ 前端为什么是一个独立的 .html 文件，而不是塞进 TypeScript 字符串 ★ ──
 *
 * 因为那样它既没有语法高亮、也没法 diff —— 改一个 CSS 值要在字符串里数转义符。
 * 这和 `skills/` 用 `.md` 文件而不是把技能写进 JSON 是同一个理由：
 * **给人编辑的东西要用能编辑的格式。**
 *
 * ── 数据怎么流 ★ ────────────────────────────────────────────────────
 *
 *     浏览器 ──POST /api/ask──► 服务端 ──► agent.runTask(text)
 *        ▲                                        │
 *        └────── SSE /api/events ◄── session/event ┘
 *
 * 关键点是右边那条：服务端**没有为界面写任何专门的事件**，
 * 它转发的是 `plugins/session.ts` 早就在发的 `session/event`。
 * 也就是说界面是"会话日志的一个视图"—— 这正是第 7 步
 * 「Model-visible ⟺ logged」的延伸：**界面看到的也只能是日志里有的东西**。
 *
 * 运行：
 *     node src/apps/web.ts
 *     node src/apps/web.ts --port 9000 --open
 *     node src/apps/web.ts --profile profiles/chat-deepseek.json
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { loadProfile } from '../framework/loader.ts'
import type { LoadedProfile } from '../framework/loader.ts'
import type { AgentService } from '../plugins/agent-loop.ts'
import type { LLMSpec } from '../plugins/llm.ts'
import type { SessionEvent } from '../kernel/session.ts'

/** 本文件所在目录 —— 默认 profile 与前端相对它。 */
const HERE = import.meta.dirname

/** 默认端口。选一个不常被占用的高位端口。 */
export const DEFAULT_PORT = 8787

// ============================================================
// 一、参数
// ============================================================

/** 解析结果。 */
interface WebArgs {
  readonly profile: string
  readonly patches: readonly string[]
  readonly port: number
  readonly open: boolean
}

/**
 * 解析参数。
 * @param argv `process.argv.slice(2)`
 * @returns 解析结果
 * @throws 端口非法、未知开关时
 */
function parseArgs(argv: readonly string[]): WebArgs {
  let profile = resolve(HERE, '../../profiles/chat.json')
  let port = DEFAULT_PORT
  let open = false
  const patches: string[] = []

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
    } else if (token === '--port') {
      index += 1
      const value = Number(argv[index])
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error('--port 必须是 1–65535 的整数')
      }
      port = value
    } else if (token === '--open') {
      open = true
    } else if (token.startsWith('--')) {
      throw new Error(`未知开关：${token}`)
    }
  }

  return { profile, patches, port, open }
}

// ============================================================
// 二、发给浏览器的消息
// ============================================================

/** 一条推给前端的消息。前端按 `type` 分发。 */
type ClientMessage =
  | { readonly type: 'hello'; readonly state: ServerState }
  | { readonly type: 'user'; readonly text: string }
  | { readonly type: 'assistant'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string; readonly summary: string; readonly isError: boolean }
  | { readonly type: 'guard'; readonly rule: string; readonly detail: string; readonly verdict: string }
  | { readonly type: 'retry'; readonly attempt: number; readonly code: string; readonly message: string }
  | { readonly type: 'running'; readonly text: string }
  | { readonly type: 'task-end'; readonly status: string; readonly steps: number; readonly ms: number; readonly text: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'state'; readonly state: ServerState }

/** 前端启动时要的一份状态快照。 */
interface ServerState {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly workspace: string
  readonly running: boolean
  readonly turns: number
  readonly steps: number
  readonly messages: number
  readonly toolCalls: number
  readonly toolErrors: number
  readonly guardDenials: number
  readonly guardAsks: number
  readonly attempts: number
}

// ============================================================
// 三、把会话事件翻译成界面消息
// ============================================================

/**
 * 一条会话事件要不要展示给界面？翻译成什么？
 *
 * ★ 为什么只挑这几类？★ 因为界面不是日志查看器 —— 把 20 种过程事件全画出来，
 * 用户只会在噪声里找不到"助手回答了什么"。完整日志仍然在 `.sessions/*.jsonl` 里。
 * @param event 会话事件
 * @returns 要推给前端的消息；`undefined` 表示这条不上界面
 */
function translate(event: SessionEvent): ClientMessage | undefined {
  const data = event.data as Record<string, unknown>

  if (event.type === 'assistant/message') {
    const content = String(data.content ?? '')
    if (content.trim() === '') return undefined // 只要求调工具的那一轮没有文本
    return { type: 'assistant', text: content }
  }

  if (event.type === 'tool/result') {
    const content = String(data.content ?? '')
    const firstLine = content.split('\n')[0] ?? ''
    return {
      type: 'tool',
      name: String(data.name ?? '?'),
      // 摘要只取第一行：完整输出可能几千字，而界面上它应该是一张可点开的卡片
      summary: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine,
      isError: data.isError === true,
    }
  }

  if (event.type === 'tool/guard') {
    return {
      type: 'guard',
      rule: String(data.byRule ?? '?'),
      detail: String(data.detail ?? '').split('\n')[0] ?? '',
      verdict: String(data.verdict ?? '?'),
    }
  }

  if (event.type === 'assistant/attempt') {
    return {
      type: 'retry',
      attempt: Number(data.attempt ?? 0),
      code: String(data.code ?? '?'),
      message: String(data.message ?? ''),
    }
  }

  // turn/start、step/end、tool/call 这些是过程事件 —— 不进界面
  return undefined
}

// ============================================================
// 四、服务
// ============================================================

/** 服务端持有的运行状态。 */
class WebServer {
  readonly #args: WebArgs
  #loaded: LoadedProfile
  #spec: LLMSpec | undefined
  readonly #clients = new Set<ServerResponse>()
  #running = false
  #html = ''

  /**
   * @param args 参数
   * @param loaded 已装载的 profile
   */
  constructor(args: WebArgs, loaded: LoadedProfile) {
    this.#args = args
    this.#loaded = loaded
    this.#spec = loaded.ctx.get<LLMSpec>('llm/spec')
  }

  /** agent 服务（每次重装后会变）。 */
  get #agent(): AgentService | undefined {
    return this.#loaded.ctx.get<AgentService>('agent')
  }

  /** 当前状态快照。 */
  #state(): ServerState {
    const agent = this.#agent
    const stats = agent?.stats()
    return {
      sessionId: agent?.session.id ?? '(none)',
      provider: this.#spec?.kind ?? '?',
      model: this.#spec?.model ?? '?',
      workspace: this.#loaded.ctx.get<string>('workspace') ?? '?',
      running: this.#running,
      turns: stats?.turns ?? 0,
      steps: stats?.steps ?? 0,
      messages: stats?.messages ?? 0,
      toolCalls: stats?.toolCalls ?? 0,
      toolErrors: stats?.toolErrors ?? 0,
      guardDenials: stats?.guardDenials ?? 0,
      guardAsks: stats?.guardAsks ?? 0,
      attempts: stats?.attempts ?? 0,
    }
  }

  /** 广播一条消息给所有已连接的浏览器。 */
  #broadcast(message: ClientMessage): void {
    const payload = `data: ${JSON.stringify(message)}\n\n`
    for (const client of this.#clients) {
      try {
        client.write(payload)
      } catch {
        // 客户端半路断开是常态，静默移除即可（下一次写还会失败并再次清理）
        this.#clients.delete(client)
      }
    }
  }

  /** 把会话事件接到广播上。**重装后必须重新挂**，否则界面会静默不再更新。 */
  #wireEvents(): void {
    this.#loaded.ctx.on('session/event', (payload, next) => {
      const message = translate(payload.event)
      if (message !== undefined) this.#broadcast(message)
      return next()
    })
  }

  /** 装载前端 HTML（只在启动时读一次）。 */
  async loadHtml(): Promise<void> {
    this.#html = await readFile(resolve(HERE, 'web-ui.html'), 'utf8')
    this.#wireEvents()
  }

  /** 处理一个 HTTP 请求。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.#args.port}`)

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(this.#html)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      this.#clients.add(res)
      res.write(`data: ${JSON.stringify({ type: 'hello', state: this.#state() } satisfies ClientMessage)}\n\n`)

      req.on('close', () => {
        this.#clients.delete(res)
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      this.#json(res, 200, this.#state())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      await this.#handleAsk(req, res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      this.#loaded.unloadAll()
      this.#loaded = await loadProfile(this.#args.profile, this.#args.patches)
      this.#spec = this.#loaded.ctx.get<LLMSpec>('llm/spec')
      this.#wireEvents()
      this.#json(res, 200, this.#state())
      this.#broadcast({ type: 'state', state: this.#state() })
      return
    }

    this.#json(res, 404, { error: 'not found' })
  }

  /** 处理一次提问。 */
  async #handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ★ 正在跑就拒绝：并发跑两个任务会让日志与界面交错，而这是个**串行**的 agent
    if (this.#running) {
      this.#json(res, 409, { error: '上一个任务还在跑，等它结束或刷新页面' })
      return
    }

    const body = await readBody(req)
    let text = ''
    try {
      text = String((JSON.parse(body) as { text?: unknown }).text ?? '').trim()
    } catch {
      this.#json(res, 400, { error: '请求体不是合法 JSON' })
      return
    }

    if (text === '') {
      this.#json(res, 400, { error: 'text 不能为空' })
      return
    }

    const agent = this.#agent
    if (agent === undefined) {
      this.#json(res, 500, { error: 'profile 里没有 agent 服务' })
      return
    }

    // 立刻回 202：真正的结果通过 SSE 推。界面不需要等这个请求
    this.#json(res, 202, { ok: true })

    this.#running = true
    this.#broadcast({ type: 'user', text })
    this.#broadcast({ type: 'running', text })
    const started = Date.now()

    try {
      const result = await agent.runTask(text)
      this.#broadcast({
        type: 'task-end',
        status: result.status,
        steps: result.steps,
        ms: Date.now() - started,
        text: result.text,
      })
    } catch (error) {
      this.#broadcast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.#running = false
      this.#broadcast({ type: 'state', state: this.#state() })
    }
  }

  /** 回一个 JSON 响应。 */
  #json(res: ServerResponse, code: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }
}

/** 读完请求体（上限 1 MB，防止一个坏请求把内存吃掉）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', rejectBody)
  })
}

/** 在默认浏览器里打开一个 URL。 */
function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // 打不开浏览器不是错误：URL 已经打在终端上了
  }
}

/**
 * 启动服务。
 * @returns 进程退出码
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  let loaded: LoadedProfile | undefined

  try {
    loaded = await loadProfile(args.profile, args.patches)
    const server = new WebServer(args, loaded)
    await server.loadHtml()

    const http = createServer((req, res) => {
      void server.handle(req, res).catch((error: unknown) => {
        // 单个请求出错不该让服务挂掉 —— 回 500 并继续
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        } catch {
          // 响应已经发出去一半了就没办法了，忽略
        }
      })
    })

    await new Promise<void>((resolveListen, rejectListen) => {
      http.once('error', (error: NodeJS.ErrnoException) => {
        rejectListen(
          error.code === 'EADDRINUSE'
            ? new Error(`端口 ${args.port} 已被占用；换一个：--port 8788`)
            : error,
        )
      })
      http.listen(args.port, '127.0.0.1', () => {
        resolveListen()
      })
    })

    const url = `http://127.0.0.1:${args.port}`
    const spec = loaded.ctx.get<LLMSpec>('llm/spec')
    console.log('\n  dsh-mini · Web GUI')
    console.log(`  地址       ${url}`)
    console.log(`  profile    ${args.profile}`)
    console.log(`  模型       ${spec?.kind ?? '?'}（${spec?.model ?? '?'}）`)
    console.log(`  工作目录   ${loaded.ctx.get<string>('workspace') ?? '?'}`)
    if (spec?.kind === 'local') {
      console.log('  ⚠ 离线规则模式：只认几条关键词，不是真模型。')
      console.log('    要真正的对话：设置 DEEPSEEK_API_KEY 后加 --profile profiles/chat-deepseek.json')
    }
    console.log('\n  Ctrl+C 停止\n')

    if (args.open) openBrowser(url)

    // 等到 Ctrl+C：把插件卸载干净再退出
    await new Promise<void>((resolveStop) => {
      process.on('SIGINT', () => {
        console.log('\n  正在停止…')
        http.close(() => resolveStop())
      })
    })

    return 0
  } catch (error) {
    console.error(`\n启动失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    loaded?.unloadAll()
  }
}

process.exitCode = await main()
