/**
 * 第 9 步演示：重试。
 *
 * 运行：  node src/demos/demo-retry.ts
 */

import { Agent } from '../kernel/agent.ts'
import { LLMError } from '../kernel/llm.ts'
import { Session } from '../kernel/session.ts'
import { ToolRegistry } from '../kernel/tools.ts'
import type { ChatMessage, LLMErrorCode, LLMResponse, Provider } from '../kernel/llm.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
}

/**
 * 一个「会失败几次」的 provider。
 * 前 N 次调用抛错，之后返回成功。
 */
class FlakyProvider implements Provider {
  #remainingFailures: number
  readonly #code: LLMErrorCode
  #calls = 0

  constructor(remainingFailures: number, code: LLMErrorCode) {
    this.#remainingFailures = remainingFailures
    this.#code = code
  }

  /** 实际被调用了几次 —— 用来验证"重试了几次"。 */
  get calls(): number {
    return this.#calls
  }

  async chat(_messages: readonly ChatMessage[], _tools?: unknown, signal?: AbortSignal): Promise<LLMResponse> {
    if (signal?.aborted === true) throw new LLMError('CANCELLED', '已取消')

    this.#calls += 1
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1
      throw new LLMError(this.#code, `第 ${this.#calls} 次尝试失败（${this.#code}）`)
    }
    return { content: `成功了（共尝试 ${this.#calls} 次）`, toolCalls: [], usage: {} }
  }
}

/** 一个空工具注册表 —— 本演示不需要工具。 */
function noTools(): ToolRegistry {
  return new ToolRegistry()
}

/** 快速退避，让演示不等待。 */
const FAST_BACKOFF = { initialDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 }

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：前两次失败，第三次成功
  // ==========================================================
  console.log('======== 演示 1：重试成功 ========')

  const provider1 = new FlakyProvider(2, 'RATE_LIMIT')
  const session1 = new Session('retry-1')
  const agent1 = new Agent({
    provider: provider1,
    tools: noTools(),
    session: session1,
    workspace: '.',
    retryPolicy: { mode: 'normal', maxRetries: 5, backoff: FAST_BACKOFF },
  })

  const result1 = await agent1.run('一个第一次会失败的任务')
  show('结果', result1)
  show('provider 实际被调用几次', provider1.calls)
  show('事件流', session1.events.map((e) => `${e.seq} ${e.type}`))
  show('统计（★ 注意 attempts）', session1.stats())

  // ==========================================================
  // 演示 2：AUTH 不重试
  // ==========================================================
  console.log('\n======== 演示 2：AUTH 立刻失败（不重试） ========')

  const provider2 = new FlakyProvider(99, 'AUTH')
  const session2 = new Session('retry-2')
  const agent2 = new Agent({
    provider: provider2, tools: noTools(), session: session2, workspace: '.',
    retryPolicy: { mode: 'normal', maxRetries: 5, backoff: FAST_BACKOFF },
  })

  try {
    await agent2.run('密钥错的任务')
  } catch (error) {
    show('抛出的错误', error instanceof Error ? error.message : String(error))
  }
  show('provider 被调用几次（应该是 1）', provider2.calls)
  show('尝试记录', session2.stats().attempts)

  // ==========================================================
  // 演示 3：重试耗尽
  // ==========================================================
  console.log('\n======== 演示 3：重试耗尽 ========')

  const provider3 = new FlakyProvider(99, 'SERVER')
  const session3 = new Session('retry-3')
  const agent3 = new Agent({
    provider: provider3, tools: noTools(), session: session3, workspace: '.',
    retryPolicy: { mode: 'normal', maxRetries: 2, backoff: FAST_BACKOFF },
  })

  try {
    await agent3.run('永远失败的任务')
  } catch (error) {
    show('抛出的错误', error instanceof Error ? error.message : String(error))
  }
  show('provider 被调用几次（1 次原始 + 2 次重试 = 3）', provider3.calls)
  show('日志里的失败尝试', session3.events
    .filter((e) => e.type === 'assistant/attempt')
    .map((e) => {
      const d = e.data as { attempt: number; code: string; message: string }
      return `第 ${d.attempt} 次：${d.code}`
    }))

  // ==========================================================
  // 演示 4：always 模式
  // ==========================================================
  console.log('\n======== 演示 4：always 模式 ========')

  const provider4 = new FlakyProvider(3, 'SERVER')
  const session4 = new Session('retry-4')
  const agent4 = new Agent({
    provider: provider4, tools: noTools(), session: session4, workspace: '.',
    retryPolicy: { mode: 'always', backoff: FAST_BACKOFF },
  })

  const result4 = await agent4.run('会失败三次的任务')
  show('结果', result4)
  show('provider 被调用几次', provider4.calls)

  // ==========================================================
  // 演示 5：取消打断退避
  // ==========================================================
  console.log('\n======== 演示 5：取消打断退避 ========')

  const provider5 = new FlakyProvider(99, 'SERVER')
  const session5 = new Session('retry-5')
  const agent5 = new Agent({
    provider: provider5, tools: noTools(), session: session5, workspace: '.',
    // ★ 故意用很长的退避 —— 如果取消不能打断它，这个演示要等 30 秒
    retryPolicy: { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 30_000, maxDelayMs: 30_000 } },
  })

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)

  const started = Date.now()
  const result5 = await agent5.run('会被取消的任务', controller.signal)
  const elapsed = Date.now() - started

  show('结果', result5)
  show('耗时（ms）—— 远小于 30000 说明取消打断了退避', elapsed)

  // ==========================================================
  // 演示 6：重试不改变请求内容
  // ==========================================================
  console.log('\n======== 演示 6：重试发的是同一份消息 ========')
  console.log('说明：messages 在 #request 之外派生一次，重试时原样重发。')
  console.log('      所以「重试」不会把失败的尝试写进模型历史 —— 模型看到的和第一次完全一样。')
  show('演示 1 的最终消息数', session1.deriveMessages().length)
  show('演示 1 的事件数', session1.events.length)
  console.log('    差值 = 过程事件 + 失败的尝试 —— 它们都不进模型历史。')
}

await main()
