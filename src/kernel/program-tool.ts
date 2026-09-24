/**
 * `run_program`：PTC 模式的核心工具
 *
 * 它把 `ptc-runtime.ts` 包成一个工具 —— 模型"写程序"的入口。
 *
 * ── 为什么是工厂函数，而不是一个常量 Tool ★ ────────────────────────────
 *
 * 因为程序里要调用的那些工具**必须由外部注入**：`run_program` 自己不该
 * 知道有哪些工具，也不该去 import 工具注册表（那样它就跟装载顺序绑死了）。
 * 工厂把"用哪个注册表"变成构造时的一个参数 —— 于是同一个 PTC 运行时
 * 可以服务不同的工具集（多智能体场景下每个子 agent 一套）。
 *
 * ── 工具描述是提示词的一部分 ★ ────────────────────────────────────────
 *
 * 模型对 `run_program` 的使用质量几乎完全取决于这段描述写得好不好：
 * 说清楚"什么时候该用"（批量、筛选、去重、统计、汇总）与"什么时候别用"
 * （只调一两次工具），比在提示词里反复叮嘱有效得多。
 * 所以这里写得比较长 —— 它是**接口的一部分**，不是可有可无的说明。
 */

import { fail, ok } from './tools.ts'
import type { Tool, ToolRegistry, ToolResult } from './tools.ts'
import { runProgram } from './ptc-runtime.ts'
import { PTC_DIR_NAME } from './ptc-runtime.ts'

/**
 * 造一个绑定到某个工具注册表的 `run_program` 工具。
 * @param registry 程序里可以调用的工具
 * @returns 工具定义
 */
export function createProgramTool(registry: ToolRegistry): Tool {
  return {
    name: 'run_program',
    description: [
      '写一段 JavaScript 程序，在一个**全新进程**里运行，然后只把它的打印输出与返回值带回来。',
      '',
      '程序里可以：',
      '  · 像普通 async 函数一样调用工具：await tools.read_file({ path: "README.md" })',
      '  · 用 Promise.all 并发调用多个工具',
      '  · 用 console.log 打印中间过程（会回到对话里）',
      '  · 把最终结论赋给 globalThis.result（也会回到对话里）',
      '',
      '什么时候该用它：需要对**一批**东西做筛选、去重、计数、排序、汇总时 ——',
      '因为中间结果留在程序里，不占上下文。',
      '什么时候别用它：只需要调一两次工具时，直接调用那些工具更省事。',
      '',
      `程序文件会写进工作目录的 ${PTC_DIR_NAME}/ 下，运行结束后仍然留在那里，便于排查。`,
      '注意：程序以当前用户权限运行，没有沙箱保护。',
    ].join('\n'),
    sideEffect: 'reversible',
    parameters: {
      type: 'object',
      properties: {
        program: {
          type: 'string',
          description: '要运行的 JavaScript 程序（ESM，支持顶层 await）',
        },
        timeoutMs: { type: 'number', description: '总时限毫秒数，默认 60000' },
        maxToolCalls: { type: 'number', description: '程序最多能调用工具几次，默认 50' },
      },
      required: ['program'],
    },
    async handler(args, ctx): Promise<ToolResult> {
      const program = String(args.program ?? '')
      if (program.trim() === '') return fail('program 不能为空。')

      const result = await runProgram({
        program,
        tools: registry,
        workspace: ctx.workspace,
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        ...(typeof args.maxToolCalls === 'number' ? { maxToolCalls: args.maxToolCalls } : {}),
      })

      // 头部报告"这次程序做了什么"：工具调用次数是关键指标 ——
      // 它直接对应"省下了多少次进上下文的往返"
      const header = [
        `（PTC 程序执行${result.ok ? '完成' : '失败'}：调用工具 ${result.toolCalls} 次，耗时 ${result.durationMs} ms）`,
        result.truncated ? '（程序输出过长，已截断）' : '',
      ].filter((line) => line !== '').join('\n')

      const body = [
        header,
        result.output.trim() === '' ? '' : `[程序输出]\n${result.output.trim()}`,
        result.result === null || result.result === undefined
          ? ''
          : `[返回值] ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}`,
        result.error === '' ? '' : `[错误] ${result.error}`,
      ].filter((part) => part !== '').join('\n')

      return result.ok ? ok(body) : fail(body)
    },
  }
}
