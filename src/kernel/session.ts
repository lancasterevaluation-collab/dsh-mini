/**
 * 第 7 步 ｜ 会话日志：唯一真相（single source of truth）
 *
 * 到第 6 步为止，一次任务的过程**只存在于内存里**。进程一退，什么都没了。
 * 更糟的是：即使不退出，你也回答不了这些问题 ——
 *
 *   这次任务为什么失败？          （过程没记下来）
 *   平均每道题花了多少步？        （步数没被计数）
 *   模型当时到底看到了什么？      （历史和请求是两份数据）
 *
 * ── 核心不变量 ────────────────────────────────────────────────────────
 *
 *   ★ Model-visible ⟺ logged ★
 *
 * 「凡是模型能看到的，必须能从日志重建。」
 *
 * 这条不变量一句话消灭了整类 bug：**模型看到的历史，和存下来的日志，
 * 永远不会不一致** —— 因为前者是后者**算出来的**，不是另一份独立维护的数据。
 *
 * 实现它的方式是「表面事件」（surface events）：
 *   日志里有两种事件 ——
 *     表面事件：会在模型历史里留下痕迹（user/message、assistant/message、tool/result）
 *     过程事件：只用于记账（turn/start、step/end、tool/call，…）
 *   deriveMessages() **只读表面事件**，于是消息天然与日志一致。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage, LLMUsage, ToolCall } from './llm.ts'

// ============================================================
// 一、事件词汇表
// ============================================================

/** 一个 turn 为什么结束。 */
export type TurnEndReason =
  /** 正常收工：模型不再要求调用工具。 */
  | 'complete'
  /** 达到步数上限 —— **这不是错误**，但也不是正常完成。 */
  | 'max-steps'
  /** 被取消。 */
  | 'cancelled'
  /** 出错（含崩溃恢复）。 */
  | 'error'

/**
 * 会话事件的类型表。
 *
 * 和 events.ts 的 EventMap 一样，这是一个**可扩展**的类型：
 * 插件可以用声明合并往里加事件，而不用改这个文件。
 */
export interface SessionEventMap {
  /** 一个 turn 开始了。 */
  'turn/start': { turn: number }
  /** 一个 turn 结束了，并且说明了为什么结束。 */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** 一步开始了。 */
  'step/start': { step: number }
  /** 一步结束了。 */
  'step/end': { step: number }
  /** 用户说了什么。**表面事件**。 */
  'user/message': { text: string }
  /** 模型说了什么 / 要求调用什么。**表面事件**。 */
  'assistant/message': { content: string; toolCalls?: readonly ToolCall[]; usage?: LLMUsage }
  /**
   * 一次**失败的尝试**（第 9 步新增）。
   *
   * 注意它**不是表面事件** —— 失败的尝试不该进模型历史
   * （否则模型会看到一堆"我失败了"，干扰它的推理）。
   * 但它是**持久事实**：不记它，你就无法回答"这道题重试了几次"。
   */
  'assistant/attempt': { attempt: number; code: string; message: string }
  /** 模型要求调用某个工具。**记账用，不是表面事件**（详情已在 assistant/message 里）。 */
  'tool/call': { toolCallId: string; name: string }
  /**
   * 一次工具调用被守卫拦下（第 10 步新增）。
   *
   * **只记 deny 和 ask，不记 allow** —— 因为放行是默认路径，
   * 逐条记录只会让日志膨胀几十倍，而真正有信息量的是"拦了几次、被哪条规则拦的"。
   *
   * 它不是表面事件，但**拒绝理由会通过 `tool/result` 回灌给模型** ——
   * 也就是说模型知道"我想做的事被拦了，原因是……"。
   * 这一条很重要：**拦截必须对模型可见**，否则它会一直重试同一个被拦的动作。
   */
  'tool/guard': {
    /** 被检查的工具名。 */
    name: string
    /** 裁决：`deny` 直接拦下；`ask` 转人工。 */
    verdict: 'deny' | 'ask'
    /** 给出该裁决的规则名。 */
    byRule: string
    /** 裁决的细节（拒绝理由 / 提问内容）。 */
    detail: string
  }
  /** 工具执行的结果。**表面事件**。 */
  'tool/result': { toolCallId: string; name: string; content: string; isError: boolean }
  /**
   * 当前生效的系统提示词被设置或更换（模式系统新增）。
   *
   * 它**不是表面事件**（不直接产生消息），但 `deriveMessages()` 会读它 ——
   * 所以它必须在日志里。否则提示词就成了"日志重建不出来"的隐状态，
   * 而"模型当时看到什么"这个问题就会有一块答不上来。
   */
  'session/system-prompt': { text: string; mode?: string }
}

/** 全部事件类型名。 */
export type SessionEventType = keyof SessionEventMap

