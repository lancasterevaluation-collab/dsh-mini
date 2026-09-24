/**
 * 第 16 步 ｜ evolve：演化门控 —— 允许自改，但必须**过闸**
 *
 * 到第 15 步为止，系统能观察自己、能归因、能量化。最后一块拼图是**改自己**。
 * 而"改自己"最容易出的错不是"改错了"，是**改得看起来对**：
 *
 *     模型发现"把步数上限从 8 调到 20，那次失败的任务就过了"
 *     → 于是它把上限调成 200
 *     → 三个任务之后，token 账单涨了 10 倍，而每个任务"都成功了"
 *
 * 这个例子说明：**单看一次改动的效果，无法判断它是不是退步**。
 * 所以门控的核心不是"评估这次改动好不好"，而是
 *
 *     ★ 拿一组"已经通过的任务"当基线，改动之后必须仍然全通过 ★
 *
 * 这一条就能挡住上面那类错误：把上限调大之后，"预算内收工"那几条会挂。
 *
 * ── 四道闸，从便宜到昂贵 ─────────────────────────────────────────────
 *
 *   | 闸 | 检查什么 | 为什么放在这个位置 |
 *   |---|---|---|
 *   | 白名单 | 允许改哪一类东西（memory/skill/config，不许改源码） | 最便宜，且能挡住最危险的一类 |
 *   | 安全闸 | 不许削弱守卫规则、不许扩大权限 | 与"白名单"并列，都是确定性规则 |
 *   | 回归闸 | 已通过的用例必须仍然通过 | 昂贵（要真跑），但这是**唯一能发现退化的闸** |
 *   | 回滚闸 | 任一闸失败 → 撤销改动并如实记录 | 让"失败了"不等于"留下烂摊子" |
 *
 * ── 为什么"提案"要带 revert？──────────────────────────────────────────
 *
 * 因为门控是**先应用、后验证**（不应用就没法知道效果）。
 * 这意味着每次被拒绝的提案都已经动过状态了 —— 没有 revert 就等于
 * "试错总会留下痕迹"，而痕迹累积起来就是行为漂移。
 */

import type { AuditLog, AuditOutcome } from './audit.ts'

/** 允许自改的类别。 */
export type ChangeKind =
  /** 记忆（合并、删除、调上限）。 */
  | 'memory'
  /** 技能（新增、降级、归档）。 */
  | 'skill'
  /** 配置（用户模型、nudge 规则参数）。 */
  | 'config'

/** 一条"已通过"的回归用例。 */
export interface RegressionCase {
  /** 用例名。 */
  readonly name: string
  /**
   * 跑一次，返回是否通过。
   * @returns 通过为 true
   */
  readonly run: () => boolean | Promise<boolean>
}

/** 一次自改提案。 */
export interface Proposal {
  /** 提案名（会写进审计）。 */
  readonly action: string
  /** 类别。 */
  readonly kind: ChangeKind
  /** 改动对象。 */
  readonly target: string
  /** 凭什么改。 */
  readonly rationale: string
  /** 证据。 */
  readonly evidence: readonly string[];
  /** 改动前的状态。 */
  readonly before: unknown
  /** 改动后的状态。 */
  readonly after: unknown
  /** 应用改动。 */
  readonly apply: () => void | Promise<void>
  /** 撤销改动。 */
  readonly revert: () => void | Promise<void>
}

/** 一道闸的结果。 */
export interface CheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

/** 门控裁决。 */
export interface GateVerdict {
  readonly allowed: boolean
  /** 拒绝的理由（允许时为空串）。 */
  readonly reason: string
  readonly checks: readonly CheckResult[]
}

/** 一次提案的完整结果。 */
export interface ProposalOutcome {
  readonly accepted: boolean
  readonly verdict: GateVerdict
  /** 审计记录 id（无论接受还是拒绝都有）。 */
  readonly auditId: string
  /** 回归结果（如果跑到那一步）。 */
  readonly regression: readonly { readonly name: string; readonly passed: boolean }[]
}

/** 门控的配置。 */
export interface GateOptions {
  /** 审计链。 */
  readonly audit: AuditLog
  /** 回归用例集。 */
  readonly cases: readonly RegressionCase[]
  /** 允许的类别；不给 = 三类都允许。 */
  readonly allowKinds?: readonly ChangeKind[]
  /** 不许触碰的目标（前缀匹配）。 */
  readonly protectedTargets?: readonly string[]
  /** 执行者标识。 */
  readonly actor?: string
}

/**
 * 默认保护的目标：源码、安全策略、能力装载。
 *
 * ★ 为什么整个 `src/` 都在里面？★
 * 因为自改的边界应该是**数据**（记忆、技能、配置），不是**机制**。
 * 一个能改自己源码的 agent，它的审计链就失去意义了 ——
 * 记录说"我改的是记忆"，而实际动作可以改掉记录本身。
 * 把源码挡在门外，审计才有立足点。
 */
export const DEFAULT_PROTECTED_TARGETS: readonly string[] = [
  'src/',
  'guard:',
  'capability:',
]

