/**
 * 提示词插件：把系统提示词变成**一个可装配的组件**
 *
 * 在这之前，agent 没有系统提示词 —— 消息从 `user/message` 开始。
 * 而"模式"的核心之一就是**给模型一套不同的人格与约束**（PTC 要教它什么时候写程序、
 * Minimal 要提醒它只有一个 shell、Multi-agent 要讲清怎么派发子任务）。
 *
 * ── 为什么提示词要单独成插件，而不是塞进 agent-loop 的配置 ★ ──────────
 *
 * 因为它是**可替换的组件**：模式系统（`framework/modes.ts`）靠 `applyMode()`
 * 往 `id: "prompt"` 那一行写 `{ text, mode }`。如果提示词躲在 agent-loop 的
 * config 里，模式就得知道 agent-loop 的内部字段名 —— 那是耦合。
 * 做成独立一行之后，模式只认"prompt 这一行"，谁提供它、怎么用它都与模式无关。
 *
 * ── 提示词从哪来 ★ ────────────────────────────────────────────────────
 *
 * 配置里给的是**全文**（不是文件路径）：模式在装载前已经把 `prompts/<mode>.md`
 * 读出来了（见 `applyMode`）。这样做的原因和第 14 步的技能库一样 ——
 * 文件是给人编辑的，而插件配置里应该放"已经确定的生效值"。
 */

import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 系统提示词被设置。 */
    'prompt/set': { mode: string; bytes: number }
  }
}

/** 配置文件里这一段能写什么。 */
export interface PromptConfig {
  /** 提示词全文。 */
  readonly text?: string
  /** 它来自哪个模式（只用于显示与排查）。 */
  readonly mode?: string
}

/** 解析后的提示词配置。 */
export interface PromptSpec {
  readonly text: string
  readonly mode: string
}

/**
 * 解析提示词配置。
 * @param config 配置段
 * @returns 生效的 Spec（没配就是空提示词）
 */
export function resolvePromptSpec(config: PromptConfig | undefined): PromptSpec {
  const raw = config ?? {}
  return {
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    mode: typeof raw.mode === 'string' ? raw.mode : 'default',
  }
}

/** prompt 插件。 */
export const promptPlugin: Plugin = {
  name: 'prompt',
  apply(ctx, config) {
    const spec = resolvePromptSpec(config as PromptConfig | undefined)

    ctx.provide('prompt', spec.text)
    ctx.provide('prompt/mode', spec.mode)

    void ctx.emit('prompt/set', { mode: spec.mode, bytes: Buffer.byteLength(spec.text, 'utf8') })
    console.log(
      `[prompt] 已装载：模式=${spec.mode}，${spec.text === '' ? '（空提示词）' : `${spec.text.length} 字符`}`,
    )
  },
}

export default promptPlugin
