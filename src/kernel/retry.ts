/**
 * 第 9 步 ｜ 重试：什么时候重试、等多久、最多几次
 *
 * 第 1 步埋下的那颗种子（`LLMErrorCode`）在这里**兑现**。
 *
 * 看第 1 步的原话：
 *   「不知道错在哪一类，就不知道要不要重试。」
 *
 * 现在这句话变成了代码：
 *   - `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` → **重试**
 *   - `AUTH` / `INVALID_REQUEST`                                       → **不重试**
 *   - `UNKNOWN`                                                        → **不重试**（保守）
 *   - ★ `CANCELLED`                                                     → **永不重试**
 *
 * ── 三个问题 ──────────────────────────────────────────────────────────
 *
 * ① **要不要重试？**  → 看错误码（`shouldRetry`）
 * ② **等多久？**      → 指数退避 + 抖动，服务端给了 `Retry-After` 就听它的（`computeDelayMs`）
 * ③ **最多几次？**    → 策略配置（normal 有上限，always 无上限）
 */

import type { LLMErrorCode } from './llm.ts'

// ============================================================
// 一、策略配置
// ============================================================

/** 退避参数。 */
export interface BackoffConfig {
  /** 初始退避毫秒数（默认 500）。 */
  readonly initialDelayMs?: number
  /** 退避上限毫秒数（默认 10000）。 */
  readonly maxDelayMs?: number
  /** 对称抖动比例，0–1（默认 0.1 = ±10%）。 */
  readonly jitterRatio?: number
}

/** **有界**重试：只重试列出的错误码，次数有限。 */
export interface NormalRetryPolicy {
  readonly mode: 'normal'
  /** 最多重试几次（默认 5）—— 加上首次，总共最多 6 次尝试。 */
  readonly maxRetries?: number
  /** 哪些错误码值得重试。 */
  readonly retryableCodes?: readonly LLMErrorCode[]
  readonly backoff?: BackoffConfig
}

/** **无界**重试：任何失败都重试（取消除外），直到成功或放弃。 */
export interface AlwaysRetryPolicy {
  readonly mode: 'always'
  readonly backoff?: BackoffConfig
}

/** 重试策略。 */
export type RetryPolicy = NormalRetryPolicy | AlwaysRetryPolicy

/** 解析后的策略（默认值已经填好）。 */
export interface ResolvedRetryPolicy {
  readonly mode: 'normal' | 'always'
  readonly maxRetries: number
  readonly retryableCodes: ReadonlySet<string>
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

// ============================================================
// 二、默认值
// ============================================================

/**
 * 默认可重试的错误码。
 *
 * 这个列表就是第 1 步 `LLMErrorCode` 里"该重试吗"那一列的**落地**。
 * 注意它**不包含** `AUTH` 和 `INVALID_REQUEST` —— 那两个重试一万次也一样。
 */
export const DEFAULT_RETRYABLE_CODES: readonly LLMErrorCode[] = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]

export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_INITIAL_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 10_000
export const DEFAULT_JITTER_RATIO = 0.1

// ============================================================
// 三、解析
// ============================================================

/**
 * 把可选配置解析成完整策略。
 * @param config 用户配置；不给就是 normal 模式的默认值
 * @returns 填好默认值的策略
 */
export function resolveRetryPolicy(config?: RetryPolicy): ResolvedRetryPolicy {
  const backoff = config?.backoff ?? {}
  const initialDelayMs = backoff.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = backoff.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (config?.mode === 'always') {
    return {
      mode: 'always',
      maxRetries: Number.POSITIVE_INFINITY,
      retryableCodes: new Set(DEFAULT_RETRYABLE_CODES),
      initialDelayMs,
      maxDelayMs,
      jitterRatio,
    }
  }

  return {
    mode: 'normal',
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryableCodes: new Set(config?.retryableCodes ?? DEFAULT_RETRYABLE_CODES),
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
  }
}

// ============================================================
// 四、三个决策
// ============================================================

/**
 * 要不要重试？
 * @param policy 策略
 * @param error 刚发生的错误
 * @param attempt **已经尝试了几次**（第 1 次失败时传 1）
 * @returns 是否应该再试一次
 */
export function shouldRetry(
  policy: ResolvedRetryPolicy,
  error: unknown,
  attempt: number,
): boolean {
  const code = errorCodeOf(error)

  // ★ 取消永远不重试 —— 无论什么模式。
  //   用户不想要了，重试只会让"取消"变得不可靠。
  if (code === 'CANCELLED') return false

  // always 模式：除了取消，什么都重试
  if (policy.mode === 'always') return true

  // normal 模式：先看预算，再看错误码
  if (attempt > policy.maxRetries) return false
  return code !== undefined && policy.retryableCodes.has(code)
}

/**
 * 该等多久？
 *
 * 两条规则，优先级明确：
 *   ① 服务端给了 `Retry-After`，且**在我们的上限内** → 听它的（最准）
 *   ② 否则 → 指数退避 + 对称抖动
 * @param policy 策略
 * @param attempt 已经尝试了几次
 * @param retryAfterMs 服务端建议的等待毫秒数（来自第 1 步的 `retryAfterMs`）
 * @returns 等待毫秒数
 */
export function computeDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  retryAfterMs?: number,
): number {
  // ① 服务端的建议优先 —— 但只在它不超出我们上限时
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxDelayMs) {
    return retryAfterMs
  }

  // ② 本地指数退避：initial × 2^(attempt-1)，封顶 maxDelayMs
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)

  // ③ 对称抖动 —— 避免大量客户端同时重试造成"惊群"
  const factor = 1 + (Math.random() * 2 - 1) * policy.jitterRatio
  return Math.max(0, Math.round(capped * factor))
}

// ============================================================
// 五、从错误里取值
// ============================================================

/**
 * 从错误对象里取错误码。
 * @param error 任意错误值
 * @returns 错误码；取不到就是 undefined
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * 从错误对象里取"服务端建议的等待时间"。
 * @param error 任意错误值
 * @returns 毫秒数；取不到就是 undefined
 */
export function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs
  return typeof value === 'number' ? value : undefined
}

/**
 * 从错误对象里取可读信息。
 * @param error 任意错误值
 * @returns 错误信息
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 可取消的等待。
 *
 * 如果只写 `setTimeout`，那么**取消时要等完整个退避才会响应** ——
 * 一次 30 秒的退避会让"取消"变得毫无意义。
 * @param ms 等待毫秒数
 * @param signal 取消信号
 * @returns 等待结束（或取消）时 resolve
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