/**
 * 演化门控。
 *
 * 一次 `propose()` 的完整时序是刻意固定的：
 *
 *     白名单 → 保护名单 → 应用 → 回归 → 通过则留、失败则回滚 → 审计
 *
 * 注意"应用"在"回归"之前：不真改就没法验证。所以回滚路径必须可靠，
 * 而它可靠的方式很简单 —— `revert` 由提案自己提供，门控只负责**一定调用它**。
 */
export class EvolutionGate {
  readonly #options: GateOptions

  /**
   * @param options 门控配置
   */
  constructor(options: GateOptions) {
    this.#options = options
  }

  /** 当前回归用例名。 */
  caseNames(): string[] {
    return this.#options.cases.map((item) => item.name)
  }

  /**
   * 跑一遍回归，不改任何东西。
   * @returns 每条用例的结果
   */
  async runRegression(): Promise<{ readonly name: string; readonly passed: boolean }[]> {
    const results: { name: string; passed: boolean }[] = []
    for (const item of this.#options.cases) {
      let passed = false
      try {
        passed = await item.run()
      } catch {
        // 用例抛错 = 没通过（不是"跳过"）—— 静默跳过会让基线虚高
        passed = false
      }
      results.push({ name: item.name, passed })
    }
    return results
  }

  /**
   * 提交一次自改。
   * @param proposal 提案
   * @returns 结果（含审计 id）
   */
  async propose(proposal: Proposal): Promise<ProposalOutcome> {
    const checks: CheckResult[] = []
    const actor = this.#options.actor ?? 'agent'
    const allowKinds = this.#options.allowKinds ?? ['memory', 'skill', 'config']
    const protectedTargets = this.#options.protectedTargets ?? DEFAULT_PROTECTED_TARGETS

    // ① 白名单
    const kindAllowed = allowKinds.includes(proposal.kind)
    checks.push({
      name: 'whitelist',
      passed: kindAllowed,
      detail: kindAllowed ? `类别 ${proposal.kind} 允许` : `类别 ${proposal.kind} 不在允许列表 ${allowKinds.join(', ')}`,
    })

    // ② 保护名单
    const hit = protectedTargets.find((prefix) => proposal.target.startsWith(prefix))
    const targetAllowed = hit === undefined
    checks.push({
      name: 'protected-targets',
      passed: targetAllowed,
      detail: targetAllowed ? `目标 ${proposal.target} 不受保护` : `目标 ${proposal.target} 命中保护前缀 "${hit}"`,
    })

    if (!kindAllowed || !targetAllowed) {
      const reason = checks.filter((check) => !check.passed).map((check) => check.detail).join('；')
      const auditId = this.#record(actor, proposal, 'rejected', reason)
      return { accepted: false, verdict: { allowed: false, reason, checks }, auditId, regression: [] }
    }

    // ③ 应用（先改后验：不真改就不知道效果）
    await proposal.apply()

    // ④ 回归
    const regression = await this.runRegression()
    const failed = regression.filter((item) => !item.passed)
    checks.push({
      name: 'regression',
      passed: failed.length === 0,
      detail:
        failed.length === 0
          ? `${regression.length} 条用例全部通过`
          : `${failed.length}/${regression.length} 条退化：${failed.map((item) => item.name).join(', ')}`,
    })

    if (failed.length > 0) {
      // ⑤ 回滚 —— 被拒绝的提案不能留下痕迹
      let rollbackDetail = '已回滚'
      try {
        await proposal.revert()
      } catch (error) {
        rollbackDetail = `回滚失败：${error instanceof Error ? error.message : String(error)}`
      }
      const reason = `${checks[checks.length - 1]?.detail ?? ''}（${rollbackDetail}）`
      const auditId = this.#record(actor, proposal, 'rolled-back', reason)
      return { accepted: false, verdict: { allowed: false, reason, checks }, auditId, regression }
    }

    const auditId = this.#record(
      actor,
      proposal,
      'accepted',
      `全部 ${regression.length} 条回归用例通过`,
    )
    return { accepted: true, verdict: { allowed: true, reason: '', checks }, auditId, regression }
  }

  /**
   * 手动回滚一条已接受的改动。
   * @param auditId 审计记录 id
   * @param revert 回滚动作
   * @returns 审计记录 id
   */
  async rollback(auditId: string, revert: () => void | Promise<void>): Promise<string> {
    const entry = this.#options.audit.get(auditId)
    if (entry === undefined) throw new Error(`没有这条审计记录：${auditId}`)

    await revert()
    return this.#options.audit.append({
      actor: this.#options.actor ?? 'agent',
      action: 'rollback',
      target: entry.target,
      rationale: `回滚 ${auditId}`,
      evidence: [`原记录 ${auditId}`],
      before: entry.after,
      after: entry.before,
      outcome: 'rolled-back',
      detail: `由 ${auditId} 引入的改动已被撤销`,
    }).id
  }

  /** 写一条审计记录。 */
  #record(actor: string, proposal: Proposal, outcome: AuditOutcome, detail: string): string {
    const entry = this.#options.audit.append({
      actor,
      action: proposal.action,
      target: proposal.target,
      rationale: proposal.rationale,
      evidence: proposal.evidence,
      before: proposal.before,
      after: proposal.after,
      outcome,
      detail,
    })
    return entry.id
  }
}
