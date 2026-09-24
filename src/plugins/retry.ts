/**
 * 能力插件 ④ ｜ retry：第 9 步的重试，**变成一个可以卸载的插件**
 *
 * 第 9 步把重试写进了 `kernel/agent.ts` 的 `#request()`：分类 → 退避 → 再试。
 * 逻辑是对的，但位置是错的 —— 它躺在**调用链里**：
 *
 *     // 想关掉重试？改循环。想换个退避曲线？改循环。想加"限流时多试一次"？改循环。
 *
 * 这个插件把它搬出来，做成课程主线 2 的那个例子：
 *
 *     retry 是一个**监听 `agent/request-error` 的插件**；
 *     卸载它 = 关掉重试，循环代码一行不改。
 *
 * 它怎么做到的？靠第 8 步给 Agent 留的那个钩子（`requestErrorHook`）：
 * 钩子是一个**普通函数类型**，kernel 因此不需要认识框架；
 * 而把钩子接到 `ctx.emit('agent/request-error')` 上的动作发生在这里。
 *
 * ── 三种角色，别混淆 ──────────────────────────────────────────────────
 *
 *   | 角色 | 是谁 | 干什么 |
 *   |---|---|---|
 *   | 默认策略 | `retryPolicy` | 不认识的具体错误码 → 该不该试 |
 *   | 裁决者 | 监听 `agent/request-error` 的插件 | 可以推翻默认（比如"限流时无视预算多试一次"） |
 *   | 记录者 | 本插件的 stats | 重试了几次、每次什么错 —— 研究指标的数据来源 |
 *
 * ── 为什么预算（budget）要单独算？──────────────────────────────────────
 *
 * 因为"每次请求最多重试 5 次"约束的是**一次请求**，不是**一次任务**。
 * 一个 20 步的任务理论上可以发起 20 × 6 次调用 —— 真实故障里这种雪崩很常见，
 * 表现是"任务没失败，但跑了十分钟"。预算把它按住：**任务级**的上限。
 */

import {
  computeDelayMs,
  errorCodeOf,
  messageOf,
  resolveRetryPolicy,
  retryAfterOf,
  shouldRetry,
} from '../kernel/retry.ts'
import type { BackoffConfig, RetryPolicy } from '../kernel/retry.ts'
import type { RequestErrorDecision, RequestErrorHook } from '../kernel/agent.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /**
     * 一次模型请求失败了。
     *
     * **这是 waterfall 事件**：监听器可以返回一个 `RequestErrorDecision`
     * 来接管裁决（返回值会被当作最终决定）；不返回就交给下一个监听器，
     * 全都没返回就用默认策略。
     */
    'agent/request-error': {
      readonly error: unknown
      readonly attempt: number
      readonly code: string
      readonly message: string
    }
    /** 本插件做出的每一次裁决 —— 用于事后复算"为什么这次没重试"。 */
    'retry/decided': {
      readonly attempt: number
      readonly code: string
      readonly kind: 'retry' | 'fail' | 'cancel'
      readonly delayMs: number
      readonly reason: string
    }
  }
}

/** 配置文件里这一段能写什么。 */
export interface RetryConfig {
  /** `normal`（按错误码判断）或 `always`（一律重试）。默认 `normal`。 */
  readonly mode?: string
  /** 单次请求的最多重试次数。 */
  readonly maxRetries?: number
  /** normal 模式下哪些错误码值得重试。 */
  readonly retryableCodes?: readonly string[]
  /** 退避参数。 */
  readonly backoff?: BackoffConfig
  /**
   * 一次**任务**内允许的重试总次数。超出后一律不重试。
   * 不给表示不限（与第 9 步的原始行为一致）。
   */
  readonly budget?: number
}

/** 解析后的重试配置。 */
export interface RetrySpec {
  readonly policy: RetryPolicy
  readonly budget: number | undefined
}

/** 重试的运行时统计。 */
export interface RetryStats {
  /** 失败尝试总数（含第一次）。 */
  readonly attempts: number
  /** 真正决定重试的次数。 */
  readonly retries: number
  /** 按错误码分布。 */
  readonly byCode: Record<string, number>
  /** 被预算拦下的次数。 */
  readonly budgetExceeded: number
}

