/**
 * 第 3 步 ｜ 上下文容器（ctx）：整个框架的心脏
 *
 * 在这之前，我们的代码是「硬连线」的：
 *     main.ts → new Agent() → new DeepSeekProvider() → new ToolRegistry()
 * 想换掉其中任何一个，都必须改 main.ts 的代码。
 *
 * 从这一步开始改成「插件树」：
 *     每个插件拿到一个专属的子容器，把能力**注册**上去；
 *     别人要用，就按名字**查找**。
 *     谁注册了什么、谁依赖谁，全部通过 ctx 中转 —— 没有任何两段代码直接 import 彼此。
 *
 * ┌──────────┬──────────────────────────────────────────────────────────┐
 * │ 服务      │ 挂在 ctx 上的能力，别人用 ctx.get('名字') 取                │
 * │ 副作用    │ 任何注册都要能被撤销 —— 卸载时自动回滚                     │
 * │ 插件      │ 一段装载逻辑，拿到专属子容器                               │
 * └──────────┴──────────────────────────────────────────────────────────┘
 *
 * ── 服务归属规则（这一步最关键的决策）─────────────────────────────────────
 *
 * 服务注册进**全树共享的唯一命名空间**，但每条记录都记下「是哪个容器注册的」。
 * 为什么不能让它只在自己那个子容器里可见？因为那样兄弟插件就互相看不见了：
 *
 *     root
 *      ├── plugin-config   ← 在这里注册 'config'
 *      └── plugin-greeter  ← 它查 'config' 时会向上找到 root，永远查不到兄弟的
 *
 * 结果就是「插件之间无法协作」，框架直接失去意义。
 * 所以：**注册写到共享表，归属记在注册者身上，卸载时按归属精确移除。**
 *
 * （代价：默认没有隔离。第 5 步会用 scope 补上显式的隔离层。）
 */

import { Dispatcher } from './events.ts'
import type { EventMap, Listener } from './events.ts'

/** 撤销函数：调用它，对应的注册就消失。必须幂等（重复调用无害）。 */
export type Disposer = () => void

/** 一个插件。 */
export interface Plugin {
  /** 插件名。会出现在日志和报错里，必须唯一且可读。 */
  readonly name: string
  /**
   * 第 4 步新增：这个插件需要哪些服务。
   * 声明的服务**全部就绪**才会调用 apply；否则挂起等待。
   */
  readonly inject?: readonly string[]
  /**
   * 装载逻辑。
   * @param ctx 这个插件的**专属子容器**；它在这里登记的一切都挂在这个子容器上
   * @param config 第 6 步新增：来自配置文件的这一段配置（没配置就是 undefined）
   */
  apply(ctx: Context, config?: Record<string, unknown>): void | Promise<void>
}

/** 卸载时的错误上报。单项失败不该阻断整体卸载，但也不能悄悄吞掉。 */
export type DisposeErrorHandler = (error: unknown, contextName: string) => void

/** 共享注册表里的一条服务记录。 */
interface ServiceEntry {
  /** 谁注册的。卸载那个容器时，这条记录会被精确移除。 */
  readonly owner: Context
  readonly value: unknown
}

/**
 * 上下文容器。
 *
 * 一个进程里会有很多个 Context 实例，它们构成一棵树：
 *
 *     root
 *      ├── plugin-llm        （子容器：它注册的服务挂在这条归属上）
 *      ├── plugin-tools      （子容器）
 *      └── plugin-agent-loop （子容器）
 *            └── agent#1     （孙容器：第 5 步用它做隔离）
 *
 * 共享的服务注册表由根容器持有，所有子容器共用同一张表。
 */
