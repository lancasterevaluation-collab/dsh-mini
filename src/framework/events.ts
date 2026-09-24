/**
 * 第 4 步 ｜ 事件：让插件在不认识彼此的情况下互相介入
 *
 * 第 3 步解决了「插件怎么互相发现」—— 靠服务名查表。
 * 但那只解决了「取用」，没解决「介入」：
 *
 *   如果 retry 插件想插手「模型请求失败」，它需要在哪里写代码？
 *     第 3 步的答案：改主循环 —— 那是我们最想避免的事。
 *     第 4 步的答案：挂一个监听器。
 *
 * ── waterfall（瀑布式分发）──────────────────────────────────────────────
 *
 * 一串监听器依次相连，每个处理完自己决定「交给下一个」还是「到此为止」：
 *
 *     监听器1 ──next()──► 监听器2 ──next()──► 监听器3 ──next()──► 默认处理器
 *        │                    │                    │
 *        └─ 返回 {kind:'retry'} └─ 返回 next()      └─ 返回 next()
 *           ↑ 短路：2、3 都不会执行
 *
 * 名字来自「水从台阶流下」—— 每一级都能拦住水。
 *
 * 三条必须记住的规则：
 *   1. 不调 next() 就是短路 —— 后面的监听器全部不执行
 *   2. 调了 next() 必须 return 它的结果 —— 写成 `next(); return x` 会让链断裂
 *   3. 顺序由注册顺序决定 —— 谁先 on() 谁先被调用
 */

import type { Disposer } from './context.ts'

// ============================================================
// 一、事件表：事件名 → payload 类型
// ============================================================

/**
 * 框架级的全部事件。
 *
 * 这是一个**可扩展**的类型：插件可以用 TypeScript 的「声明合并」往里加事件，
 * 而不用改这个文件。写法见 L1 的 1.3 节。
 */
export interface EventMap {
  /** 某个服务被注册了。 */
  'service/provided': { name: string; owner: string }
  /** 某个服务被移除了。 */
  'service/removed': { name: string; owner: string }
  /** 某个插件完成了装载。 */
  'plugin/started': { name: string }
  /** 某个插件因为依赖不齐而挂起。 */
  'plugin/pending': { name: string; missing: readonly string[] }
}

/** 事件名的联合类型。 */
export type EventName = keyof EventMap

/**
 * 一个事件监听器。
 * @param payload 事件携带的数据
 * @param next 调用它 =「我处理完了，交给下一个」；不调 = 到此为止
 * @returns 任意值；waterfall 会把它当作「这一级的处理结果」往上返回
 */
export type Listener<P> = (payload: P, next: () => Promise<unknown>) => unknown | Promise<unknown>

// ============================================================
// 二、分发器：一类事件的全部监听器
// ============================================================

/**
 * 一个事件的分发器。
 *
 * 为什么要有这个类，而不是把监听器数组直接放在 Context 里？
 *   因为「一类事件的监听器」本身是一个独立概念：它有顺序、有分发规则、
 *   有自己的增删。把它抽出来，Context 只需要管「事件名 → 分发器」的映射。
 */
export class Dispatcher<P = unknown> {
  #listeners: Listener<P>[] = []

  /**
   * 挂一个监听器。
   * @param listener 处理函数
   * @returns 撤销函数（幂等）
   */
  on(listener: Listener<P>): Disposer {
    this.#listeners.push(listener)

    let removed = false
    return (): void => {
      // 幂等：重复撤销只生效一次
      if (removed) return
      removed = true
      const index = this.#listeners.indexOf(listener)
      if (index >= 0) this.#listeners.splice(index, 1)
    }
  }

  /** 当前监听器数量。用于测试和排查。 */
  get size(): number {
    return this.#listeners.length
  }

  /**
   * 分发一次事件（waterfall 语义）。
   * @param payload 事件数据
   * @returns 最后一级监听器的返回值；没有监听器时返回 undefined
   */
  async emit(payload: P): Promise<unknown> {
    // 先快照：监听器在分发过程中可能增删（比如某个监听器卸载了自己）
    const listeners = [...this.#listeners]

    let index = -1
    const next = async (): Promise<unknown> => {
      index += 1
      const listener = listeners[index]
      // 走完了 —— 这就是「默认处理器」：什么都不做
      if (listener === undefined) return undefined
      return await listener(payload, next)
    }

    return await next()
  }
}
