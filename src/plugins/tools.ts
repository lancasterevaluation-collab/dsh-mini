/**
 * 能力插件 ② ｜ tools：把第 2 步的工具注册表挂成一个**服务**
 *
 * 和第 1 步一样的问题：注册表造出来了，但**谁往里面放工具**没有约定。
 * 到第 6 步为止，每个演示都自己 `new ToolRegistry()` 再手工 `register`，
 * 于是"这个 agent 有哪些工具"这件事散落在每个入口文件里。
 *
 * 这个插件确立两条约定：
 *
 *   1. **注册表是服务**（`tools`），谁都能拿到它、往里加工具 ——
 *      这是本课程『能力即插件』的最短路径：新增一个工具不需要改组装代码
 *   2. **工作目录也是服务**（`workspace`）—— 工具的安全边界
 *      （`read_file` 只认这个目录为界）必须只有**一个**定义处，
 *      否则"两个地方各有一份 workspace"迟早会出现越界
 *
 * ── 为什么内置工具要按名字开关？──────────────────────────────────────────
 *
 * `delete_file` 是唯一不可逆的工具（第 10 步给了它 `irreversible` 等级）。
 * 让它"默认就在"是危险的默认值 —— 课里那句"一个只有 read/write 的 harness
 * 结构上产生不了 C 类失败"就是这个意思。所以配置里显式列名字，
 * 没列就不装载：**危险能力必须被写出来，不能继承**。
 */

import { resolve } from 'node:path'
import { builtinTools } from '../kernel/builtin-tools.ts'
import { ToolRegistry } from '../kernel/tools.ts'
import type { Tool } from '../kernel/tools.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 一个工具被注册进注册表。 */
    'tools/registered': { name: string; sideEffect: string; by: string }
  }
}

/** 配置文件里这一段能写什么。 */
export interface ToolsConfig {
  /** 工具的工作目录（安全边界）。默认取进程工作目录。 */
  readonly workspace?: string
  /**
   * 要装载的内置工具名。
   * 不给 = 只装只读工具（`read_file` / `list_dir`）；
   * 写 `"all"` = 全部（**含不可逆的 `delete_file`**）。
   */
  readonly builtin?: readonly string[] | string
}

/** 解析后的工具配置。 */
export interface ToolsSpec {
  readonly workspace: string
  readonly builtin: readonly string[]
}

/** 不给配置时的默认内置工具集 —— 只读，结构上安全。 */
export const DEFAULT_BUILTIN_TOOLS: readonly string[] = ['read_file', 'list_dir']

/**
 * 解析工具配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws 写了不存在的工具名时（拼错名字不能静默少一个工具）
 */
export function resolveToolsSpec(config: ToolsConfig | undefined): ToolsSpec {
  const raw = config ?? {}
  const available = builtinTools.map((tool) => tool.name)

  let names: readonly string[]
  if (raw.builtin === undefined) names = DEFAULT_BUILTIN_TOOLS
  else if (raw.builtin === 'all') names = available
  else if (Array.isArray(raw.builtin)) names = raw.builtin
  else throw new Error('tools 插件：config.builtin 只能是数组或 "all"')

  const unknown = names.filter((name) => !available.includes(name))
  if (unknown.length > 0) {
    throw new Error(`tools 插件：不认识的内置工具 ${unknown.join(', ')}；可选：${available.join(', ')}`)
  }

  return {
    // ★ 工作目录在这里就 resolve 成绝对路径：后续所有路径检查都以它为基准，
    //   留一个相对路径会让"越界判断"随 cwd 漂移
    workspace: raw.workspace !== undefined && raw.workspace !== '' ? resolve(raw.workspace) : process.cwd(),
    builtin: names,
  }
}

/** tools 插件。 */
export const toolsPlugin: Plugin = {
  name: 'tools',
  apply(ctx, config) {
    const spec = resolveToolsSpec(config as ToolsConfig | undefined)
    const registry = new ToolRegistry()

    for (const name of spec.builtin) {
      const tool = builtinTools.find((candidate) => candidate.name === name)
      if (tool === undefined) continue // resolveToolsSpec 已经挡过，这里只是收窄类型
      registry.register(tool)
      void ctx.emit('tools/registered', { name, sideEffect: tool.sideEffect, by: ctx.name })
    }

    ctx.provide('workspace', spec.workspace)
    ctx.provide('tools', registry)
    ctx.provide('tools/spec', spec)

    /**
     * 提供一个「注册工具」的入口供其它插件调用。
     *
     * 为什么不直接 `ctx.require('tools').register(tool)`？
     * 因为那样注册的动作**不会留下事件**，排查时看不到"这个工具是谁加的"。
     * 走这个入口，每一次注册都会广播一条带 `by` 的事件。
     * @param tool 要注册的工具
     */
    ctx.provide('tools/register', (tool: Tool): void => {
      registry.register(tool)
      void ctx.emit('tools/registered', { name: tool.name, sideEffect: tool.sideEffect, by: ctx.name })
    })

    console.log(`[tools] 已装载：workspace=${spec.workspace}；工具=${spec.builtin.join(', ')}`)
  },
}

export default toolsPlugin
