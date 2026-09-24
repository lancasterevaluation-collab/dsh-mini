/**
 * 第 6 步 ｜ 配置装载器：把「装哪些插件」从代码变成数据
 *
 * 到第 5 步为止，装配还是写在代码里：
 *
 *     const root = new Context('root')
 *     await root.plugin(llmPlugin)
 *     await root.plugin(toolsPlugin)
 *     root.isolate('tools', readOnly)
 *
 * 想换一个 provider 的配置、想加一个插件、想把「开发模式」和「生产模式」分开
 * —— 全都要改代码。
 *
 * 这一步做三件事：
 *   ① 定义数据格式（bundle / profile / patch）
 *   ② 把层叠规则实现出来（后写覆盖先写，按 id 定位，**整段替换 config**）
 *   ③ 提供 dump —— 打印最终生效的配置
 *
 * 第 ③ 件最容易被忽略，但它决定了这个配置系统**可不可调试**：
 * 「改了配置但没生效」是配置系统最经典的故障，而 dump 是唯一的解药。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from './context.ts'
import type { Disposer, Plugin } from './context.ts'

// ============================================================
// 一、配置的数据格式
// ============================================================

/** 配置里的一行：一个插件 + 它的配置。 */
export interface PluginRow {
  /** 行 id。**全树唯一**，patch 就是靠它定位的。 */
  readonly id: string
  /** 插件模块路径，相对于 profile 文件所在目录。 */
  readonly plugin: string
  /** 传给插件 apply 的配置。 */
  readonly config?: Record<string, unknown>
  /** 为 true 时**不装载**，但这一行仍然出现在 dump 里。 */
  readonly disabled?: boolean
}

/** 一个 bundle 文件：一组插件行。 */
export interface BundleFile {
  readonly id: string
  readonly rows: readonly PluginRow[]
}

/** patch 里的一条：修改某个已有行。 */
export interface PatchEntry {
  readonly id: string
  /** 给定就**整段替换**原有 config（不是深合并）。 */
  readonly config?: Record<string, unknown>
  /** 给定就覆盖原有 disabled。 */
  readonly disabled?: boolean
}

/** patch 里的一条：插入新行。 */
export interface InsertEntry {
  readonly insert: readonly PluginRow[]
}

/** patch 层里的一条。 */
export type PatchItem = PatchEntry | InsertEntry

/** 一个 patch 层。 */
export type PatchLayer = readonly PatchItem[]

/** 一个 profile 文件：具名组合。 */
export interface ProfileFile {
  readonly name: string
  /** 按顺序叠加的 bundle 路径（相对 profile 文件）。 */
  readonly bundles: readonly string[]
  /** 这一层自己的覆盖。 */
  readonly patch?: PatchLayer
}

// ============================================================
// 二、层叠：把 bundles 和 patch 合成最终的 rows
// ============================================================

/**
 * 把若干 bundle 和若干 patch 层叠成最终的插件行列表。
 *
 * 规则：
 *   - bundle 之间：同 id 的**后面的覆盖前面的**
 *   - patch：按 id 定位，**整段替换 config**（不是深合并）
 *   - patch 指向不存在的 id → **报错**（不静默忽略）
 *   - insert 的 id 已存在 → **报错**
 *
 * @param bundles 按顺序的 bundle 列表
 * @param layers 按顺序的 patch 层（后面的覆盖前面的）
 * @returns 最终的插件行，顺序与首次出现顺序一致
 */
export function composeRows(
  bundles: readonly BundleFile[],
  layers: readonly PatchLayer[],
): PluginRow[] {
  const byId = new Map<string, PluginRow>()
  const order: string[] = []

  const put = (row: PluginRow): void => {
    // 只有第一次出现时才记录顺序 —— 后面的覆盖不改变位置
    if (!byId.has(row.id)) order.push(row.id)
    byId.set(row.id, row)
  }

  // ① bundle 之间：后面的覆盖前面的
  for (const bundle of bundles) {
    for (const row of bundle.rows) put(row)
  }

  // ② 依次应用 patch 层
  for (const layer of layers) {
    for (const item of layer) {
      if ('insert' in item) {
        for (const row of item.insert) {
          if (byId.has(row.id)) {
            throw new Error(`insert 的行 id 已经存在："${row.id}"`)
          }
          put(row)
        }
        continue
      }

      const existing = byId.get(item.id)
      if (existing === undefined) {
        throw new Error(`patch 指向不存在的行 id："${item.id}"；当前有：${order.join(', ')}`)
      }

      // ★ 整段替换 config，而不是深合并
      //   深合并无法删除字段，而且"这个值是从哪继承来的"会变得不可追踪。
      byId.set(item.id, {
        ...existing,
        ...(item.config !== undefined ? { config: item.config } : {}),
        ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      })
    }
  }

  const result: PluginRow[] = []
  for (const id of order) {
    const row = byId.get(id)
    if (row !== undefined) result.push(row)
  }
  return result
}

