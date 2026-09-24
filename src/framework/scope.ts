/**
 * 第 5 步 ｜ 作用域（scope）：把「隔离」变成一件能写出来、也能看清的事
 *
 * 第 3 步定下的服务归属规则是：**注册写进共享表，归属记在注册者身上**。
 * 好处是插件之间能互相协作；代价是**默认没有隔离** ——
 * root 提供的 `tools` 对所有容器可见，两个 agent 只能拿到同一份。
 *
 * 第 4 步的 `Context.isolate()` 补上了机制（局部表 + 沿树向上查找），
 * 但机制不等于能力：真实场景里你要反复回答三个问题 ——
 *
 *   1. 这个 agent 的工具集，和那个 agent 的，**差在哪些服务上**？
 *   2. 某个服务现在**是谁提供的**？是这里遮蔽的，还是从外层继承的？
 *   3. 我遮蔽了一半就想收工，**原来的可见性还能回来吗**？
 *
 * 这个文件回答的就是这三问。它**不重复** `Context` 的能力（局部表、
 * 副作用回滚都在 `context.ts` 里），只在它之上补一层「作用域」这个概念的
 * 可组合、可观测、可销毁的操作：
 *
 *     const lab = createScope('lab')
 *     const reader = lab.child('reader')
 *     reader.override('tools', subsetTools(all, ['read_file', 'list_dir']))
 *     const writer = lab.child('writer')
 *     writer.override('tools', subsetTools(all, ['read_file', 'write_file']))
 *
 *     reader.originOf('tools')   // 'local'  ← 这里自己遮蔽的
 *     lab.originOf('tools')      // 'inherited' 或 'missing'
 *
 * ── 为什么隔离必须"显式"，而不能做成默认？──────────────────────────────
 *
 * 默认隔离（每个子容器自动看不见兄弟的服务）会把第 3 步那类 bug 换一种形式
 * 搬回来：插件 A 提供的服务插件 B 找不到，而报错信息只说"找不到服务 X"，
 * 没人知道是因为"隔离"而不是"忘了注册"。显式隔离把这件事变成一行代码 ——
 * 出问题时那一行就在 diff 里。
 */

import { Context } from './context.ts'
import type { Disposer, Plugin } from './context.ts'
import { ToolRegistry } from '../kernel/tools.ts'
import type { Tool } from '../kernel/tools.ts'

/** 某个服务在一个作用域里的来源。 */
export type ServiceOrigin =
  /** 这个作用域自己遮蔽的（本层的局部服务）。 */
  | 'local'
  /** 从祖先作用域继承来的。 */
  | 'inherited'
  /** 看不见。 */
  | 'missing'

/**
 * 一个作用域：包着一个 `Context` 子容器，并记住「这一层遮蔽了什么」。
 *
 * 它和容器的分工：容器管**生命周期与归属**，作用域管**这一层的可见性**。
 */
export class Scope {
  readonly name: string
  /** 这个作用域对应的容器。注册服务、装插件都通过它。 */
  readonly context: Context

  readonly #parent: Scope | undefined
  readonly #overrides = new Map<string, unknown>()
  readonly #children: Scope[] = []
  readonly #disposers: Disposer[] = []
  #disposed = false

  /**
   * @param name 作用域名（也是容器名，会出现在报错里）
   * @param parent 父作用域或父容器；不给就是顶层的根作用域
   */
  constructor(name: string, parent?: Scope | Context) {
    this.name = name
    this.#parent = parent instanceof Scope ? parent : undefined
    const parentContext = parent instanceof Scope ? parent.context : parent
    this.context = new Context(name, parentContext)

    if (parent instanceof Scope) parent.#children.push(this)
    else if (parent !== undefined) {
      // 父是裸容器：不做父子记账（它没有作用域这一层概念）
    }
  }

  /** 父作用域。父是裸容器或没有父时返回 undefined。 */
  get parent(): Scope | undefined {
    return this.#parent
  }

  /** 子作用域列表。 */
  get children(): readonly Scope[] {
    return this.#children
  }

  /** 这个作用域是否已经销毁。 */
  get disposed(): boolean {
    return this.#disposed
  }

  // ==================== 遮蔽与撤销 ====================

  /**
   * 在本作用域里**遮蔽**一个服务：本作用域及其子孙看到的是这一份，
   * 祖先和兄弟看到的仍是原来那份。
   * @param name 服务名
   * @param value 本层要暴露的值
   * @returns 撤销函数（撤销后回落外层）；同时也是本作用域的副作用，销毁时自动执行
   * @throws 本作用域已经遮蔽过同名服务时
   */
  override<T>(name: string, value: T): Disposer {
    this.#assertAlive()
    if (this.#overrides.has(name)) {
      throw new Error(`[${this.name}] 本作用域已经遮蔽过服务 "${name}"`)
    }

    const undoIsolate = this.context.isolate(name, value)
    this.#overrides.set(name, value)

    let restored = false
    const restore = (): void => {
      if (restored) return
      restored = true
      undoIsolate()
      this.#overrides.delete(name)
    }
    this.#disposers.push(restore)
    return restore
  }

