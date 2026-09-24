/**
 * 第 13 步 ｜ Curator：技能的生命周期，以及"谁有权删掉它"
 *
 * 技能库会随时间腐化，而且腐化的方式很隐蔽：**不是变错，而是变得没用**。
 *
 *   三个月前的技能还在目录里 → 模型每次都要在一堆无关条目里挑
 *   → 渐进披露的收益被自己的目录吃掉
 *
 * 所以需要一个"定期打扫"的角色。但打扫有个危险：**上游技能不该被本地流程删掉**。
 *
 *   上游技能 = 别人维护的规范、随项目带进来的清单
 *   本地技能 = agent 自己总结出来的流程
 *
 * 如果 Curator 有权归档上游技能，那么某次"打扫"就可能把团队规范悄悄藏起来，
 * 而现象只是"模型忽然不遵守规范了" —— 排查会花掉一整天。
 * 所以本模块的核心规则只有一条：
 *
 *     ★ 上游技能只能降级到 stale（还在目录里），永远不能被归档或删除 ★
 *
 * ── 为什么分两档（stale / archived）而不是直接删？─────────────────────
 *
 * 因为"没用"是个概率判断，而删除是不可逆的。
 *
 *   stale    → 目录里还在，只是被标出来"很久没用了"（可逆）
 *   archived → 从日常目录里消失，但仍可被显式读到（可逆）
 *
 * 真正不可逆的删除留给**人**：Curator 只负责把候选挑出来。
 * 这也是整个第 16 步"演化门控"的同一个立场 —— 自动流程可以降级、可以回滚，
 * 但不可以静默销毁。
 */

import type { Skill, SkillLibrary, SkillStatus } from './skills.ts'

/** 打扫策略。 */
export interface CuratorPolicy {
  /** 多久没用就降级为 stale。 */
  readonly staleAfterMs: number
  /** 降级为 stale 之后再过多久归档。 */
  readonly archiveAfterMs: number
  /** 从未被读过的技能按"创建时间"起算（而不是立刻降级）。 */
  readonly considerUnusedAsFresh: boolean
}

/** 默认策略：30 天降级、90 天归档。 */
export const DEFAULT_CURATOR_POLICY: CuratorPolicy = {
  staleAfterMs: 30 * 24 * 60 * 60 * 1000,
  archiveAfterMs: 90 * 24 * 60 * 60 * 1000,
  considerUnusedAsFresh: true,
}

/** 一次打扫的结果。 */
export interface CurateReport {
  /** 新降级为 stale 的。 */
  readonly marked: readonly string[]
  /** 新归档的（**只会是本地技能**）。 */
  readonly archived: readonly string[]
  /** 本该归档、但因为来自上游而被保住的。 */
  readonly protectedUpstream: readonly string[]
  /** 被恢复回 active 的（最近又用上了）。 */
  readonly revived: readonly string[]
}

/** Curator：负责技能的降级、归档与恢复。 */
export class Curator {
  readonly #policy: CuratorPolicy
  readonly #library: SkillLibrary

  /**
   * @param library 要打扫的技能库
   * @param policy 策略（不给用默认的 30/90 天）
   */
  constructor(library: SkillLibrary, policy: CuratorPolicy = DEFAULT_CURATOR_POLICY) {
    this.#library = library
    this.#policy = policy
  }

  /** 当前策略。 */
  get policy(): CuratorPolicy {
    return this.#policy
  }

  /**
   * 一次打扫。
   *
   * 注意它是**幂等**的：跑两次结果一样 —— 因为判断只依赖
   * "上次使用时间"与"当前状态"，不做累积计数。
   * @param now 当前时刻（便于测试注入固定时间）
   * @returns 打扫报告
   */
  review(now = Date.now()): CurateReport {
    const marked: string[] = []
    const archived: string[] = []
    const protectedUpstream: string[] = []
    const revived: string[] = []

    for (const skill of this.#library.adminList()) {
      const lastTouch = this.#lastTouch(skill)
      const idleMs = now - lastTouch
      const target = this.#targetStatus(skill, idleMs)

      if (target === skill.status) continue

      // ★ 上游技能的天花板是 stale：到这一步就停手
      if (skill.source === 'upstream' && target === 'archived') {
        if (skill.status !== 'stale') {
          this.#library.setStatus(skill.name, 'stale')
          marked.push(skill.name)
        }
        protectedUpstream.push(skill.name)
        continue
      }

      this.#library.setStatus(skill.name, target)
      if (target === 'stale') marked.push(skill.name)
      else if (target === 'archived') archived.push(skill.name)
      else revived.push(skill.name)
    }

    return { marked, archived, protectedUpstream, revived }
  }

  /**
   * 手动恢复一条技能。
   * @param name 技能名
   * @returns 恢复后的状态
   */
  restore(name: string): SkillStatus {
    return this.#library.setStatus(name, 'active').status
  }

  /**
   * 报告当前状态分布 —— "目录有多大、其中多少是死的"。
   * @returns 各状态的条数
   */
  census(): Record<SkillStatus, number> {
    const counts: Record<SkillStatus, number> = { active: 0, stale: 0, archived: 0 }
    for (const skill of this.#library.adminList()) counts[skill.status] += 1
    return counts
  }

  /** 一条技能上次被"碰"是什么时候。 */
  #lastTouch(skill: Skill): number {
    if (skill.lastUsedAt > 0) return skill.lastUsedAt
    // 从没读过：按创建时间起算，否则刚加进来的技能会立刻被判为过期
    return this.#policy.considerUnusedAsFresh ? skill.createdAt : 0
  }

  /** 按空闲时长算它应该处于什么状态。 */
  #targetStatus(skill: Skill, idleMs: number): SkillStatus {
    if (idleMs <= this.#policy.staleAfterMs) return 'active'
    if (skill.status === 'archived') return 'archived'
    // 从 active 到 archived 必须**经过** stale：多一次机会被看见
    if (skill.status === 'stale' && idleMs > this.#policy.staleAfterMs + this.#policy.archiveAfterMs) {
      return 'archived'
    }
    return 'stale'
  }
}