/**
 * 解析重试配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws mode / budget / maxRetries 取值非法时
 */
export function resolveRetrySpec(config: RetryConfig | undefined): RetrySpec {
  const raw = config ?? {}
  const mode = raw.mode ?? 'normal'
  if (mode !== 'normal' && mode !== 'always') {
    throw new Error(`retry 插件：未知的 mode "${mode}"；只支持 normal / always`)
  }

  if (raw.budget !== undefined && (!Number.isInteger(raw.budget) || raw.budget < 0)) {
    throw new Error(`retry 插件：budget 必须是非负整数，收到 ${String(raw.budget)}`)
  }

  const policy: RetryPolicy = mode === 'always'
    ? { mode: 'always', ...(raw.backoff !== undefined ? { backoff: raw.backoff } : {}) }
    : {
        mode: 'normal',
        ...(raw.maxRetries !== undefined ? { maxRetries: raw.maxRetries } : {}),
        ...(raw.retryableCodes !== undefined
          ? { retryableCodes: raw.retryableCodes as never }
          : {}),
        ...(raw.backoff !== undefined ? { backoff: raw.backoff } : {}),
      }

  return { policy, budget: raw.budget }
}

/** retry 插件提供的服务形状。 */
export interface RetryService {
  /** 交给 agent 循环的钩子。 */
  readonly hook: RequestErrorHook
  /** 当前策略（已解析）。 */
  readonly spec: RetrySpec
  /** 读一份统计快照。 */
  stats(): RetryStats
  /** turn 边界调用：清空按任务计的运行时状态。 */
  reset(): void
}

/** retry 插件。 */
export const retryPlugin: Plugin = {
  name: 'retry',
  apply(ctx, config) {
    const spec = resolveRetrySpec(config as RetryConfig | undefined)
    const policy = resolveRetryPolicy(spec.policy)

    let attempts = 0
    let retries = 0
    let budgetExceeded = 0
    const byCode: Record<string, number> = {}

    const decideLocally = (error: unknown, attempt: number): RequestErrorDecision => {
      if (!shouldRetry(policy, error, attempt)) return { kind: 'fail' }
      const delayMs = computeDelayMs(policy, attempt, retryAfterOf(error))
      return { kind: 'retry', delayMs }
    }

    const hook: RequestErrorHook = async (context) => {
      const code = errorCodeOf(context.error) ?? 'UNKNOWN'
      attempts += 1
      byCode[code] = (byCode[code] ?? 0) + 1

      // ★ 扩展点：先让监听器有机会接管裁决
      const overridden = await ctx.emit('agent/request-error', {
        error: context.error,
        attempt: context.attempt,
        code,
        message: messageOf(context.error),
      })

      let decision = isDecision(overridden) ? overridden : decideLocally(context.error, context.attempt)
      let reason = isDecision(overridden) ? '由监听器接管' : '默认策略'

      // 预算只在"本来要重试"时才扣 —— 不该因为一次不重试的失败把预算吃掉
      if (decision.kind === 'retry' && spec.budget !== undefined && retries >= spec.budget) {
        budgetExceeded += 1
        decision = { kind: 'fail' }
        reason = `重试预算已用尽（budget=${spec.budget}）`
      }

      if (decision.kind === 'retry') retries += 1

      await ctx.emit('retry/decided', {
        attempt: context.attempt,
        code,
        kind: decision.kind,
        delayMs: decision.kind === 'retry' ? decision.delayMs : 0,
        reason,
      })

      return decision
    }

    const service: RetryService = {
      hook,
      spec,
      stats: () => ({ attempts, retries, byCode: { ...byCode }, budgetExceeded }),
      reset: () => {
        attempts = 0
        retries = 0
        budgetExceeded = 0
        for (const key of Object.keys(byCode)) delete byCode[key]
      },
    }

    ctx.provide('retry', service)
    console.log(
      `[retry] 已装载：mode=${policy.mode} maxRetries=${policy.maxRetries}` +
        `${spec.budget === undefined ? '' : ` budget=${spec.budget}`}`,
    )
  },
}

/** 判断一个 waterfall 返回值是不是真正的裁决。 */
function isDecision(value: unknown): value is RequestErrorDecision {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'retry' || kind === 'fail' || kind === 'cancel'
}

export default retryPlugin
