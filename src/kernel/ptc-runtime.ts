/**
 * PTC 运行时：让模型写**一段程序**，而不是发一串工具调用
 *
 * 常规模式下，模型和工具之间的交互是"一问一答"：
 *
 *     模型 → 调 list_dir →（结果进上下文）→ 模型 → 调 read_file →（结果进上下文）→ …
 *
 * 当任务变成"把 200 个文件都读一遍，统计出现最多的词"，这条路径有一个致命问题：
 * **每一个中间结果都要进上下文**。上下文被塞满，而模型真正需要的只是一条统计结论。
 *
 * PTC（对照 DSH 的 `ptc-runtime/`）换一种形状：
 *
 *     模型写一个程序 → 程序在**新进程**里跑 → 程序把工具当普通函数调用
 *     → 只有程序的**打印输出和返回值**回到上下文
 *
 * 也就是说：**中间结果留在程序里，不进上下文**。这就是"批量调工具再筛选、去重、
 * 统计、汇总"这类任务在 PTC 下更省更准的原因。
 *
 * ── 三条与 DSH 对齐的语义 ★ ───────────────────────────────────────────
 *
 * 1. **每次运行都是全新进程**：程序之间不共享状态，也不受上一次影响
 * 2. **只返回打印输出与返回值**：程序内部调了多少次工具，上下文里只看到结论
 * 3. **失败是结果，不是异常**：程序崩了就返回 `ok: false` 与错误信息，
 *    让模型自己看到并改（而不是把整个 agent 循环带崩）
 *
 * ── ★ 它不是安全沙箱 ★ ──────────────────────────────────────────────
 *
 * 这个文件**不提供**安全边界：程序跑在宿主 node 上，能读能写能联网。
 * 现在的约束只有三条（都是"限流"而不是"隔离"）：
 *
 *   - 工具调用次数上限（`maxToolCalls`）
 *   - 总时限（`timeoutMs`，到点 kill）
 *   - 输出长度上限（复用 `tools.ts` 的截断）
 *
 * 真正的隔离要靠 OS 级手段（bwrap / Landlock / 容器），本项目不做 ——
 * DSH 那边也是把"执行策略"交给沙箱插件，而不是写在运行时里。
 * **所以 PTC 模式只应该在你信任模型的场景下开。**
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { truncate } from './tools.ts'
import type { ToolContext, ToolRegistry } from './tools.ts'

/** 协议前缀（与 `ptc-bootstrap.mjs` 必须一致）。 */
const PROTOCOL_PREFIX = '@@PTC@@'

/** 程序文件放在工作目录的哪个子目录下。 */
export const PTC_DIR_NAME = '.ptc'

/** 默认时限：60 秒。 */
export const DEFAULT_PTC_TIMEOUT_MS = 60_000

/** 默认工具调用上限。 */
export const DEFAULT_PTC_MAX_CALLS = 50

/** 默认输出上限（字符）。 */
export const DEFAULT_PTC_MAX_OUTPUT_CHARS = 12_000

/** 一次 PTC 运行的结果。 */
export interface PtcResult {
  /** 程序是否正常跑完。 */
  readonly ok: boolean
  /** 程序 `console.log` 打印的内容。 */
  readonly output: string
  /** 程序写在 `globalThis.result` 上的返回值（没写就是 `null`）。 */
  readonly result: unknown
  /** 程序实际调了多少次工具 —— 用来对比"省下了多少上下文"。 */
  readonly toolCalls: number
  /** 程序有多少行打印。 */
  readonly printedLines: number
  /** 耗时（毫秒）。 */
  readonly durationMs: number
  /** 失败原因（`ok: true` 时为空串）。 */
  readonly error: string
  /** 输出是否被截断。 */
  readonly truncated: boolean
  /** 程序文件路径（留着便于排查"模型到底写了什么"）。 */
  readonly programPath: string
}

/** 运行参数。 */
export interface PtcRunOptions {
  /** 模型写的程序源码。 */
  readonly program: string
  /** 程序可以调用的工具注册表。 */
  readonly tools: ToolRegistry
  /** 工作目录（同时是程序的 cwd）。 */
  readonly workspace: string
  /** 总时限。 */
  readonly timeoutMs?: number
  /** 工具调用次数上限。 */
  readonly maxToolCalls?: number
  /** 输出长度上限。 */
  readonly maxOutputChars?: number
  /** 每次工具调用后的回调（用于把过程写进会话日志）。 */
  readonly onToolCall?: (name: string, args: Record<string, unknown>, isError: boolean) => void
}

/** bootstrap 的绝对路径。 */
const BOOTSTRAP_PATH = fileURLToPath(new URL('./ptc-bootstrap.mjs', import.meta.url))

