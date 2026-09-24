/**
 * `run_command`：在工作目录里执行一条 shell 命令
 *
 * 这是 **Minimal 模式**的全部家当 —— 对照 DSH 的 Minimal preset
 *（"agent 只用一个终端工具工作，便于测试与对比基础能力"）。
 *
 * ── 为什么"只有一个终端工具"值得单独做一个模式 ────────────────────────
 *
 * 因为它是**最强的对照组**。同一个模型，一次用四个结构化的文件工具、
 * 一次只给它一个 shell，两次的完成率、步数、token 差异就是
 * "结构化工具到底值不值"的答案。没有这个模式，这个问题只能靠感觉回答。
 *
 * ── ★ 它不是沙箱，连"隔离"的边都摸不到 ★ ──────────────────────────
 *
 * 现在的约束只有三条：
 *
 *   1. `cwd` 固定在工作目录 —— 挡不住 `cd ..` 或绝对路径
 *   2. 超时到点 kill 进程树 —— 挡不住"命令很快但副作用已经发生"
 *   3. 输出截断 —— 只是不让它把上下文撑爆
 *
 * 它跑在宿主的 shell 上，权限就是当前用户的权限。
 * 真正的隔离要靠 OS 手段（bwrap / Landlock / 容器 / 低权限账户），本项目不做。
 * **所以 Minimal 模式只应该在你信任模型的场景下开** —— 这一条写在提示词里，
 * 也写在 `run_command` 的工具描述里，让模型自己也别乱来。
 *
 * ── 退出码的处理是刻意的 ★ ──────────────────────────────────────────
 *
 * 非零退出码 → `isError: true`，但**输出照常返回**。
 * 因为"命令失败了但打印了原因"（编译错误、权限不足）是最常见的情形，
 * 模型需要那段原因才能自己修；把它当成纯失败丢掉，模型只会反复重试同一条命令。
 */

import { spawn } from 'node:child_process'
import { fail, ok, truncate } from './tools.ts'
import type { Tool, ToolResult } from './tools.ts'

/** 默认超时：20 秒。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000

/** 默认输出上限（字符）。 */
export const DEFAULT_COMMAND_MAX_OUTPUT = 8_000

/** 平台对应的 shell 与参数。 */
function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // 用 cmd /d /s /c：/d 跳过 AutoRun，/s 保证引号原样传给命令
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

/**
 * 执行一条命令。
 * @param command 要执行的命令
 * @param options 工作目录、超时、输出上限、取消信号
 * @returns 结果（**超时与失败都返回结果，不抛**）
 */
export async function runCommand(
  command: string,
  options: {
    readonly workspace: string
    readonly timeoutMs?: number
    readonly maxOutputChars?: number
    readonly signal?: AbortSignal
  },
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxOutput = options.maxOutputChars ?? DEFAULT_COMMAND_MAX_OUTPUT
  const { file, args } = shellFor(command)

  if (options.signal?.aborted === true) return fail('命令未执行：任务已被取消。')

  return await new Promise<ToolResult>((resolveResult) => {
    const started = Date.now()
    const child = spawn(file, args, {
      cwd: options.workspace,
      // 保留宿主环境变量：很多命令（node、git、pnpm）离开 PATH 就跑不起来
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上单独 kill 一个 shell 往往留下子进程，所以按进程组处理
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      const body = [
        `$ ${command}`,
        stdout.trim() === '' ? '' : stdout.trimEnd(),
        stderr.trim() === '' ? '' : `[stderr]\n${stderr.trimEnd()}`,
        timedOut ? `[超时] 超过 ${timeoutMs} ms 被终止` : '',
      ].filter((part) => part !== '').join('\n')

      const elapsed = Date.now() - started
      const text = `${truncate(body, maxOutput)}\n[退出码 ${String(child.exitCode ?? -1)}，耗时 ${elapsed} ms]`

      resolveResult(
        timedOut || (child.exitCode ?? 1) !== 0
          ? fail(text)
          : ok(text),
      )
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // 少数平台 kill 不生效（比如 Windows 上进程组残留）：到点仍强制结算
      setTimeout(finish, 250)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      // 边跑边截断：一条 `yes` 能在超时前把内存吃光
      if (stdout.length > maxOutput * 4) stdout = stdout.slice(0, maxOutput * 4)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > maxOutput * 4) stderr = stderr.slice(0, maxOutput * 4)
    })

    child.on('error', (error) => {
      stdout = `${stdout}\n[无法启动] ${error.message}`
      finish()
    })
    child.on('exit', () => {
      finish()
    })
  })
}

/** `run_command` 工具。 */
export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '在工作目录里执行一条 shell 命令，返回输出与退出码。' +
    '注意：它没有沙箱保护 —— 会以当前用户的权限运行，工作目录只是起点不是边界。' +
    '优先用专门的文件工具；只有在确实需要跑命令（构建、测试、查看进程）时才用它。',
  sideEffect: 'reversible',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令，例如 "node --version"' },
      timeoutMs: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_COMMAND_TIMEOUT_MS}` },
    },
    required: ['command'],
  },
  async handler(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? '').trim()
    if (command === '') return fail('command 不能为空。')
    return await runCommand(command, {
      workspace: ctx.workspace,
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
    })
  },
}