/**
 * 哪些事件是「表面事件」—— 会在模型历史里留下痕迹的那些。
 *
 * 这个集合是「Model-visible ⟺ logged」的实现核心：
 * **派生消息时只看这些，别的一律忽略。**
 */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'tool/result',
])

// ============================================================
// 二、事件封装
// ============================================================

/** 日志里的一条记录。 */
export interface SessionEvent {
  /** 序号，从 0 开始，**不跳号**。用于校验日志完整性。 */
  readonly seq: number
  /** 发生时刻（毫秒时间戳）。 */
  readonly time: number
  /** 事件类型。 */
  readonly type: string
  /** 事件数据。 */
  readonly data: unknown
}

/**
 * 会话对象的可选依赖。
 *
 * ★ 为什么钩子放在 kernel 而不是框架层？★
 * 因为它的类型是**普通函数** —— kernel 依然不认识 `Context`、不认识事件分发器。
 * 把它接到框架事件上的工作由 `plugins/session.ts` 完成（第 7 步的插件化）。
 * 这条依赖方向不能反过来：kernel 一旦 import 框架，整条架构就塌了。
 */
export interface SessionOptions {
  /**
   * 每条事件写入后**立即**回调。
   *
   * 为什么要在写入的同一时刻回调，而不是让消费者事后轮询 `events`？
   * 因为进化层（第 12–15 步）要在"事情刚发生"时做判断 ——
   * 事后扫描会拿到一个已经变化的日志，无法区分"这条是刚来的"还是"一直在这儿"。
   * @param event 刚写入的事件
   * @param session 这条事件所属的会话
   */
  readonly onEvent?: (event: SessionEvent, session: Session) => void
}

// ============================================================
// 三、会话
// ============================================================

/**
 * 一次交互的完整记录。
 *
 * 它只做三件事：**追加事件、派生消息、算统计**。
 * 它**不做决策** —— 决定"该 append 什么"是上层（第 8 步的循环）的事。
 */
export class Session {
  readonly id: string
  #events: SessionEvent[] = []
  #nextTurn = 1
  #nextStep = 1
  readonly #onEvent: ((event: SessionEvent, session: Session) => void) | undefined

  /**
   * @param id 会话 id
   * @param options 可选依赖；目前只有「写入后回调」一个
   */
  constructor(id: string, options: SessionOptions = {}) {
    this.id = id
    this.#onEvent = options.onEvent
  }

  /** 只读的事件列表。 */
  get events(): readonly SessionEvent[] {
    return this.#events
  }

  /**
   * 追加一条事件。
   *
   * 这是**唯一**能写日志的方法 —— 没有删除、没有修改。
   * 「只追加」是日志能当唯一真相用的前提。
   * @param type 事件类型
   * @param data 事件数据
   * @returns 刚写入的那条事件
   */
  append<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent {
    const event: SessionEvent = {
      seq: this.#events.length,
      time: Date.now(),
      type,
      data,
    }
    this.#events.push(event)
    // 日志已经写完 —— 回调是「通知」，它的异常不改变"这条事件确实发生了"这个事实。
    // 所以这里不吞异常：让调用方看到失败，而不是让一个人以为通知成功了。
    this.#onEvent?.(event, this)
    return event
  }

  // ---------- 过程事件的小助手（让上层代码更好读）----------

  /** 开一个 turn，返回它的编号。 */
  startTurn(): number {
    const turn = this.#nextTurn
    this.#nextTurn += 1
    this.append('turn/start', { turn })
    return turn
  }

  /** 结束一个 turn。 */
  endTurn(turn: number, reason: TurnEndReason = 'complete'): void {
    this.append('turn/end', { turn, reason })
  }

  /** 开一步，返回它的编号。 */
  startStep(): number {
    const step = this.#nextStep
    this.#nextStep += 1
    this.append('step/start', { step })
    return step
  }

  /** 结束一步。 */
  endStep(step: number): void {
    this.append('step/end', { step })
  }