/**
 * 在新进程里跑一段程序。
 *
 * @param options 运行参数
 * @returns 运行结果（**失败也返回结果，不抛**）
 */
export async function runProgram(options: PtcRunOptions): Promise<PtcResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_PTC_TIMEOUT_MS
  const maxCalls = options.maxToolCalls ?? DEFAULT_PTC_MAX_CALLS
  const maxOutput = options.maxOutputChars ?? DEFAULT_PTC_MAX_OUTPUT_CHARS

  // 程序写进工作目录：一是 cwd 好控制，二是"模型写了什么"事后可查
  const dir = join(resolve(options.workspace), PTC_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const programPath = join(dir, `program-${started}.mjs`)
  await writeFile(programPath, options.program, 'utf8')

  const toolNames = options.tools.names()
  const toolContext: ToolContext = { workspace: resolve(options.workspace) }

  return await new Promise<PtcResult>((resolveResult) => {
    const child = spawn(process.execPath, [BOOTSTRAP_PATH, programPath], {
      cwd: resolve(options.workspace),
      env: { ...process.env, PTC_TOOLS: JSON.stringify(toolNames) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderrTail = ''
    let protocolBuffer = ''
    let toolCalls = 0
    let finished = false
    let reported: { ok: boolean; result: unknown; printed: string; lines: number; error: string } | undefined
    let budgetExceeded = false

    /** 收尾：保证只结算一次。 */
    const settle = (error: string): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)

      const rawOutput = reported?.printed !== undefined && reported.printed !== ''
        ? reported.printed
        : stdout
      const output = truncate(rawOutput.trim(), maxOutput)

      resolveResult({
        ok: reported?.ok === true && error === '',
        output,
        result: reported?.result ?? null,
        toolCalls,
        printedLines: reported?.lines ?? output.split('\n').filter((line) => line !== '').length,
        durationMs: Date.now() - started,
        error: reported?.ok === false ? (reported.error ?? '程序执行失败') : error,
        truncated: output.length < rawOutput.trim().length,
        programPath,
      })
    }

    const timer = setTimeout(() => {
      // 超时：先杀进程，再按"失败"结算 —— 明确写出原因，别让它看起来像程序自己崩了
      budgetExceeded = true
      child.kill('SIGKILL')
      settle(`程序超过时限 ${timeoutMs} ms 被终止`)
    }, timeoutMs)

    /** 处理一次工具调用请求。 */
    const handleCall = async (id: number, name: string, args: Record<string, unknown>): Promise<void> => {
      toolCalls += 1
      if (toolCalls > maxCalls) {
        options.onToolCall?.(name, args, true)
        child.stdin.write(`${JSON.stringify({ id, ok: false, error: `工具调用次数超过上限 ${maxCalls}` })}\n`)
        return
      }

      try {
        const result = await options.tools.execute(name, args, toolContext)
        options.onToolCall?.(name, args, result.isError)
        // isError 一并回传：让子进程能把"工具失败了"转成 promise reject（见 bootstrap）
        child.stdin.write(`${JSON.stringify({ id, ok: true, value: result.content, isError: result.isError })}\n`)
      } catch (error) {
        options.onToolCall?.(name, args, true)
        child.stdin.write(
          `${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
        )
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      protocolBuffer += chunk.toString()
      const lines = protocolBuffer.split('\n')
      protocolBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith(PROTOCOL_PREFIX)) {
          stderrTail = `${stderrTail}${line}\n`.slice(-2000)
          continue
        }
        let message: { type?: string; id?: number; name?: string; args?: Record<string, unknown>; ok?: boolean; result?: unknown; printed?: string; lines?: number; error?: string }
        try {
          message = JSON.parse(line.slice(PROTOCOL_PREFIX.length))
        } catch {
          continue
        }

        if (message.type === 'call') {
          void handleCall(message.id ?? 0, message.name ?? '', message.args ?? {})
        } else if (message.type === 'done') {
          reported = {
            ok: message.ok === true,
            result: message.result ?? null,
            printed: message.printed ?? '',
            lines: message.lines ?? 0,
            error: message.error ?? '',
          }
        } else if (message.type === 'fatal') {
          settle(message.error ?? '子进程启动失败')
        }
      }
    })

    child.on('error', (error) => {
      settle(`无法启动子进程：${error.message}`)
    })

    child.on('exit', (code) => {
      // 子进程退出时，把没结算的收掉（正常路径下 reported 已经有了）
      if (budgetExceeded) return
      if (reported === undefined) {
        const hint = stderrTail.trim() === '' ? '' : `\n子进程 stderr：${stderrTail.trim().split('\n').slice(-3).join('\n')}`
        settle(`子进程退出码 ${String(code)}，但没有返回结果${hint}`)
        return
      }
      settle('')
    })
  })
}
