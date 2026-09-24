/**
 * 第 1 步 ｜ 模型层：把「一个 HTTP 接口」包装成「可替换的 Provider」
 *
 * 这一层只做一件事：把一组消息发给模型，拿回一条响应。
 * 它不知道 agent、不知道工具、不知道循环 —— 那些是后面几步的事。
 *
 * 为什么值得单独一个文件？
 *   因为「调用模型」是整个 agent 里唯一必须联网、必须花钱、必须可能失败的动作。
 *   把它关进一个窄接口后面，后面的所有代码都可以脱网测试。
 */

// ============================================================
// 一、消息：agent 与模型之间唯一的语言
// ============================================================

/** 消息的四种角色。这是「联合类型」：只能取这四个字符串之一，写错立刻报错。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 模型要求调用的一个工具。 */
export interface ToolCall {
  /** 本次调用的唯一编号。回灌结果时必须原样带回，模型才知道这是哪次调用的结果。 */
  readonly id: string
  /** 工具名，必须和工具注册表里的名字完全一致。 */
  readonly name: string
  /** 参数（已解析成对象）。解析失败时是空对象。 */
  readonly arguments: Record<string, unknown>
  /** 服务端给的原始参数字符串。解析失败时原样回灌，让模型自己改对。 */
  readonly rawArguments: string
  /** 非空表示参数解析失败，内容是失败原因（回灌给模型看）。 */
  readonly parseError: string
}

/** token 用量。不同厂商字段名不同，所以用「字符串→数字」的开放字典。 */
export type LLMUsage = Record<string, number>

/** 一次模型调用的结果。 */
export interface LLMResponse {
  /** 模型的自然语言输出。只说工具调用时可能是空串。 */
  readonly content: string
  /** 模型要求执行的工具调用。正常回答时是空数组。 */
  readonly toolCalls: readonly ToolCall[]
  /** token 用量，可能为空字典。 */
  readonly usage: LLMUsage
}

/** agent 内部使用的消息结构：camelCase，不绑定任何厂商。 */
export interface ChatMessage {
  role: Role
  content: string
  /** 仅 assistant 使用：模型这一轮要求调用的工具。 */
  toolCalls?: readonly ToolCall[]
  /** 仅 tool 使用：这条结果对应哪次调用。 */
  toolCallId?: string
  /** 仅 tool 使用：工具名。部分厂商的接口需要它。 */
  name?: string
}

// ============================================================
// 二、错误分类：重试策略的地基
// ============================================================

/**
 * 失败分类。
 * 第 5 步的重试策略会直接按这个分类决定「要不要重试、等多久、最多几次」。
 * 现在只需要建立一个观念：不分类的错误，到了重试那一步根本无法做决策。
 */
export type LLMErrorCode =
  /** 限流。等一会儿再来是对的。 */
  | 'RATE_LIMIT'
  /** 服务端 5xx。通常是别人的锅，可重试。 */
  | 'SERVER'
  /** 超时。可重试。 */
  | 'TIMEOUT'
  /** 网络层失败（DNS、连接被重置）。可重试。 */
  | 'TRANSPORT'
  /** 密钥无效或没权限。重试一万次也一样，必须换 key。 */
  | 'AUTH'
  /** 请求本身有问题（模型名写错、参数非法）。重试没用。 */
  | 'INVALID_REQUEST'
  /** 服务端返回 200 但没有内容。网关抖动常见，可重试。 */
  | 'EMPTY_RESPONSE'
  /** 请求被调用方取消。**重试没有意义** —— 那是用户不想要了。 */
  | 'CANCELLED'
  | 'UNKNOWN'

/** 模型层统一抛出的错误。里面的 code 就是上面的分类。 */
export class LLMError extends Error {
  readonly code: LLMErrorCode
  /** HTTP 状态码；不是 HTTP 失败时是 undefined。 */
  readonly status: number | undefined
  /** 服务端通过 Retry-After 指定的等待毫秒数；没给就是 undefined。 */
  readonly retryAfterMs: number | undefined

  constructor(
    code: LLMErrorCode,
    message: string,
    extra: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    // cause 是 ES2022 的 Error 选项：把底层错误挂在身上，打印时能追到根因。
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'LLMError'
    this.code = code
    this.status = extra.status
    this.retryAfterMs = extra.retryAfterMs
  }
}

// ============================================================
// 三、线格式翻译：厂商细节只出现在这一个函数里
// ============================================================