// ============================================================
// 三、读文件
// ============================================================

/** 读一个 JSON 文件。 */
async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`不是合法的 JSON：${path}\n${reason}`)
  }
}

/** 读一个 patch 文件（可以是数组，也可以是 `{ "patch": [...] }`）。 */
async function readPatchLayer(path: string): Promise<PatchLayer> {
  const data = await readJson<unknown>(path)
  if (Array.isArray(data)) return data as PatchLayer

  if (typeof data === 'object' && data !== null) {
    const patch = (data as { patch?: unknown }).patch
    if (Array.isArray(patch)) return patch as PatchLayer
  }
  throw new Error(`patch 文件格式不对：${path}（应为数组，或 { "patch": [...] }）`)
}

// ============================================================
// 四、装载
// ============================================================

/** 装载结果。 */
export interface LoadedProfile {
  /** 装载后的根容器。 */
  readonly ctx: Context
  /** 最终生效的插件行（**含被禁用的**，便于排查）。 */
  readonly rows: readonly PluginRow[]
  /** 卸载全部已装载的插件（逆序）。 */
  readonly unloadAll: Disposer
  /** 打印最终生效的配置。 */
  dump(): void
}

/** 装载选项。 */
export interface LoadProfileOptions {
  /** 复用一个已有的根容器（不给就新建）。 */
  readonly root?: Context
  /**
   * 在装载之前加工最终的行列表（模式系统新增）。
   *
   * ★ 为什么需要这个钩子，而不是再叠一层 patch？★
   * 因为 `patch` 的语义是**整段替换 config** —— 而模式只想调其中几个字段
   * （工具列表、步数上限、温度），并不想重写 `workspace` 这类别人的设置。
   * 把 patch 改成深合并会破坏"整段替换"这条已被文档化的规则，
   * 所以改成显式的一步：**拿到合并结果 → 加工 → 装载**。
   *
   * 加工结果就是最终生效的行 —— 所以 `dump()` 打印的正是模式生效之后的样子。
   */
  readonly transformRows?: (rows: readonly PluginRow[]) => readonly PluginRow[]
}

/**
 * 按 profile 装载一整套插件。
 * @param profilePath profile 文件路径
 * @param patchFiles 额外的 patch 文件，按数组顺序应用（优先级最高）
 * @param options 装载选项
 * @returns 装载结果
 * @throws profile/bundle 格式错误、patch 指向不存在的 id、插件模块缺少 default 导出
 */
export async function loadProfile(
  profilePath: string,
  patchFiles: readonly string[] = [],
  options: LoadProfileOptions = {},
): Promise<LoadedProfile> {
  const absoluteProfile = resolve(profilePath)
  const baseDir = dirname(absoluteProfile)

  const profile = await readJson<ProfileFile>(absoluteProfile)

  // ① 读全部 bundle
  const bundles: BundleFile[] = []
  for (const relative of profile.bundles) {
    bundles.push(await readJson<BundleFile>(resolve(baseDir, relative)))
  }

  // ② 组装 patch 层：profile 自己的 → 命令行给的
  const layers: PatchLayer[] = []
  if (profile.patch !== undefined) layers.push(profile.patch)
  for (const file of patchFiles) {
    layers.push(await readPatchLayer(resolve(file)))
  }

  // ③ 层叠成最终配置
  const composed = composeRows(bundles, layers)
  // ③.5 加工（模式系统在这里把声明合进各行的 config）
  const rows = options.transformRows === undefined ? composed : [...options.transformRows(composed)]

  // ④ 逐行装载
  const ctx = options.root ?? new Context(profile.name)
  const unloads: Disposer[] = []
  for (const row of rows) {
    if (row.disabled === true) continue

    const modulePath = resolve(baseDir, row.plugin)
    const url = pathToFileURL(modulePath).href
    const mod = (await import(url)) as { default?: unknown }
    const plugin = mod.default as Plugin | undefined
    if (plugin === undefined || typeof plugin.apply !== 'function') {
      throw new Error(`插件模块缺少 default 导出（或它不是插件）：${row.plugin}（行 "${row.id}"）`)
    }

    unloads.push(await ctx.plugin(plugin, row.config))
  }

  return {
    ctx,
    rows,
    unloadAll: (): void => {
      for (const unload of [...unloads].reverse()) unload()
    },
    dump: (): void => {
      console.log(`profile：${profile.name}（${absoluteProfile}）`)
      console.log(`bundle：${profile.bundles.join(' → ')}`)
      console.log('生效的行：')
      for (const row of rows) {
        const mark = row.disabled === true ? '  [已禁用]' : ''
        console.log(`  ${row.id.padEnd(18)} ${row.plugin}${mark}`)
        if (row.config !== undefined && Object.keys(row.config).length > 0) {
          console.log(`  ${''.padEnd(18)} config: ${JSON.stringify(row.config)}`)
        }
      }
    },
  }
}
