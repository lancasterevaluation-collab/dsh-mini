/**
 * 第 8 步 ｜ agent 循环：把「请求 → 工具 → 再请求」自动化
 * 第 10 步 ｜ 工具执行前插入「守卫」与「检查点」
 *
 * 到第 7 步为止，所有零件都齐了：
 *   模型层（1）、工具层（2）、容器（3）、事件与依赖注入（4）、
 *   隔离（5）、配置（6）、会话日志（7）
 *
 * 但**没有东西驱动它们**：一次任务要手工 append 一堆事件。
 *
 * 这一步就是那个驱动。它的形状极简 ——
 *
 *     while (还有事做) {
 *       请求模型（用日志派生的消息）
 *       如果模型不要求调用工具 → 收工
 *       执行工具 → 结果写进日志
 *     }
 *
 * ── 三个设计要点 ──────────────────────────────────────────────────────
 *
 * ① **唯一的状态是日志。** 循环自己不维护消息数组 —— 每次请求前从日志派生。
 *    于是「模型看到的」与「日志记的」结构上不可能不一致。
 *
 * ② **每次请求前校验不变量。** 一旦有代码绕过日志直接改消息，当场暴露。
 *
 * ③ **工具消息必须与 tool_calls 一一配对。** assistant 带 N 个 tool_calls，
 *    后面就必须跟 N 个 tool 消息 —— 少一条服务端直接 400。
 *    ★ 我们的做法：**每个调用都产生一条结果**（失败也产生失败结果）。
 *    这样配对是**结构上保证**的，而不是靠记忆。
 *
 * ── ★ 第 10 步的关键：拦截也要走「配对」通道 ★ ──────────────────────
 *
 * 守卫拦下一个调用时，最直觉的做法是"跳过它" —— 但那会**破坏要点 ③**：
 * assistant 带 3 个 tool_calls，却只回了 2 个 tool 消息 → 服务端 400。
 *
 * 所以正确的做法是：**被拦的调用同样产生一条失败结果**，
 * 只不过内容不是"工具报错"，而是"守卫拒绝了，原因是……"。
 *
 * 一句话：**拦截改变的是结果的内容，不是结果的存在。**
 */

import { assertModelVisibleMatchesLog, Session } from './session.ts'
import {
  computeDelayMs,
  errorCodeOf,
  messageOf,
  resolveRetryPolicy,
  retryAfterOf,
  shouldRetry,
  sleep,
} from './retry.ts'
import type { ResolvedRetryPolicy, RetryPolicy } from './retry.ts'
import { fail } from './tools.ts'
import type { SideEffect } from './guard.ts'
import type { Approver, GuardChain, ToolCallRecord, ToolCallRequest } from './guard.ts'
import type { CheckpointStore } from './checkpoint.ts'
import { LLMError } from './llm.ts'
import type { ChatMessage, LLMResponse, Provider, ToolCall } from './llm.ts'
import type { ToolRegistry, ToolResult } from './tools.ts'

/** 默认的步数上限。 */
export const DEFAULT_MAX_STEPS = 20

/**
 * 一次模型请求失败的「现场」—— 交给 {@link RequestErrorHook} 决策。
 *
 * 把它们打包成一个对象而不是散成参数，是因为决策者将来还需要更多上下文
 * （比如累计 token、当前 turn 的步号）；加字段不破坏已有实现。
 */
export interface RequestErrorContext {
  /** 失败的原始错误。 */
  readonly error: unknown
  /** 这是第几次尝试（从 1 开始）。 */
  readonly attempt: number
  /** 本次请求要发的消息（重试时保持不变）。 */
  readonly messages: readonly ChatMessage[]
  /** 循环当前的默认策略 —— 决策者可以忽略它，也可以作为默认值参考。 */
  readonly policy: ResolvedRetryPolicy
  /** 写入失败尝试的那个会话。 */
  readonly session: Session
  /** 取消信号。 */
  readonly signal: AbortSignal | undefined
}

/**
 * 对一次失败请求的裁决。
 *
 * 三种结局刻意分开：`fail` 是「真的失败了」，`cancel` 是「被取消」——
 * 合成一种会让调用方无法区分，而这两种在日志里语义完全不同。
 */
export type RequestErrorDecision =
  /** 等 `delayMs` 毫秒后再试一次。 */
  | { readonly kind: 'retry'; readonly delayMs: number }
  /** 放弃，把原始错误抛出去。 */
  | { readonly kind: 'fail' }
  /** 中止为「取消」（而不是失败）。 */
  | { readonly kind: 'cancel'; readonly reason: string }