  /** 把遮蔽的服务全部还回去（本作用域恢复成"完全继承"）。 */
  releaseAll(): void {
    for (const disposer of [...this.#disposers].reverse()) {
      try {
        disposer()
      } catch {
        // 撤销失败不该阻断其余撤销 —— 与 Context.dispose 的取舍一致
      }
    }
    this.#disposers.length = 0
  }

  // ==================== 派生 ====================

  /**
   * 派生一个子作用域：它继承本层的一切可见性。
   * @param name 子作用域名
   * @returns 新的作用域
   */
  child(name: string): Scope {
    this.#assertAlive()
    return new Scope(name, this)
  }

  /**
   * 派生一个**兄弟**作用域（同一个父亲），用于「两个平级 agent」这种形状。
   *
   * 为什么不直接 `new Scope(name, this.parent)` 让调用方自己拼？
   * 因为那会让「兄弟」这个概念散落到每个调用点，而调用方很容易写成
   * `new Scope(name, this)`（父子）—— 名字里是兄弟、结构上是父子，
   * 隔离因此悄悄失效。把这对关系固化成一个方法，就写不错了。
   * @param name 兄弟作用域名
   * @returns 新的作用域
   */
  sibling(name: string): Scope {
    this.#assertAlive()
    if (this.#parent === undefined) {
      throw new Error(`[${this.name}] 没有父作用域，无法派生兄弟；请用 child()`)
    }
    return new Scope(name, this.#parent)
  }

  // ==================== 观测 ====================

  /**
   * 某个服务在这里**从哪来**。
   * @param name 服务名
   * @returns `local` = 这一层遮蔽的；`inherited` = 外层给的；`missing` = 看不见
   */
  originOf(name: string): ServiceOrigin {
    if (this.#overrides.has(name)) return 'local'
    return this.context.has(name) ? 'inherited' : 'missing'
  }

  /** 本层遮蔽的服务名（**只列自己**，不含继承 —— 这正是排查时要看的）。 */
  layers(): string[] {
    return [...this.#overrides.keys()]
  }

  /** 与另一个作用域的可见服务差异。用于回答"这两个 agent 差在哪"。 */
  diff(other: Scope): { readonly onlyHere: string[]; readonly onlyThere: string[] } {
    const mine = new Set(this.context.serviceNames())
    const theirs = new Set(other.context.serviceNames())
    return {
      onlyHere: [...mine].filter((name) => !theirs.has(name)),
      onlyThere: [...theirs].filter((name) => !mine.has(name)),
    }
  }

  /**
   * 一行行的作用域快照，用于日志与演示。
   * @returns 每个服务一行：名字 / 来源 / 是不是本层遮蔽的
   */
  describe(): string {
    const lines = [`作用域 ${this.name}（容器树：${this.context.tree()}）`]
    const names = this.context.serviceNames().sort()
    if (names.length === 0) lines.push('  (没有任何可见服务)')
    for (const name of names) {
      const origin = this.originOf(name)
      const mark = origin === 'local' ? '★ 本层遮蔽' : '  继承'
      lines.push(`  ${name.padEnd(16)} ${mark}`)
    }
    return lines.join('\n')
  }

  // ==================== 插件与销毁 ====================

  /**
   * 在本作用域里装载一个插件。插件拿到的子容器是本作用域的**再下一层**，
   * 因此它注册的服务不会外泄给兄弟。
   * @param plugin 插件
   * @param config 插件配置
   * @returns 卸载函数
   */
  async use(plugin: Plugin, config?: Record<string, unknown>): Promise<Disposer> {
    this.#assertAlive()
    const unload = await this.context.plugin(plugin, config)
    this.#disposers.push(unload)
    return unload
  }

  /** 销毁：撤销本层全部遮蔽、卸载全部插件，并递归销毁子作用域。幂等。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    for (const child of [...this.#children].reverse()) child.dispose()
    this.#children.length = 0

    for (const disposer of [...this.#disposers].reverse()) {
      try {
        disposer()
      } catch {
        // 与 Context.dispose 一致：一个坏撤销不该让整棵树的销毁卡死
      }
    }
    this.#disposers.length = 0
    this.#overrides.clear()
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error(`[${this.name}] 作用域已销毁`)
  }
}

/**
 * 建一个作用域。
 * @param name 作用域名
 * @param parent 父作用域或父容器；不给就是根
 * @returns 新作用域
 */
export function createScope(name: string, parent?: Scope | Context): Scope {
  return new Scope(name, parent)
}

/**
 * 在一个临时作用域里跑一段逻辑，跑完自动销毁。
 *
 * 为什么需要它？因为「忘了 dispose」是这个机制最现实的故障：
 * 作用域里的遮蔽会一直生效，而现象是"另一个 agent 忽然少了几个服务"。
 * 把生命周期绑在回调上，就没有"忘"的机会。
 * @param name 作用域名
 * @param parent 父作用域或父容器
 * @param run 要跑的逻辑
 * @returns run 的返回值
 */
export async function withScope<T>(
  name: string,
  parent: Scope | Context,
  run: (scope: Scope) => Promise<T>,
): Promise<T> {
  const scope = createScope(name, parent)
  try {
    return await run(scope)
  } finally {
    scope.dispose()
  }
}

/**
 * 从一份完整工具集里挑出一个子集，装进一个新注册表。
 *
 * 这是作用域最常见的用法：**同一个进程里，读 agent 与写 agent 共享一个
 * 工具定义来源，但各自只看得见其中一部分。**
 * @param source 完整注册表
 * @param names 要保留的工具名；给 `undefined` 表示全部
 * @returns 新的注册表
 * @throws 名字不在 source 里时（拼错工具名必须当场报错，不能静默少一个）
 */
export function subsetTools(source: ToolRegistry, names?: readonly string[]): ToolRegistry {
  const registry = new ToolRegistry()
  const wanted: readonly string[] = names ?? source.names()

  const missing = wanted.filter((name) => source.get(name) === undefined)
  if (missing.length > 0) {
    throw new Error(`子集里有不存在的工具：${missing.join(', ')}；可用：${source.names().join(', ')}`)
  }

  for (const name of wanted) {
    const tool: Tool | undefined = source.get(name)
    if (tool !== undefined) registry.register(tool)
  }
  return registry
}