  /** 记录模型的回应（表面事件）。 */
  recordAssistant(content: string, toolCalls?: readonly ToolCall[], usage?: LLMUsage): void {
    this.append('assistant/message', {
      content,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage !== undefined ? { usage } : {}),
    })
  }

  /** 记录一次失败的尝试（第 9 步新增，**非表面事件**）。 */
  recordAttempt(attempt: number, code: string, message: string): void {
    this.append('assistant/attempt', { attempt, code, message })
  }

  /** 记录用户输入（表面事件）。 */
  recordUser(text: string): void {
    this.append('user/message', { text })
  }

  /** 记录一次工具调用（过程事件）。 */
  recordToolCall(toolCallId: string, name: string): void {
    this.append('tool/call', { toolCallId, name })
  }

  /**
   * 记录一次守卫拦截（第 10 步新增，**非表面事件**，只记 deny / ask）。
   * @param name 被拦的工具名
   * @param verdict 裁决
   * @param byRule 做出该裁决的规则名
   * @param detail 细节（拒绝理由 / 提问内容）
   */
  recordGuard(name: string, verdict: 'deny' | 'ask', byRule: string, detail: string): void {
    this.append('tool/guard', { name, verdict, byRule, detail })
  }

  /** 记录工具结果（表面事件）。 */
  recordToolResult(toolCallId: string, name: string, content: string, isError: boolean): void {
    this.append('tool/result', { toolCallId, name, content, isError })
  }

  /**
   * 设置当前生效的系统提示词。
   *
   * 与上次相同时**不写事件** —— 否则每次 `runTask` 都会往日志里塞一条一模一样的提示词。
   * 只在"真的换了"（首次设置、或切换模式）时才留痕。
   * @param text 提示词全文
   * @param mode 它来自哪个模式（便于排查"这次用的是哪套"）
   */
  setSystemPrompt(text: string, mode?: string): void {
    if (systemPromptOf(this.#events) === text) return
    this.append('session/system-prompt', mode === undefined ? { text } : { text, mode })
  }

  // ---------- 派生 ----------

  /** 从日志派生出发给模型的消息。 */
  deriveMessages(): ChatMessage[] {
    return deriveMessages(this.#events)
  }

  /** 统计。 */
  stats(): SessionStats {
    return computeStats(this.#events)
  }

  // ---------- 持久化 ----------

  /** 存成 JSONL（每行一条事件）。目录不存在时会自动创建。 */
  async save(path: string): Promise<void> {
    // save 应该「拿来就能用」—— 不该要求调用方先建目录
    await mkdir(dirname(path), { recursive: true })
    const text = this.#events.map((event) => JSON.stringify(event)).join('\n')
    await writeFile(path, text === '' ? '' : `${text}\n`, 'utf8')
  }

  /**
   * 从 JSONL 读回来。
   *
   * 注意**修复**：如果最后一条记录是一个没有配对的 `turn/start`
   * （进程在 turn 中间崩了），补一条 `turn/end`。
   * 否则日志就永远处在一个"未闭合"的状态，后续派生会出错。
   */
  static async load(id: string, path: string): Promise<Session> {
    const session = new Session(id)
    const text = await readFile(path, 'utf8')

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      session.#events.push(JSON.parse(line) as SessionEvent)
    }

    // 恢复计数器（不能依赖事件数量，因为 step/turn 编号是分开的）
    for (const event of session.#events) {
      if (event.type === 'turn/start') session.#nextTurn = Math.max(session.#nextTurn, readNumber(event, 'turn') + 1)
      if (event.type === 'step/start') session.#nextStep = Math.max(session.#nextStep, readNumber(event, 'step') + 1)
    }

    // 修复未闭合的 turn
    const lastTurnStart = [...session.#events].reverse().find((event) => event.type === 'turn/start')
    if (lastTurnStart !== undefined) {
      const turn = readNumber(lastTurnStart, 'turn')
      const ended = session.#events.some(
        (event) => event.type === 'turn/end' && readNumber(event, 'turn') === turn,
      )
      if (!ended) session.endTurn(turn, 'error')
    }

    return session
  }
}

/** 从事件里读一个数字字段。读不到就给 -1（不会匹配任何真实编号）。 */
function readNumber(event: SessionEvent, key: string): number {
  const data = event.data
  if (typeof data !== 'object' || data === null) return -1
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : -1
}

// ============================================================
// 四、派生：日志 → 消息
// ============================================================

/**
 * 从事件流派生发送给模型的消息。
 *
 * **只读表面事件。** 这是「Model-visible ⟺ logged」的落地点。
 * @param events 事件流
 * @returns 消息数组
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  // ★ 系统提示词排在最前面，而且**也从日志里派生**（不另存一份状态）。
  //   这样「Model-visible ⟺ logged」对提示词同样成立 ——
  //   排查时可以问："模型当时看到的系统提示词是什么？"并真的答出来。
  const systemPrompt = systemPromptOf(events)
  if (systemPrompt !== '') messages.push({ role: 'system', content: systemPrompt })

  for (const event of events) {
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue

    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>

    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: asText(record['text']) })
        break

      case 'assistant/message': {
        const toolCalls = Array.isArray(record['toolCalls'])
          ? (record['toolCalls'] as readonly ToolCall[])
          : undefined
        messages.push({
          role: 'assistant',
          content: asText(record['content']),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
        })
        break
      }

      case 'tool/result':
        messages.push({
          role: 'tool',
          content: asText(record['content']),
          toolCallId: asText(record['toolCallId']),
          name: asText(record['name']),
        })
        break

      default:
        // 不可达：SURFACE_EVENT_TYPES 已经过滤过了
        break
    }
  }

  return messages
}

/** 把 unknown 取成字符串（不是字符串就给空串）。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 从日志里取出当前生效的系统提示词。
 *
 * 取**最后**一条：模式可以切换（`/mode ptc`），切换时就再写一条事件 ——
 * 于是"什么时候换了提示词、换成什么"是日志里查得到的事实，而不是内存里的隐状态。
 * @param events 事件流
 * @returns 提示词；从未设置过则返回空串
 */
export function systemPromptOf(events: readonly SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'session/system-prompt') continue
    const data = event.data
    if (typeof data !== 'object' || data === null) return ''
    return asText((data as Record<string, unknown>)['text'])
  }
  return ''
}