/**
 * 失败请求的决策者（第 9 步插件化的挂载点）。
 *
 * ★ 为什么循环不直接调用 {@link shouldRetry}，而要留一个钩子？★
 * 因为「要不要重试」是**策略**，不是**机制**。
 * 策略应该能被插件替换、能被卸载 —— 卸载重试插件就等于关掉重试，
 * 而循环代码一行都不用改（见课程主线 2）。
 *
 * 不给这个钩子时，循环退回内置的 `shouldRetry` + `computeDelayMs` 行为。
 */
export type RequestErrorHook = (
  context: RequestErrorContext,
) => RequestErrorDecision | Promise<RequestErrorDecision>

/** 一次 run 的依赖。 */
export interface AgentOptions {
  readonly provider: Provider
  readonly tools: ToolRegistry
  readonly session: Session
  /** 工具的工作目录。 */
  readonly workspace: string
  /** 最多走几步；不给用 {@link DEFAULT_MAX_STEPS}。 */
  readonly maxSteps?: number
  /** 第 9 步新增：模型请求失败时的重试策略；不给就是 normal 模式的默认值。 */
  readonly retryPolicy?: RetryPolicy
  /** 第 9 步插件化新增：失败请求的决策者；不给就用 `retryPolicy` 的内置判断。 */
  readonly requestErrorHook?: RequestErrorHook
  /** 第 10 步新增：守卫链。不给就**不检查**任何规则（保持第 9 步的行为）。 */
  readonly guards?: GuardChain
  /** 第 10 步新增：守卫给出 `ask` 时的审批人。不给 = 一律拒绝危险操作。 */
  readonly approver?: Approver
  /** 第 10 步新增：检查点仓库。不给就**不拍快照**（B 类失败将无法回滚）。 */
  readonly checkpoints?: CheckpointStore
}

/** 一次 turn 的结局。 */
export type TurnStatus =
  /** 模型不再要求调用工具 —— 正常收工。 */
  | 'complete'
  /** 达到步数上限。 */
  | 'max-steps'
  /** 被调用方取消。 */
  | 'cancelled'

/** 一次 run 的结果。 */
export interface TurnResult {
  readonly status: TurnStatus
  /** 实际走了多少步。 */
  readonly steps: number
  /** 收工时的模型文本（非 complete 时为空串）。 */
  readonly text: string
}

/**
 * 一个 agent：把「用户任务」跑成「一串会话事件」。
 *
 * 它是**无状态**的（除了依赖引用）—— 所有状态都在 `Session` 里。
 * 所以同一个 `Agent` 实例可以连续跑多个任务，也可以被丢弃后从日志重建。
 */
export class Agent {
  readonly #provider: Provider
  readonly #tools: ToolRegistry
  readonly #session: Session
  readonly #workspace: string
  readonly #maxSteps: number
  readonly #retryPolicy: ResolvedRetryPolicy
  readonly #requestErrorHook: RequestErrorHook | undefined
  readonly #guards: GuardChain | undefined
  readonly #approver: Approver | undefined
  readonly #checkpoints: CheckpointStore | undefined

  /**
   * 本次 turn 里已经执行过的调用 —— 守卫判断"是不是在重复"的依据。
   * ★ 它**每个 turn 重置一次** ★：守卫关心的是"这一次任务里你在干什么"，
   * 而不是"这个进程历史上发生过什么"。
   */
  #history: ToolCallRecord[] = []

  constructor(options: AgentOptions) {
    this.#provider = options.provider
    this.#tools = options.tools
    this.#session = options.session
    this.#workspace = options.workspace
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.#retryPolicy = resolveRetryPolicy(options.retryPolicy)
    this.#requestErrorHook = options.requestErrorHook
    this.#guards = options.guards
    this.#approver = options.approver
    this.#checkpoints = options.checkpoints
  }

  /** 这个 agent 正在写的会话。 */
  get session(): Session {
    return this.#session
  }

