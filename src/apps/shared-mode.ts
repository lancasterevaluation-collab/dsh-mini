/**
 * 模式的应用层粘合：把 `--mode <id>` 变成一个装载钩子
 *
 * 三个界面（`cli.ts` / `repl.ts` / `web.ts`）都要做同样三件事：
 *
 *   1. 读 `modes/<id>.json` 与它引用的 `prompts/<file>.md`
 *   2. 把它们变成 `loadProfile` 的 `transformRows` 钩子
 *   3. 把"这个模式装了什么"展示出来
 *
 * 所以放在这里统一实现 —— 界面只负责解析自己的参数。
 * 这也让"自定义装配"只需要一个入口：**写一个新的模式文件**，
 * 三个界面立刻都能用，不需要各自加代码。
 *
 * ── 为什么模式是文件（`modes/*.json`），而不是记账在别处 ★ ────────────
 *
 * 因为"装配"这件事需要**可 diff、可分享、可版本化**。
 * 存在内存里（或数据库里）的话，"我上次那个配置挺好"就没法给别人。
 * DSH 的 preset 也是这个立场：编辑就是写 profile patch。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { applyMode, loadModePrompt, loadModes, summarizeMode } from '../framework/modes.ts'
import type { ModeDecl, ModeSummary } from '../framework/modes.ts'
import type { PluginRow } from '../framework/loader.ts'

/** 本文件所在目录（`src/apps`）。 */
const HERE = import.meta.dirname

/** 模式目录。 */
export const MODES_DIR = resolve(HERE, '..', '..', 'modes')

/** 提示词目录。 */
export const PROMPTS_DIR = resolve(HERE, '..', '..', 'prompts')

/** 不给 `--mode` 时用哪个。 */
export const DEFAULT_MODE = 'standard'

/** 一个解析好的模式。 */
export interface ResolvedMode {
  readonly decl: ModeDecl
  readonly summary: ModeSummary
  /** 提示词全文（展示用）。 */
  readonly promptText: string
  /**
   * 交给 `loadProfile` 的加工钩子。
   *
   * 它是**有状态**的：调用一次就记下"改了哪些字段"，供 `touched` 读。
   * 之所以不纯函数化，是因为 loader 的钩子签名不允许回传额外信息，
   * 而调用方（CLI 的 dump、GUI 的面板）需要那份"改了什么"。
   */
  readonly transformRows: (rows: readonly PluginRow[]) => readonly PluginRow[]
  /** 上一次 `transformRows` 改动的字段（行 id → 字段名）。 */
  touched: Record<string, readonly string[]>
}

/**
 * 列出所有可用模式（含提示词字节数）。
 * @returns 摘要列表
 */
export async function listModes(): Promise<readonly ModeSummary[]> {
  const modes = await loadModes(MODES_DIR)
  return await Promise.all(
    modes.map(async (decl) => summarizeMode(decl, await loadModePrompt(PROMPTS_DIR, decl))),
  )
}

/** 带提示词全文的模式条目（装配面板要显示/编辑它）。 */
export interface DetailedMode extends ModeSummary {
  readonly promptText: string
  readonly llm: Readonly<Record<string, unknown>>
  readonly guard: Readonly<Record<string, unknown>>
  readonly disabled: readonly string[]
}

/**
 * 列出模式，并带上"装配面板要编辑的字段"。
 *
 * 为什么不做成"按需取单个"：装配面板打开时要一次性铺出全部起点，
 * 而每个模式的提示词也就 1–2 KB —— 五次请求不如一次拿全。
 * @returns 详细列表
 */
export async function listModesDetailed(): Promise<readonly DetailedMode[]> {
  const modes = await loadModes(MODES_DIR)
  return await Promise.all(
    modes.map(async (decl) => {
      const promptText = await loadModePrompt(PROMPTS_DIR, decl)
      return {
        ...summarizeMode(decl, promptText),
        promptText,
        llm: decl.llm,
        guard: decl.guard,
        disabled: decl.disable ?? [],
      }
    }),
  )
}