/**
 * 把内部消息翻译成 OpenAI 兼容的「线格式」（wire format）。
 * DeepSeek / OpenAI / vLLM / Ollama 的兼容端口都用这一套字段名。
 *
 * 为什么要多这一层？以后换厂商、换版本、加字段，只改这一个函数，
 * 而不是把 snake_case 掺进整个 agent 的内部结构。
 */
export function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            // 优先回原样：模型上次给的就是这段字符串，改写了可能反而对不上。
            arguments: call.rawArguments !== '' ? call.rawArguments : JSON.stringify(call.arguments),
          },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}

// ============================================================
// 四、参数解析：模型给的 arguments 是一个 JSON 字符串
// ============================================================

/**
 * 把 tool_call.function.arguments 解析成对象。
 * @returns value 是解析结果（失败时为空对象）；error 非空表示失败原因。
 */
export function parseArguments(raw: unknown): { value: Record<string, unknown>; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: {}, error: '' }
  }
  if (typeof raw === 'object') {
    return { value: raw as Record<string, unknown>, error: '' }
  }
  if (typeof raw !== 'string') {
    return { value: {}, error: `arguments 既不是字符串也不是对象，而是 ${typeof raw}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { value: {}, error: `arguments 不是合法 JSON：${reason}` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const actual = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
    return { value: {}, error: `arguments 必须是 JSON 对象，实际是 ${actual}` }
  }
  return { value: parsed as Record<string, unknown>, error: '' }
}

/** 把线格式里的一条 tool_call 转成内部 ToolCall。越界输入在这里被挡住。 */
function toToolCall(item: unknown, index: number): ToolCall {
  const record = asRecord(item)
  const fn = asRecord(record.function)
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : `call_${index}`
  const name = typeof fn.name === 'string' ? fn.name : ''
  const raw = typeof fn.arguments === 'string' ? fn.arguments : ''
  const parsed = parseArguments(fn.arguments)
  return {
    id,
    name,
    arguments: parsed.value,
    rawArguments: raw !== '' ? raw : JSON.stringify(parsed.value),
    parseError: parsed.error,
  }
}

/** 把 unknown 收窄成「字符串键的对象」；不是对象就给空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

// ============================================================
// 五、Provider：整个 agent 里最重要的一个抽象
// ============================================================

/** 任何模型后端的统一接口。agent 只认这个接口，不认具体厂商。 */
export interface Provider {
  /**
   * 发一轮请求。
   * @param messages 到目前为止的全部对话（模型本身是无状态的，每次都全发）。
   * @param tools 模型可用的工具 schema 列表；不传表示这轮不给工具。
   * @param signal 第 8 步新增：取消信号。调用方中止时请求应尽快结束。
   */
  chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
    signal?: AbortSignal,
  ): Promise<LLMResponse>
}

// ------------------------------------------------------------
// 5.1 MockProvider：离线跑通全流程用它
// ------------------------------------------------------------

/** 脚本里的一步：模型这一轮「打算」做什么。 */
export interface MockStep {
  content?: string
  toolCalls?: { name: string; arguments?: Record<string, unknown> | string }[]
  usage?: LLMUsage
}

/**
 * 按预设脚本逐条返回响应，不联网、不花钱、结果完全确定。
 * 测试和演示都用它；真实调用出问题时，它还是最好的「分诊工具」：
 * 换回 mock 后 bug 还在，说明问题在 agent 而不在模型。
 */
export class MockProvider implements Provider {
  #script: MockStep[]
  /** 每次调用收到的消息快照。用来断言「模型到底看到了什么」。 */
  readonly seenMessages: ChatMessage[][] = []
  /** 每次调用收到的工具 schema。 */
  readonly seenTools: Record<string, unknown>[][] = []

  constructor(script: readonly MockStep[]) {
    this.#script = [...script]
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    // 取消检查：mock 也必须遵守取消语义，否则第 8 步的取消路径就测不出来
    if (signal?.aborted === true) {
      throw new LLMError('CANCELLED', '请求在开始前已被取消')
    }

    this.seenMessages.push(messages.map((message) => ({ ...message })))
    this.seenTools.push([...(tools ?? [])])

    const step = this.#script.shift()
    if (step === undefined) {
      throw new LLMError('EMPTY_RESPONSE', 'mock 脚本已用完，但 agent 还在请求下一步')
    }

    // mock 也走和真实响应完全相同的解析路径，这样演示里出现的结构一定是真的。
    const wireToolCalls = (step.toolCalls ?? []).map((call) => ({
      id: '',
      function: {
        name: call.name,
        arguments: typeof call.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
      },
    }))

    return {
      content: step.content ?? '',
      toolCalls: wireToolCalls.map((item, index) => toToolCall(item, index)),
      usage: step.usage ?? {},
    }
  }
}

// ------------------------------------------------------------
// 5.2 DeepSeekProvider：真实调用
// ------------------------------------------------------------

/** DeepSeekProvider 的构造参数。 */
export interface DeepSeekProviderOptions {
  /** API key。绝不写进代码，从环境变量读。 */
  apiKey: string
  /** 接口根地址。默认官方地址。 */
  baseUrl?: string
  /** 模型名。 */
  model?: string
  /** 采样温度。0 最确定，适合 agent。 */
  temperature?: number
  /** 单次请求超时毫秒数。 */
  timeoutMs?: number
}

/** 通过 OpenAI 兼容的 /chat/completions 接口调用 DeepSeek。 */
export class DeepSeekProvider implements Provider {
  #apiKey: string
  #baseUrl: string
  #model: string
  #temperature: number
  #timeoutMs: number

  constructor(options: DeepSeekProviderOptions) {
    this.#apiKey = options.apiKey
    // rstrip 掉结尾斜杠，避免拼出 //chat/completions
    this.#baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.#model = options.model ?? 'deepseek-chat'
    this.#temperature = options.temperature ?? 0
    this.#timeoutMs = options.timeoutMs ?? 120_000
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: toWireMessages(messages),
      temperature: this.#temperature,
    }
    if (tools !== undefined && tools.length > 0) {
      body.tools = tools
      // auto：让模型自己决定这轮是回答问题还是调用工具。
      body.tool_choice = 'auto'
    }

    // 把「本地超时」和「外部取消」两个信号合起来 —— 任何一个触发都会中止请求
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal])

    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        // AbortSignal.timeout 到点自动中断请求，抛出的错误 name 是 TimeoutError。
        signal: combined,
      })
    } catch (cause) {
      throw toTransportError(cause, this.#timeoutMs)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new LLMError(
        codeForStatus(response.status),
        `HTTP ${response.status} ${response.statusText} <- ${this.#baseUrl}/chat/completions\n${text.slice(0, 800)}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        },
      )
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (cause) {
      throw new LLMError('INVALID_REQUEST', `响应不是合法 JSON：${text.slice(0, 400)}`, { cause })
    }
    return parseCompletion(data)
  }
}