  /** 这次 turn 到目前为止执行过的工具调用（供外部检查与演示）。 */
  get history(): readonly ToolCallRecord[] {
    return [...this.#history]
  }

  /**
   * 跑一次任务。
   *
   * **任何路径都会留下一个闭合的 turn** —— 无论正常收工、超步数、取消还是抛错。
   * 这是「日志任何时候都是完整状态」的保证。
   * @param task 用户的任务描述
   * @param signal 取消信号
   * @returns 这次 turn 的结局
   * @throws provider 或工具层的意外错误（此时 turn 已被闭合为 `error`）
   */
  async run(task: string, signal?: AbortSignal): Promise<TurnResult> {
    const turn = this.#session.startTurn()
    this.#session.recordUser(task)

    // 守卫只关心本次任务 —— 历史从零开始
    this.#history = []

    // 记录"完整走完了几步" —— 让三条取消路径的 steps 语义一致
    let completedSteps = 0

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        // 取消检查放在每步开头
        if (signal?.aborted === true) {
          this.#session.endTurn(turn, 'cancelled')
          return { status: 'cancelled', steps: completedSteps, text: '' }
        }

        const finalText = await this.#step(signal)
        completedSteps = step

        if (finalText !== undefined) {
          this.#session.endTurn(turn, 'complete')
          return { status: 'complete', steps: step, text: finalText }
        }
      }

      this.#session.endTurn(turn, 'max-steps')
      return { status: 'max-steps', steps: this.#maxSteps, text: '' }
    } catch (error) {
      // ★ 第 9 步修正：**取消导致的失败不是"错误"，是"取消"**。
      //   取消可能发生在任何 await 点（比如退避等待中），如果都当错误抛出，
      //   同一种"取消"就会有两种表现 —— 调用方无法统一处理。
      if (signal?.aborted === true || errorCodeOf(error) === 'CANCELLED') {
        this.#session.endTurn(turn, 'cancelled')
        return { status: 'cancelled', steps: completedSteps, text: '' }
      }

      // 其它错误：闭合 turn 后原样抛出（不包装，保留原始类型与堆栈）
      this.#session.endTurn(turn, 'error')
      throw error
    }
  }

  /**
   * 走一步。
   * @returns 收工时的最终文本；返回 `undefined` 表示「还没完，继续下一步」
   */
  async #step(signal?: AbortSignal): Promise<string | undefined> {
    const step = this.#session.startStep()

    // ① 从日志派生请求 —— 不维护内存里的消息数组
    const messages = this.#session.deriveMessages()

    // ② ★ 校验不变量：实际要发的消息，必须与日志派生的完全一致
    assertModelVisibleMatchesLog(this.#session, messages)

    // ③ 请求模型（失败会按策略重试）
    const response = await this.#request(messages, signal)

    // ④ 先落盘，再决策 —— 保证"模型说了什么"永远是第一个被记住的事实
    this.#session.recordAssistant(response.content, response.toolCalls, response.usage)

    // ⑤ 模型不再要求调用工具 → 收工
    if (response.toolCalls.length === 0) {
      this.#session.endStep(step)
      return response.content
    }

    // ⑥ 执行工具。**顺序执行**，且每个调用都产生一条结果（见文件头的 ③）
    for (const call of response.toolCalls) {
      this.#session.recordToolCall(call.id, call.name)

      const result = await this.#runGuarded(call, step)

      this.#session.recordToolResult(call.id, call.name, result.content, result.isError)
    }

    this.#session.endStep(step)
    return undefined
  }

  /**
   * 执行一次工具调用，**但先过守卫和检查点**。
   *
   * 顺序是刻意的，不能调换：
   *
   *     ① 守卫裁决   —— 最便宜，且能拦住本不该发生的事（C 类唯一的机会）
   *     ② 拍检查点   —— 只有"确定要做、且会改状态"时才值得付这个代价（B 类的依据）
   *     ③ 真正执行
   *     ④ 记入历史   —— 供下一个守卫判断
   *
   * ★ 为什么不先拍快照再裁决？★ 因为对只读调用拍快照是纯浪费，
   * 而对**被拒绝**的调用拍快照更是浪费 —— 它根本不会改变任何东西。
   *
   * ★ 为什么被拒绝也要返回 ToolResult 而不是跳过？★
   * 见文件头「拦截也要走配对通道」—— 跳过会破坏 tool_calls 的配对。
   * @param call 模型要求的调用
   * @param step 当前步号（守卫和快照都要记）
   * @returns 执行结果，或被拒绝/未批准的失败结果
   */
  async #runGuarded(call: ToolCall, step: number): Promise<ToolResult> {
    const tool = this.#tools.get(call.name)
    // 未知工具没有声明等级 —— 当成无副作用，让注册表去报"未知工具"
    const sideEffect: SideEffect = tool?.sideEffect ?? 'none'

    const request: ToolCallRequest = {
      name: call.name,
      args: call.arguments,
      sideEffect,
      workspace: this.#workspace,
      step,
    }