/**
 * 解析一个模式。
 * @param modeId 模式 id；不给就用 {@link DEFAULT_MODE}
 * @returns 解析结果
 * @throws 模式不存在、或它的提示词读不到时
 */
export async function resolveMode(modeId: string | undefined): Promise<ResolvedMode> {
  const id = modeId ?? DEFAULT_MODE
  const modes = await loadModes(MODES_DIR)
  const decl = modes.find((item) => item.id === id)

  if (decl === undefined) {
    throw new Error(`没有这个模式："${id}"；可用：${modes.map((item) => item.id).join(', ')}`)
  }

  const promptText = await loadModePrompt(PROMPTS_DIR, decl)
  const touched: Record<string, readonly string[]> = {}

  const resolved: ResolvedMode = {
    decl,
    summary: summarizeMode(decl, promptText),
    promptText,
    touched,
    transformRows: (rows) => {
      const result = applyMode(rows, decl, promptText)
      // 记录改动（覆盖式：transformRows 只会被 loader 调用一次）
      for (const [key, value] of Object.entries(result.touched)) touched[key] = value
      return result.rows
    },
  }

  return resolved
}

/** 自定义模式的入参（装配面板传上来的）。 */
export interface CustomModeDraft {
  /** 模式 id（会变成文件名，必须安全）。 */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tools: readonly string[]
  readonly maxSteps: number
  readonly promptText: string
}

/** 合法 id：小写字母数字与连字符，必须以字母数字开头。 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,40}$/

/**
 * 保存一个自定义模式（装配面板的落盘动作）。
 *
 * 它写两个文件：`modes/<id>.json` 与 `prompts/custom-<id>.md`。
 * 于是"用户装配出来的东西"和内置模式**格式完全一致** ——
 * 可以直接发给人、可以用 `--mode` 用、也可以复制成新的。
 * @param draft 装配面板给的内容
 * @returns 保存后的模式 id
 * @throws id 非法、或字段不合法时
 */
export async function saveCustomMode(draft: CustomModeDraft): Promise<string> {
  const id = draft.id.trim().toLowerCase()
  if (!SAFE_ID.test(id)) {
    throw new Error(`模式 id 只能是小写字母、数字与连字符（2–41 个字符）：${draft.id}`)
  }
  if (draft.tools.length === 0) {
    throw new Error('自定义模式至少要选一个工具。')
  }
  if (!Number.isInteger(draft.maxSteps) || draft.maxSteps < 1 || draft.maxSteps > 64) {
    throw new Error('maxSteps 必须是 1–64 的整数。')
  }

  const modeId = `custom-${id}`
  const promptFile = `${modeId}.md`
  const decl: ModeDecl = {
    id: modeId,
    name: draft.name.trim() === '' ? modeId : draft.name.trim(),
    description: draft.description.trim(),
    builtin: false,
    prompt: promptFile,
    tools: draft.tools,
    skills: [],
    // 自定义模式一律不装 multi-agent —— 需要派发的话从 multi-agent 模式复制改
    disable: ['multi-agent'],
    llm: { temperature: 0 },
    guard: { rules: ['loop', 'irreversible', 'quota', 'path'], maxCalls: 12, approve: [] },
    limits: { maxSteps: draft.maxSteps },
  }

  await mkdir(MODES_DIR, { recursive: true })
  await mkdir(PROMPTS_DIR, { recursive: true })
  await writeFile(join(PROMPTS_DIR, promptFile), draft.promptText.trim() + '\n', 'utf8')
  await writeFile(join(MODES_DIR, `${modeId}.json`), `${JSON.stringify(decl, null, 2)}\n`, 'utf8')

  return modeId
}

/**
 * 读一个模式文件（给界面展示"它是怎么写的"）。
 * @param modeId 模式 id
 * @returns 原始 JSON 文本
 * @throws 文件不存在时
 */
export async function readModeFile(modeId: string): Promise<string> {
  if (!SAFE_ID.test(modeId.replace(/^custom-/, '')) && !SAFE_ID.test(modeId)) {
    throw new Error(`非法的模式 id：${modeId}`)
  }
  return await readFile(join(MODES_DIR, `${modeId}.json`), 'utf8')
}
