/**
 * 能力插件 ① ｜ llm：把第 1 步的模型层挂成一个**服务**
 *
 * 到第 6 步为止，`MockProvider` / `DeepSeekProvider` 只能靠 `new` 拿到。
 * 第 8 步的循环要发请求，就得自己 import 具体类 —— 也就是说
 * **换 provider 必须改循环的代码**。这正是第 3 步要消灭的那类耦合。
 *
 * 这个插件的职责只有三件：
 *   1. 把配置（JSON 里的几行）**解析成一份明确的 Spec** —— 缺 key、provider
 *      名字写错这类问题在这里就炸，而不是等到第一次请求
 *   2. 按 Spec 造出 provider，注册成服务 `llm`
 *   3. 包一层，把「请求 / 响应 / 失败」变成事件 —— 让别的插件能**观察**
 *      模型调用（第 12–15 步的进化层全靠这个）
 *
 * ── 为什么"解析 Spec"要单独一步？────────────────────────────────────────
 *
 * 「显式 > 隐式」：默认值不能散在 `chat()` 里写成 `config.temperature ?? 0.7`。
 * 那样一来，"这次跑用的是哪个温度"只有读过那一行才知道。解析成 Spec 之后，
 * 生效值是一个可以被打印、被 dump、被断言的**对象**。
 */

import { DeepSeekProvider, MockProvider } from '../kernel/llm.ts'
import { LLMError } from '../kernel/llm.ts'
import type { ChatMessage, LLMResponse, MockStep, Provider } from '../kernel/llm.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 即将发出一次模型请求。 */
    'llm/request': { model: string; messages: number; tools: number }
    /** 模型返回了一次响应。 */
    'llm/response': { model: string; contentLength: number; toolCalls: number }
    /** 模型请求失败（**包含会被重试的那些**，重试决策收不到这个事件）。 */
    'llm/error': { model: string; code: string; message: string }
  }
}

/** 配置文件里这一段能写什么。 */
export interface LLMConfig {
  /** `mock`（离线）或 `deepseek`（真实调用）。默认 `mock`。 */
  readonly provider?: string
  /** 模型名。mock 模式下只是标签；deepseek 模式下是真正要发的 model。 */
  readonly model?: string
  /** 从哪个环境变量读 API key。默认 `DEEPSEEK_API_KEY`。 */
  readonly apiKeyEnv?: string
  /** 接口根地址。 */
  readonly baseUrl?: string
  /** 采样温度。 */
  readonly temperature?: number
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number
  /** mock 模式的脚本 —— 第 1 步的 `MockStep[]` 直接写进 JSON。 */
  readonly script?: readonly MockStep[]
}

/** 解析后的模型配置：**生效值**，不再含默认值推断。 */
export interface LLMSpec {
  readonly kind: 'mock' | 'deepseek'
  readonly model: string
  readonly apiKeyEnv: string
  readonly apiKey: string | undefined
  readonly baseUrl: string | undefined
  readonly temperature: number | undefined
  readonly timeoutMs: number | undefined
  readonly script: readonly MockStep[]
}

/** 默认的 key 环境变量名。 */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * 把配置解析成 Spec，并在这里做**全部**校验。
 *
 * @param config 配置段（可以整段缺失）
 * @returns 生效的 Spec
 * @throws provider 名字不认识、deepseek 模式缺 key、script 不是数组
 */
export function resolveLLMSpec(config: LLMConfig | undefined): LLMSpec {
  const raw = config ?? {}
  const kind = raw.provider ?? 'mock'

  if (kind !== 'mock' && kind !== 'deepseek') {
    throw new Error(`llm 插件：未知的 provider "${kind}"；只支持 mock / deepseek`)
  }

  const apiKeyEnv = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const apiKey = process.env[apiKeyEnv]

  // ★ 缺 key 在**装载时**就炸，而不是等到第一次请求
  if (kind === 'deepseek' && (apiKey === undefined || apiKey === '')) {
    throw new Error(
      `llm 插件：provider=deepseek 需要环境变量 ${apiKeyEnv}，当前为空。` +
        '（想离线跑请把 provider 设为 mock）',
    )
  }

  const script = raw.script ?? []
  if (!Array.isArray(script)) {
    throw new Error('llm 插件：config.script 必须是数组')
  }

  return {
    kind,
    model: raw.model ?? (kind === 'mock' ? 'mock' : 'deepseek-chat'),
    apiKeyEnv,
    apiKey,
    baseUrl: raw.baseUrl,
    temperature: raw.temperature,
    timeoutMs: raw.timeoutMs,
    script,
  }
}

/**
 * 给 provider 包一层事件上报。
 *
 * ★ 为什么用包装而不是改 provider 类？★
 * 因为事件是**框架层**的概念，而 `kernel/llm.ts` 是纯能力层 ——
 * 让它认识 `ctx.emit` 会把依赖方向反过来（课程主线 1）。
 * 包装器住在 plugins 层，正好在两边都能碰到的位置上。
 * @param inner 真正的 provider
 * @param model 模型名（只用于事件与报错）
 * @param emit 事件出口
 * @returns 同接口的 provider
 */
function instrument(
  inner: Provider,
  model: string,
  emit: (name: 'llm/request' | 'llm/response' | 'llm/error', payload: unknown) => Promise<unknown>,
): Provider {
  return {
    async chat(
      messages: readonly ChatMessage[],
      tools?: readonly Record<string, unknown>[],
      signal?: AbortSignal,
    ): Promise<LLMResponse> {
      await emit('llm/request', { model, messages: messages.length, tools: tools?.length ?? 0 })
      try {
        const response = await inner.chat(messages, tools, signal)
        await emit('llm/response', {
          model,
          contentLength: response.content.length,
          toolCalls: response.toolCalls.length,
        })
        return response
      } catch (error) {
        const code = error instanceof LLMError ? error.code : 'UNKNOWN'
        await emit('llm/error', {
          model,
          code,
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
}

/** llm 插件。 */
export const llmPlugin: Plugin = {
  name: 'llm',
  apply(ctx, config) {
    const spec = resolveLLMSpec(config as LLMConfig | undefined)

    const inner: Provider = spec.kind === 'mock'
      ? new MockProvider(spec.script)
      : new DeepSeekProvider({
          apiKey: spec.apiKey as string,
          ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
          model: spec.model,
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
          ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        })

    const provider = instrument(inner, spec.model, async (name, payload) => {
      await ctx.emit(name, payload as never)
    })

    ctx.provide('llm', provider)
    ctx.provide('llm/spec', spec)

    console.log(`[llm] 已装载：${spec.kind}（model=${spec.model}）`)
  },
}

export default llmPlugin