    // ① 守卫
    if (this.#guards !== undefined) {
      const outcome = this.#guards.check(request, this.#history)

      if (outcome.verdict.kind === 'deny') {
        const reason = outcome.verdict.reason
        this.#session.recordGuard(call.name, 'deny', outcome.byRule, reason)
        // 记入历史：让**后续**的守卫也知道"这次尝试发生了"
        this.#pushHistory(call, true, reason)
        return fail(reason)
      }

      if (outcome.verdict.kind === 'ask') {
        const question = outcome.verdict.question
        this.#session.recordGuard(call.name, 'ask', outcome.byRule, question)

        const decision = await (this.#approver ?? {
          request: async () => ({ approved: false, reason: '没有配置审批人，默认拒绝。' }),
        }).request(request, question)

        if (!decision.approved) {
          const reason = `操作被拒绝：${question}\n${decision.reason ?? ''}`.trim()
          this.#pushHistory(call, true, reason)
          return fail(reason)
        }
      }
    }

    // ② 检查点：只在"会改变状态"的调用之前拍
    if (this.#checkpoints !== undefined && sideEffect !== 'none') {
      await this.#checkpoints.snapshot(step)
    }

    // ③ 真正执行
    const result = await this.#tools.execute(call.name, call.arguments, {
      workspace: this.#workspace,
    })

    // ④ 记入历史
    this.#pushHistory(call, result.isError, result.content)

    return result
  }

  /** 往守卫历史里追加一条记录（截断摘要，避免守卫看到整段大输出）。 */
  #pushHistory(call: ToolCall, isError: boolean, content: string): void {
    this.#history.push({
      name: call.name,
      args: call.arguments,
      isError,
      summary: content.length > 200 ? `${content.slice(0, 200)}…` : content,
    })
  }

  /**
   * 请求模型，失败时按策略重试。
   *
   * ★ 每次失败的尝试都会**写进日志**（`assistant/attempt`）。
   * 这个事件**不是表面事件** —— 它不进模型历史，但它是**持久事实**。
   *
   * 为什么值得单独记？
   *   不记它，你就无法回答"这道题重试了几次" —— 而那是一个真实的研究指标
   *   （比如"干预让重试次数下降了多少"）。
   * @param messages 要发的消息。**每次重试用同一份** —— 重试不改变请求内容
   * @param signal 取消信号
   * @returns 成功的响应
   * @throws 策略判定不该重试、或重试耗尽时的最后一次错误
   */
  async #request(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const policy = this.#retryPolicy
    let attempt = 0

    for (;;) {
      attempt += 1

      try {
        return await this.#provider.chat(messages, this.#tools.schemas(), signal)
      } catch (error) {
        // ① 先把失败记下来 —— 这是持久事实，先记再说
        this.#session.recordAttempt(attempt, errorCodeOf(error) ?? 'UNKNOWN', messageOf(error))

        // ② 决定要不要再试。★ 第 9 步插件化：决策权交给钩子（如果装了重试插件）
        const decision = await this.#decide(error, attempt, messages, policy, signal)

        if (decision.kind === 'fail') throw error
        if (decision.kind === 'cancel') throw new LLMError('CANCELLED', decision.reason)

        // ③ 等一会儿（可被取消打断 —— 否则一次 30 秒退避会让取消形同虚设）
        await sleep(decision.delayMs, signal)

        // ④ 唤醒后如果已取消，抛一个**明确的「取消」错误** —— 不再多试一次。
        //    注意：这里抛 CANCELLED 而不是原来那个错误（比如 SERVER）——
        //    否则调用方无法区分「因取消而中止」和「真的失败了」。
        if (signal?.aborted === true) {
          throw new LLMError('CANCELLED', '请求在重试等待期间被取消')
        }
      }
    }
  }

  /**
   * 对一次失败请求做裁决。
   *
   * 有钩子就用钩子 —— 钩子是插件装进来的策略（可替换、可卸载）；
   * 没有钩子就退回内置判断，也就是第 9 步之前的原始行为。
   *
   * ★ 为什么"没有钩子"不等于"不重试"？★
   * 因为钩子的存在与否是**插件是否装载**，而不是**策略是否开启**。
   * 让缺省退回旧的确定性行为，卸载插件才不会把已有调用方的语义一起改掉。
   * @param error 失败原因
   * @param attempt 第几次尝试
   * @param messages 本次请求的消息
   * @param policy 内置策略（钩子缺省时用它）
   * @param signal 取消信号
   * @returns 裁决
   */
  async #decide(
    error: unknown,
    attempt: number,
    messages: readonly ChatMessage[],
    policy: ResolvedRetryPolicy,
    signal: AbortSignal | undefined,
  ): Promise<RequestErrorDecision> {
    if (this.#requestErrorHook !== undefined) {
      return await this.#requestErrorHook({
        error,
        attempt,
        messages,
        policy,
        session: this.#session,
        signal,
      })
    }

    if (!shouldRetry(policy, error, attempt)) return { kind: 'fail' }
    return { kind: 'retry', delayMs: computeDelayMs(policy, attempt, retryAfterOf(error)) }
  }
}