// ============================================================
// 五、统计
// ============================================================

/** 一次会话的统计。 */
export interface SessionStats {
  /** 完整的 turn 数（由 turn/end 计数）。 */
  readonly turns: number
  /** 完成的 step 数 —— **这就是「平均完成步数」里那个「步数」**。 */
  readonly steps: number
  /** 工具调用次数。 */
  readonly toolCalls: number
  /** 失败的工具调用次数。 */
  readonly toolErrors: number
  /** 累计 token 消耗。 */
  readonly tokens: number
  /** 派生出的消息条数。 */
  readonly messages: number
  /** 失败的尝试次数（第 9 步新增）—— **「这道题重试了几次」的答案**。 */
  readonly attempts: number
  /** 被守卫直接拒绝的次数（第 10 步新增）。 */
  readonly guardDenials: number
  /** 被守卫转人工确认的次数（第 10 步新增）。 */
  readonly guardAsks: number
}

/**
 * 从事件流算统计。
 * @param events 事件流
 * @returns 统计结果
 */
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let tokens = 0
  let attempts = 0
  let guardDenials = 0
  let guardAsks = 0

  for (const event of events) {
    switch (event.type) {
      case 'turn/end':
        turns += 1
        break
      case 'step/end':
        steps += 1
        break
      case 'tool/call':
        toolCalls += 1
        break
      case 'assistant/attempt':
        attempts += 1
        break
      case 'tool/guard': {
        // 只在 deny/ask 时才写这条事件，所以这里不用再按 verdict 过滤
        const verdict = (event.data as Record<string, unknown>)['verdict']
        if (verdict === 'deny') guardDenials += 1
        else if (verdict === 'ask') guardAsks += 1
        break
      }
      case 'tool/result':
        if (typeof event.data === 'object' && event.data !== null
          && (event.data as Record<string, unknown>)['isError'] === true) {
          toolErrors += 1
        }
        break
      case 'assistant/message': {
        const usage = (event.data as Record<string, unknown>)['usage']
        if (typeof usage === 'object' && usage !== null) {
          for (const value of Object.values(usage as Record<string, unknown>)) {
            if (typeof value === 'number') tokens += value
          }
        }
        break
      }
      default:
        break
    }
  }

  return {
    turns,
    steps,
    toolCalls,
    toolErrors,
    tokens,
    attempts,
    guardDenials,
    guardAsks,
    messages: deriveMessages(events).length,
  }
}

// ============================================================
// 六、不变量检查
// ============================================================

/**
 * 检查「模型实际收到的消息」是否与「日志派生的消息」完全一致。
 *
 * 这是「Model-visible ⟺ logged」的**运行时断言**。
 * 上层（第 8 步的循环）应该在每次发请求前调它 —— 一旦不一致，
 * 说明有代码绕过日志直接改了消息，那是必须立刻暴露的 bug。
 * @param session 会话
 * @param actual 实际要发给模型的消息
 * @throws 不一致时抛出，并指出第一处差异
 */
export function assertModelVisibleMatchesLog(
  session: Session,
  actual: readonly ChatMessage[],
): void {
  const derived = session.deriveMessages()

  if (derived.length !== actual.length) {
    throw new Error(
      `Model-visible 与日志不一致：日志派生 ${derived.length} 条消息，实际有 ${actual.length} 条`,
    )
  }

  for (let index = 0; index < derived.length; index += 1) {
    const a = derived[index]
    const b = actual[index]
    if (a === undefined || b === undefined) continue
    if (a.role !== b.role) {
      throw new Error(`Model-visible 与日志不一致：第 ${index} 条消息的角色是 ${b.role}，日志里是 ${a.role}`)
    }
    if (a.content !== b.content) {
      throw new Error(
        `Model-visible 与日志不一致：第 ${index} 条（role=${a.role}）内容不同\n日志：${a.content}\n实际：${b.content}`,
      )
    }
  }
}
