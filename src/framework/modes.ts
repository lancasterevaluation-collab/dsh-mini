/**
 * 模式（agent preset）：把"这个 agent 是什么"变成一份可替换的声明
 *
 * 对照 DSH 的四个 preset（Standard / PTC / Minimal / Creator），
 * 它们共享同一个 agent 循环，区别只在**装了哪些工具、给了什么提示词、限制多严**。
 * DSH 把这件事写成了声明式配置（`.agents/notes/implemented/architecture/
 * 2026-09-18-declarative-agent-presets.md`）。
 *
 * 这个文件是它的简化版：**一个模式就是一份 JSON**。
 *
 *     modes/ptc.json  →  { id, name, description, prompt, tools, llm, guard, limits }
 *
 * ── ★ 为什么不是"再叠一层 patch"，而是"加工最终行" ★ ────────────────
 *
 * 第 6 步的 `patch` 语义是**整段替换 config**。而模式只想调几个字段
 * （工具列表、步数上限、温度），不想重写别人设的 `workspace`、`savePath`。
 * 两条路都试过：
 *
 *   · 让模式生成 patch → 必须写出**完整** config → 5 个模式要复制 5 份
 *     `workspace` / `savePath`，改一处忘一处是必然的
 *   · 把 patch 改成深合并 → 破坏"整段替换"这条已经写进文档、也被
 *     `bad-id` 这类测试依赖的规则
 *
 * 所以走了第三条：`loadProfile` 暴露一个 `transformRows` 钩子，
 * 模式拿到**已经合并好的行**，只改它关心的字段。代价是这一步不参与
 * patch 的层叠计算 —— 但它发生在最后，所以 `dump()` 看到的仍是最终结果。
 *
 * ── 模式能控制什么，不能控制什么 ★ ────────────────────────────────────
 *
 * 能：工具集、系统提示词、技能子集、模型参数、守卫策略、步数上限
 * 不能：换掉 provider（那是 profile 的事，模式不该决定用哪个厂商）
 *
 * 这条边界是刻意的：模式是"**能力组合**"，provider 是"**部署决定**"。
 * 把它们混在一起，"换模型"就会变成"换模式"，两件不同频率的事被绑死了。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PluginRow } from './loader.ts'

/** 模式声明（一个 `modes/*.json` 文件）。 */
export interface ModeDecl {
  /** 模式 id，`--mode` 用的就是它。 */
  readonly id: string
  /** 显示名。 */
  readonly name: string
  /** 一句话说明"什么时候该用它"。 */
  readonly description: string
  /** 是不是内置模式（内置的不能删，但可以复制成自定义的）。 */
  readonly builtin: boolean
  /** 提示词文件名（相对 `prompts/`）。 */
  readonly prompt: string
  /** 这个模式下**可见的工具名**（顺序即装配顺序）。 */
  readonly tools: readonly string[]
  /** 技能子集；空数组 = 全部可见。 */
  readonly skills: readonly string[]
  /** 这个模式下**禁用**哪些插件行（例如只有多智能体模式才需要 `multi-agent` 插件）。 */
  readonly disable?: readonly string[]
  /** 合进 `llm` 行的配置（例如 `temperature`）。 */
  readonly llm: Readonly<Record<string, unknown>>
  /** 合进 `guard` 行的配置（例如 `approve`）。 */
  readonly guard: Readonly<Record<string, unknown>>
  /** 合进 `agent-loop` 行的配置。 */
  readonly limits: { readonly maxSteps?: number }
}

/** 给界面用的模式摘要。 */
export interface ModeSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly builtin: boolean
  readonly tools: readonly string[]
  readonly maxSteps: number | undefined
  readonly promptBytes: number
}

/** 内置模式的 id 与文件名顺序。 */
export const BUILTIN_MODES: readonly string[] = ['standard', 'ptc', 'minimal', 'creator', 'multi-agent']

/**
 * 校验并归一化一份模式声明。
 *
 * 全部字段在这里检查：宁可装载时报错，也不要让一个字段名写错的模式
 * "看起来装上了但什么都没生效" —— 那是最难查的一类故障。
 * @param raw 从 JSON 读到的原始值
 * @param source 来源（报错时指出是哪个文件）
 * @returns 归一化后的声明
 * @throws 缺字段、类型不对时
 */
