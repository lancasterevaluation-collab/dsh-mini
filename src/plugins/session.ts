/**
 * 能力插件 ③ ｜ session：把第 7 步的会话日志接进框架
 *
 * 会话日志本身在第 7 步就写完了（`kernel/session.ts`），它缺的不是能力，
 * 而是**接线**：谁在什么时刻知道"日志刚多了一条"。
 *
 * 在这之前只有一种办法：拿 `session.events` 事后扫描。这有两个问题 ——
 *
 *   1. **分不清"刚来的"和"一直在这儿的"** —— 扫描一百次会看到同一百条事件
 *   2. **上游必须轮询** —— 于是每个消费者都自带一个定时器，或者干脆在上游
 *      代码里 `if (type === 'tool/result') ...`，把策略写死进调用链
 *
 * 所以这个插件做的是：把 `SessionOptions.onEvent`（kernel 里的**普通函数**钩子）
 * 接到框架事件上，从此"日志刚发生了什么"是一个**可监听的事实**。
 *
 * ★ 注意依赖方向：kernel 里的钩子签名是 `(event, session) => void`，
 *   它不知道 `Context` 是什么。把这个函数接到 `ctx.emit` 上的动作发生在**这里** ——
 *   plugins 层。所以 `kernel/session.ts` 依然不认识框架（课程主线 1）。
 *
 * ── 顺带解决一件小事：落盘 ────────────────────────────────────────────
 *
 * 日志不落盘就只是内存结构。这里在**每次 turn 结束时**写一次 JSONL：
 * 不是每条事件写一次（那是 I/O 风暴），也不是进程退出时写一次
 * （崩溃就全丢）。turn 边界是"这一次任务的证据已经齐了"的最小单位。
 */

import { resolve } from 'node:path'
import { Session } from '../kernel/session.ts'
import type { SessionEvent } from '../kernel/session.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 会话日志里刚追加了一条事件。进化层（第 12–15 步）监听它。 */
    'session/event': { event: SessionEvent; session: Session }
    /** 会话日志被写到了磁盘。 */
    'session/saved': { path: string; events: number }
    /** 一个新的会话被创建（多 agent 场景下会有多条）。 */
    'session/created': { id: string }
  }
}

/** 配置文件里这一段能写什么。 */
export interface SessionConfig {
  /** 会话 id。默认按时间生成。 */
  readonly id?: string
  /** 落盘路径（相对进程工作目录）。不给就不落盘。 */
  readonly savePath?: string
}

/** 解析后的会话配置。 */
export interface SessionSpec {
  readonly id: string
  readonly savePath: string | undefined
}

/**
 * 解析会话配置。
 * @param config 配置段
 * @returns 生效的 Spec
 */
export function resolveSessionSpec(config: SessionConfig | undefined): SessionSpec {
  const raw = config ?? {}
  return {
    id: raw.id !== undefined && raw.id !== '' ? raw.id : `session-${Date.now()}`,
    savePath: raw.savePath !== undefined && raw.savePath !== '' ? resolve(raw.savePath) : undefined,
  }
}

/** 会话工厂的形状 —— 多 agent 场景下每个 agent 一条日志。 */
export interface SessionFactory {
  /**
   * 造一个会话，并把它接上框架事件。
   * @param id 会话 id
   * @returns 已接线的会话
   */
  create(id: string): Session
}

/** session 插件。 */
export const sessionPlugin: Plugin = {
  name: 'session',
  apply(ctx, config) {
    const spec = resolveSessionSpec(config as SessionConfig | undefined)

    const create = (id: string): Session => {
      const session = new Session(id, {
        onEvent: (event, owner) => {
          // 同步钩子 → 异步事件。这里**不 await**：日志已经写完，
          // 监听器的耗时不该反过来阻塞 agent 循环（它们是观察者，不是参与者）。
          void ctx.emit('session/event', { event, session: owner })

          // 落盘挂在 turn 边界上：一次任务的证据齐了才值得一次 I/O
          if (event.type === 'turn/end' && spec.savePath !== undefined) {
            const path = spec.savePath
            void owner.save(path).then(
              () => ctx.emit('session/saved', { path, events: owner.events.length }),
              (error: unknown) => {
                // 落盘失败必须出声 —— 否则"日志丢了"会在很久以后才被发现
                console.error(`[session] 落盘失败 ${path}：`, error instanceof Error ? error.message : error)
              },
            )
          }
        },
      })
      void ctx.emit('session/created', { id })
      return session
    }

    const current = create(spec.id)
    const factory: SessionFactory = { create }

    ctx.provide('session', current)
    ctx.provide('session/factory', factory)
    ctx.provide('session/spec', spec)

    console.log(`[session] 已装载：id=${spec.id}${spec.savePath === undefined ? '（不落盘）' : `；落盘=${spec.savePath}`}`)
  },
}

export default sessionPlugin
