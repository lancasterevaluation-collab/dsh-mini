/**
 * PTC 子进程侧 SDK —— 让"模型写的程序"能把宿主工具当普通函数调用
 *
 * 这个文件**跑在全新 Node 进程里**（不是主进程）。它做三件事：
 *
 *   1. 把宿主提供的工具名包装成 `tools.read_file({...})` 这样的 async 函数
 *   2. 把这些调用通过**带前缀的 stderr 行**发给父进程，等父进程回结果
 *   3. 执行模型写的程序，收集它打印的东西与返回值
 *
 * ── ★ 为什么协议走 stderr，而不是 stdout ★ ─────────────────────────────
 *
 * 因为 stdout 要留给**程序自己的输出** —— 那正是 PTC 的返回值之一。
 * 如果协议和程序输出混在一条管道里，就必须靠转义或分帧去区分，
 * 而模型写的 `console.log('{...}')` 刚好长得像协议消息时就会出错（很难查）。
 *
 * 分开之后：stdout = 程序说的话，stderr = 协议 + 报错。父进程只在 stderr 上
 * 找带 `@@PTC@@` 前缀的行，其余一律当作子进程的杂音（原样收进日志）。
 *
 * ── 为什么每个调用都带自增 id ★ ───────────────────────────────────────
 *
 * 因为程序里可以 `Promise.all` 并发调工具。没有 id 就无法把响应配回请求，
 * 而并发是 PTC 存在的理由之一（"批量调工具再汇总"）。
 *
 * ── 这个文件为什么是 .mjs 而不是 .ts ★ ────────────────────────────────
 *
 * 因为它是**被当成普通脚本直接跑**的：父进程用 `node bootstrap.mjs program.mjs`
 * 启动它。子进程没有主进程那套 TypeScript 类型擦除的加载上下文，
 * 用纯 ESM 能少一层"为什么这个能在子进程跑、那个不能"的困惑。
 */

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** 协议前缀 —— 只有带它的 stderr 行才是给父进程看的。 */
const PROTOCOL_PREFIX = '@@PTC@@'

/** 工具名清单（父进程通过环境变量传进来）。 */
const toolNames = JSON.parse(process.env.PTC_TOOLS ?? '[]')

/** 待响应的调用：id → { resolve, reject }。 */
const pending = new Map()
let nextCallId = 1

/** 把一条协议消息写给父进程。 */
function send(message) {
  process.stderr.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`)
}

// ============================================================
// 一、接收父进程的响应
// ============================================================
let inputBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk
  const lines = inputBuffer.split('\n')
  inputBuffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      continue // 不是协议消息就忽略（父进程不会发别的，但别因此崩掉）
    }
    const waiter = pending.get(message.id)
    if (waiter === undefined) continue
    pending.delete(message.id)
    if (message.ok !== true) {
      waiter.reject(new Error(String(message.error ?? '工具调用失败')))
    } else if (message.isError === true) {
      // ★ 工具执行失败（参数错、路径不存在、被拒绝…）在 agent 循环里是**结果**而不是异常，
      //   但程序里用异常更符合直觉。所以在这里转成 reject —— 程序可以 try/catch，
      //   也可以不管它，让整个程序失败（两种情况父进程都看得到原因）。
      waiter.reject(new Error(String(message.value ?? '工具返回了失败结果')))
    } else {
      waiter.resolve(message.value)
    }
  }
})

// 父进程关掉 stdin = 别再调工具了（通常是超时或主进程退出）
process.stdin.on('end', () => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error('父进程已断开连接'))
  }
  pending.clear()
})

// ============================================================
// 二、给程序用的 tools 代理
// ============================================================

/**
 * 发起一次工具调用。
 * @param {string} name 工具名
 * @param {Record<string, unknown>} args 参数
 * @returns {Promise<unknown>} 工具返回的文本
 */
function callTool(name, args) {
  if (!toolNames.includes(name)) {
    // 未知工具当场拒绝：比让父进程回一个 500 更早、更好定位
    return Promise.reject(new Error(`没有这个工具：${name}；可用：${toolNames.join(', ')}`))
  }
  const id = nextCallId
  nextCallId += 1
  send({ type: 'call', id, name, args: args ?? {} })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
}

/** `tools.xxx({...})` 形式访问。 */
const tools = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    return (args) => callTool(name, args)
  },
})

// ============================================================
// 三、执行模型写的程序
// ============================================================

/** 捕获程序打印的内容（stdout 交给程序，它 print 到哪儿我们就收哪儿）。 */
const printed = []
const capture = (...parts) => {
  printed.push(parts.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' '))
}

/** 序列化任意值，循环引用也不炸。 */
function safeStringify(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[循环引用]'
        seen.add(item)
      }
      return item
    }) ?? String(value)
  } catch {
    return String(value)
  }
}

// 把 console 换成"既打印又收集"，这样父进程能拿到程序说了什么
const originalLog = console.log.bind(console)
console.log = (...parts) => {
  capture(...parts)
  originalLog(...parts)
}
console.log.error = originalLog

/** 把 tools 注入全局，程序顶层可以直接 `await tools.list_dir({...})`。 */
globalThis.tools = tools
globalThis.print = capture

const programPath = process.argv[2]
if (programPath === undefined) {
  send({ type: 'fatal', error: '没有给出程序文件路径' })
  process.exit(2)
}

try {
  const source = await readFile(programPath, 'utf8')
  // 用 import() 执行：程序是 ESM，支持顶层 await（PTC 的程序几乎一定要 await 工具）
  await import(pathToFileURL(programPath).href)

  send({
    type: 'done',
    ok: true,
    // 返回值：程序里 `globalThis.result = ...` 可选地给一个
    result: globalThis.result === undefined ? null : globalThis.result,
    printed: printed.join('\n'),
    lines: printed.length,
    sourceBytes: Buffer.byteLength(source, 'utf8'),
  })
  process.exit(0)
} catch (error) {
  send({
    type: 'done',
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 6).join('\n') : '',
    printed: printed.join('\n'),
  })
  process.exit(1)
}