/** HTTP 状态码 → 失败分类。这张表就是「重试有没有意义」的判据。 */
function codeForStatus(status: number): LLMErrorCode {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 401 || status === 403) return 'AUTH'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'INVALID_REQUEST'
  return 'UNKNOWN'
}

/** 网络层异常 → 失败分类。 */
function toTransportError(cause: unknown, timeoutMs: number): LLMError {
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'TimeoutError') {
    return new LLMError('TIMEOUT', `请求超过 ${timeoutMs}ms 未完成`, { cause })
  }
  if (name === 'AbortError') {
    // 第 8 步修正：外部取消不该被当作「可重试的传输错误」——
    // 用户不想要了，重试毫无意义（第 1 步 L9 缺陷 2 的修复）
    return new LLMError('CANCELLED', '请求被取消', { cause })
  }
  return new LLMError('TRANSPORT', `连接失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
}

/** 解析 Retry-After 响应头。它可能是秒数，也可能是 HTTP 日期。 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/** 把 /chat/completions 的响应体解析成 LLMResponse。 */
function parseCompletion(data: unknown): LLMResponse {
  const record = asRecord(data)
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    const error = record.error
    throw new LLMError(
      'EMPTY_RESPONSE',
      error === undefined ? '响应缺少 choices 字段' : `服务端返回错误：${JSON.stringify(error)}`,
    )
  }

  const message = asRecord(asRecord(choices[0]).message)
  const rawContent = message.content
  const content = typeof rawContent === 'string' ? rawContent : ''
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  return {
    content,
    toolCalls: rawToolCalls.map((item, index) => toToolCall(item, index)),
    usage: toUsage(message.usage),
  }
}

/** 只保留数字字段的用量字典。 */
function toUsage(value: unknown): LLMUsage {
  const out: LLMUsage = {}
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === 'number') out[key] = entry
  }
  return out
}