export class Context {
  readonly name: string
  #parent: Context | undefined
  #registry: Map<string, ServiceEntry>
  #children: Context[] = []
  #effects: Disposer[] = []
  #disposed = false
  #onDisposeError: DisposeErrorHandler | undefined
  /** 事件名 → 分发器。和第 3 步的注册表一样，由根容器持有、全树共享。 */
  #dispatchers: Map<string, Dispatcher>
  /** 第 4 步新增：全部「依赖未齐、等待启动」的插件容器。共享。 */
  #pending: Set<Context>
  /** 第 4 步新增：本容器挂起时记住的插件（依赖齐了才能启动它）。 */
  #waiting: Plugin | undefined
  /** 第 6 步新增：挂起时一并记住它的配置（唤醒时要传给 apply）。 */
  #waitingConfig: Record<string, unknown> | undefined
  /** 第 4 步新增：本容器是否已经启动过。 */
  #started = false
  /**
   * 第 5 步新增：本容器**局部**提供的服务（只对本容器及其子树可见）。
   *
   * 注意它**不共享** —— 每个容器有自己的局部层，这是作用域隔离的载体。
   */
  #local = new Map<string, unknown>()

  /**
   * @param name 容器名，用于报错和排查
   * @param parent 父容器；不给就是根容器（它负责创建共享注册表）
   * @param onDisposeError 撤销失败时的上报函数；不给就继承父容器的
   */
  constructor(name: string, parent?: Context, onDisposeError?: DisposeErrorHandler) {
    this.name = name
    this.#parent = parent
    // 根容器新建注册表；子容器直接继承，所以要保证“同一张表”
    this.#registry = parent === undefined ? new Map() : parent.#registry
    this.#dispatchers = parent === undefined ? new Map() : parent.#dispatchers
    this.#pending = parent === undefined ? new Set() : parent.#pending
    this.#onDisposeError = onDisposeError ?? (parent === undefined ? undefined : parent.#onDisposeError)
  }

  /** 父容器。根容器返回 undefined。 */
  get parent(): Context | undefined {
    return this.#parent
  }

  /** 这个容器是否已经卸载。 */
  get disposed(): boolean {
    return this.#disposed
  }

  /** 子容器列表。 */
  get children(): readonly Context[] {
    return this.#children
  }