export function parseModeDecl(raw: unknown, source: string): ModeDecl {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`模式文件不是对象：${source}`)
  }
  const record = raw as Record<string, unknown>

  const id = record['id']
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`模式文件缺少 id：${source}`)
  }

  const tools = record['tools']
  if (!Array.isArray(tools) || tools.some((item) => typeof item !== 'string')) {
    throw new Error(`模式 ${id} 的 tools 必须是字符串数组：${source}`)
  }

  const skills = record['skills']
  if (skills !== undefined && (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string'))) {
    throw new Error(`模式 ${id} 的 skills 必须是字符串数组：${source}`)
  }

  const limits = record['limits']
  if (limits !== undefined && (typeof limits !== 'object' || limits === null)) {
    throw new Error(`模式 ${id} 的 limits 必须是对象：${source}`)
  }
  const maxSteps = (limits as Record<string, unknown> | undefined)?.['maxSteps']
  if (maxSteps !== undefined && (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1)) {
    throw new Error(`模式 ${id} 的 limits.maxSteps 必须是正整数：${source}`)
  }

  const asObject = (value: unknown, field: string): Record<string, unknown> => {
    if (value === undefined) return {}
    if (typeof value !== 'object' || value === null) {
      throw new Error(`模式 ${id} 的 ${field} 必须是对象：${source}`)
    }
    return value as Record<string, unknown>
  }

  const disable = record['disable']
  if (disable !== undefined && (!Array.isArray(disable) || disable.some((item) => typeof item !== 'string'))) {
    throw new Error(`模式 ${id} 的 disable 必须是字符串数组：${source}`)
  }

  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] : id,
    description: typeof record['description'] === 'string' ? record['description'] : '',
    builtin: record['builtin'] === true,
    prompt: typeof record['prompt'] === 'string' ? record['prompt'] : `${id}.md`,
    tools: tools as readonly string[],
    skills: (skills as readonly string[] | undefined) ?? [],
    disable: (disable as readonly string[] | undefined) ?? [],
    llm: asObject(record['llm'], 'llm'),
    guard: asObject(record['guard'], 'guard'),
    limits: maxSteps === undefined ? {} : { maxSteps: maxSteps as number },
  }
}

/**
 * 读一个目录下的全部模式。
 * @param dir 模式目录
 * @returns 模式列表（按 id 排序）
 * @throws 目录不可读、或某个文件格式不对时
 */
export async function loadModes(dir: string): Promise<ModeDecl[]> {
  const absolute = resolve(dir)
  const entries = await readdir(absolute, { withFileTypes: true })
  const modes: ModeDecl[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(absolute, entry.name)
    const text = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      throw new Error(`模式文件不是合法 JSON：${path}\n${cause instanceof Error ? cause.message : ''}`)
    }
    modes.push(parseModeDecl(parsed, path))
  }

  modes.sort((a, b) => a.id.localeCompare(b.id))
  return modes
}

/**
 * 读一个模式的提示词文件。
 * @param promptsDir 提示词目录
 * @param decl 模式声明
 * @returns 提示词全文
 * @throws 文件不存在时（**不静默给空串** —— 那会让模式看起来没生效）
 */
export async function loadModePrompt(promptsDir: string, decl: ModeDecl): Promise<string> {
  const path = resolve(promptsDir, decl.prompt)
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    throw new Error(`模式 ${decl.id} 的提示词读不到：${path}`)
  }
}

/** 模式作用到行列表上的结果。 */
export interface ModeApplication {
  readonly rows: readonly PluginRow[]
  /** 每个被改动的行：id → 改了哪些字段（给"这个模式装了什么"的展示用）。 */
  readonly touched: Readonly<Record<string, readonly string[]>>
}

/**
 * 把一份模式声明合进已经合并好的行列表。
 *
 * 它**只改自己关心的字段**，其余一律不动 —— 所以模式和 profile / patch
 * 是正交的：profile 决定装哪些插件、模式决定这些插件怎么配。
 * @param rows 合并后的行
 * @param decl 模式声明
 * @param promptText 该模式的提示词全文
 * @returns 加工后的行 + 改动记录
 */
export function applyMode(rows: readonly PluginRow[], decl: ModeDecl, promptText: string): ModeApplication {
  const touched: Record<string, string[]> = {}
  const disabledIds = new Set(decl.disable ?? [])

  const next = rows.map((row): PluginRow => {
    const shouldDisable = disabledIds.has(row.id)
    const config = { ...(row.config ?? {}) }
    const keys: string[] = []

    if (shouldDisable) {
      // ① 禁用优先：模式说"不要这个插件"，就不该再往它身上写配置
      if (row.disabled !== true) keys.push('disabled')
    } else {
      // ② 没被禁用的行：先把它打开（用于"默认关、某个模式才开"的插件）
      if (row.disabled === true) keys.push('enabled')

      if (row.id === 'tools') {
        config['builtin'] = decl.tools
        keys.push('builtin')
      } else if (row.id === 'llm') {
        for (const [key, value] of Object.entries(decl.llm)) {
          config[key] = value
          keys.push(`llm.${key}`)
        }
      } else if (row.id === 'guard') {
        for (const [key, value] of Object.entries(decl.guard)) {
          config[key] = value
          keys.push(`guard.${key}`)
        }
      } else if (row.id === 'agent-loop' && decl.limits.maxSteps !== undefined) {
        config['maxSteps'] = decl.limits.maxSteps
        keys.push('maxSteps')
      } else if (row.id === 'prompt') {
        config['text'] = promptText
        config['mode'] = decl.id
        keys.push('text', 'mode')
      }
    }

    if (keys.length === 0) return row
    touched[row.id] = keys
    return {
      ...row,
      config,
      // 只在这一行的开关状态**确实变了**时才写 disabled 字段
      ...(shouldDisable ? { disabled: true } : row.disabled === true ? { disabled: false } : {}),
    }
  })

  return { rows: next, touched }
}

/** 生成给界面看的摘要。 */
export function summarizeMode(decl: ModeDecl, promptText: string): ModeSummary {
  return {
    id: decl.id,
    name: decl.name,
    description: decl.description,
    builtin: decl.builtin,
    tools: decl.tools,
    maxSteps: decl.limits.maxSteps,
    promptBytes: Buffer.byteLength(promptText, 'utf8'),
  }
}