  /** 容器树的形状，便于排查「哪个插件挂在哪」。 */
  tree(): string {
    if (this.#children.length === 0) return this.name
    return `${this.name}[${this.#children.map((child) => child.tree()).join(' ')}]`
  }

  // ==================== 服务 ====================

  /**
   * 注册一个服务。
   * @param name 服务名，**全树唯一**
   * @param value 服务实例
   * @returns 撤销函数（同时也登记进了副作用列表，卸载时会自动执行）
   * @throws 这个名字已经被注册过时（报错信息里会指出是被谁占的）
   */
  provide<T>(name: string, value: T): Disposer {
    this.#assertAlive()

    const existing = this.#registry.get(name)
    if (existing !== undefined) {
      throw new Error(
        `[${this.name}] 服务重复注册："${name}"（已被容器 "${existing.owner.name}" 注册）`,
      )
    }

    this.#registry.set(name, { owner: this, value })

    const remove = (): void => {
      // 只移除「还是自己的」那条 —— 万一后来被同名服务顶替过，不能误删别人的
      const current = this.#registry.get(name)
      if (current !== undefined && current.owner === this) {
        this.#registry.delete(name)
      }
    }
    this.#effects.push(remove)

    // 第 4 步：服务出现了 —— 通知监听器，并唤醒在等它的插件。
    // 注意这里是同步方法里的「发射后不管」：emit 是异步的，我们不阻塞 provide。
    void this.emit('service/provided', { name, owner: this.name })
    this.#wakePending()

    return remove
  }

  /**
   * 在**本容器及其子树**内提供一个服务，遮蔽全局的同名服务。
   *
   * 与 `provide` 的分工：
   *   `provide`  → 写全局表，**全树可见**
   *   `isolate`  → 写局部表，**只有本容器和它的子孙看得见**
   *
   * 注意：局部表**只检查自己**是否重名 —— 允许遮蔽祖先的局部服务与全局服务。
   * 这正是「隔离」的实现方式。
   * @param name 服务名
   * @param value 服务实例
   * @returns 撤销函数（同时登记进副作用列表，卸载时自动移除）
   * @throws 本容器已经局部提供过同名服务时
   */
  isolate<T>(name: string, value: T): Disposer {
    this.#assertAlive()
    if (this.#local.has(name)) {
      throw new Error(`[${this.name}] 本作用域已有局部服务 "${name}"`)
    }

    this.#local.set(name, value)
    const remove = (): void => {
      this.#local.delete(name)
    }
    this.#effects.push(remove)
    return remove
  }

  /** 查服务。找不到返回 undefined。 */
  get<T>(name: string): T | undefined {
    // 第 5 步：先沿容器树向上找「局部层」—— 命中就返回，不再往下走
    for (let node: Context | undefined = this; node !== undefined; node = node.#parent) {
      if (node.#local.has(name)) return node.#local.get(name) as T
    }
    // 再回落到全局注册表
    const entry = this.#registry.get(name)
    return entry === undefined ? undefined : (entry.value as T)
  }

  /**
   * 查服务，找不到就**抛错**。
   *
   * 为什么不返回 undefined 让调用方自己判？
   * 因为「缺少依赖」是必须在**装载时**就炸出来的错误。
   * 如果它变成 undefined 继续往下飘，你会在几百行之外看到一个莫名其妙的 TypeError。
   */
  require<T>(name: string): T {
    if (!this.has(name)) {
      const available = this.serviceNames().join(', ')
      throw new Error(`[${this.name}] 找不到服务 "${name}"；当前可用：${available === '' ? '(无)' : available}`)
    }
    return this.get<T>(name) as T
  }

  /** 这个服务名是否可见（局部层或全局表任一命中）。 */
  has(name: string): boolean {
    for (let node: Context | undefined = this; node !== undefined; node = node.#parent) {
      if (node.#local.has(name)) return true
    }
    return this.#registry.has(name)
  }

  /** 当前**能看见**的全部服务名（局部层 + 全局表）。 */
  serviceNames(): string[] {
    const names = new Set<string>()
    for (let node: Context | undefined = this; node !== undefined; node = node.#parent) {
      for (const name of node.#local.keys()) names.add(name)
    }
    for (const name of this.#registry.keys()) names.add(name)
    return [...names]
  }

  /** 这个服务是谁提供的。局部层会标出容器名。 */
  ownerOf(name: string): string | undefined {
    for (let node: Context | undefined = this; node !== undefined; node = node.#parent) {
      if (node.#local.has(name)) return `${node.name}（局部）`
    }
    return this.#registry.get(name)?.owner.name
  }

  // ==================== 副作用 ====================

  /**
   * 登记一个副作用。
   * 卸载时按登记的**逆序**执行 —— 后注册的东西可能依赖先注册的，所以要先拆后注册的。
   * @param disposer 撤销动作，必须幂等
   */
  effect(disposer: Disposer): void {
    this.#assertAlive()
    this.#effects.push(disposer)
  }

  // ==================== 事件（第 4 步新增）====================

  /**
   * 挂一个事件监听器。
   * @param name 事件名
   * @param listener 处理函数 `(payload, next) => ...`
   * @returns 撤销函数（同时也登记进副作用列表，卸载时自动移除）
   */
  on<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): Disposer {
    this.#assertAlive()
    const dispatcher = this.#dispatcherFor(name) as Dispatcher<EventMap[K]>

    const off = dispatcher.on(listener)
    // 监听器的移除也是一项副作用：容器卸载时自动生效
    this.effect(() => {
      off()
    })
    return off
  }

  /**
   * 分发一次事件（waterfall 语义）。
   * @param name 事件名
   * @param payload 事件数据
   * @returns 最后一级监听器的返回值；没人监听时返回 undefined
   */
  async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<unknown> {
    const dispatcher = this.#dispatchers.get(name)
    // 没人监听 → 直接返回，不创建空的分发器
    if (dispatcher === undefined) return undefined
    return await dispatcher.emit(payload)
  }

  /** 当前已经有监听器的事件名。用于排查。 */
  eventNames(): string[] {
    return [...this.#dispatchers.keys()]
  }

  /** 取（或按需创建）某个事件的分发器。 */
  #dispatcherFor(name: string): Dispatcher {
    const existing = this.#dispatchers.get(name)
    if (existing !== undefined) return existing
    const created = new Dispatcher()
    this.#dispatchers.set(name, created)
    return created
  }

  // ==================== 插件 ====================

  /**
   * 装载一个插件。
   *
   * 插件拿到的不是 this，而是一个**新建的子容器**。这样它注册的服务有了明确的归属，
   * 卸载它时只回滚它自己的东西，不会误伤别的插件。
   * @param plugin 要装载的插件
   * @returns 卸载函数（幂等：重复调用只生效一次）
   * @throws 插件装载过程中抛出的错误（此时已经注册的部分会被回滚干净）
   */
  async plugin(plugin: Plugin, config?: Record<string, unknown>): Promise<Disposer> {
    this.#assertAlive()
    const child = new Context(plugin.name, this)
    this.#children.push(child)

    // 第 4 步：检查依赖是否就绪
    const deps = plugin.inject ?? []
    const missing = deps.filter((name) => !this.#registry.has(name))

    if (missing.length > 0) {
      // 依赖不齐 —— 挂起。等 provide() 唤醒（见 #wakePending）
      child.#waiting = plugin
      child.#waitingConfig = config
      this.#pending.add(child)
      void this.emit('plugin/pending', { name: plugin.name, missing })
    } else {
      child.#started = true
      try {
        await plugin.apply(child, config)
      } catch (error) {
        // 装载到一半失败：必须把已注册的部分撤干净，否则会留下「半个插件」——
        // 它占着服务名，让下一次重试直接报「重复注册」，非常难查。
        child.dispose()
        throw error
      }
      void this.emit('plugin/started', { name: plugin.name })
    }

    let unloaded = false
    return (): void => {
      if (unloaded) return
      unloaded = true
      this.#pending.delete(child)
      this.#children = this.#children.filter((candidate) => candidate !== child)
      child.dispose()
    }
  }

  // ==================== 依赖唤醒（第 4 步新增）====================

  /**
   * 服务出现后，唤醒所有「依赖已经齐了」的挂起插件。
   *
   * 为什么是同步方法 + 微任务？因为 provide() 是同步的，而 apply() 可能是异步的。
   * 放到微任务里，既能立刻返回，又保证「provide 返回后，等待的插件已经能启动」。
   */
  #wakePending(): void {
    for (const child of [...this.#pending]) {
      const plugin = child.#waiting
      if (plugin === undefined) continue

      const deps = plugin.inject ?? []
      if (!deps.every((name) => this.#registry.has(name))) continue

      const config = child.#waitingConfig
      this.#pending.delete(child)
      child.#waiting = undefined
      child.#waitingConfig = undefined
      queueMicrotask(() => {
        void child.#startSilently(plugin, config)
      })
    }
  }

  /**
   * 唤醒路径下的启动：**没有人能接住异常**，所以自己回滚并上报。
   *
   * 对比 plugin() 里的直接启动 —— 那里有 await 的调用方，可以原样抛出异常。
   */
  async #startSilently(plugin: Plugin, config?: Record<string, unknown>): Promise<void> {
    if (this.#started || this.#disposed) return
    this.#started = true
    try {
      await plugin.apply(this, config)
      void this.emit('plugin/started', { name: this.name })
    } catch (error) {
      // 启动失败：回滚已注册的部分，并上报 —— 绝不能静默
      this.dispose()
      this.#onDisposeError?.(error, this.name)
    }
  }

  // ==================== 卸载 ====================

  /** 卸载：逆序执行全部副作用（包括移除自己注册的服务），然后禁止再注册。幂等。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    for (const disposer of [...this.#effects].reverse()) {
      try {
        disposer()
      } catch (error) {
        // 一个坏插件的撤销失败，不该让整个卸载流程卡死
        this.#onDisposeError?.(error, this.name)
      }
    }

    this.#effects = []
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error(`[${this.name}] 容器已卸载，不能再注册`)
    }
  }
}
