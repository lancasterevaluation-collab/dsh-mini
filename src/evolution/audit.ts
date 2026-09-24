/**
 * 第 16 步 ｜ audit：审计链 —— 每一次自改都要能被复算
 *
 * 到这一步，系统已经能改自己了（记忆、技能、配置）。于是出现一个新问题，
 * 而且是所有"自改系统"共同的问题：
 *
 *     三天后模型的行为变了，你能说出**是哪一次改动、凭什么、结果如何**吗？
 *
 * 没有审计链的话，答案是"不能"。而"不能"的后果不是学术性的 ——
 * 它意味着你不敢让系统自改，于是前面 15 步的价值归零。
 *
 * ── 为什么是链（hash chain）而不是一张表？────────────────────────────
 *
 * 一张表能回答"改过什么"，但回答不了"**这份记录本身有没有被改过**"。
 * 把每条记录的哈希算进下一条（`hash = H(prevHash + 本条内容)`），
 * 就得到一个可验证的结构：
 *
 *     任何一条被篡改 → 它的 hash 对不上 → 从它开始后面全部对不上
 *
 * 这不是为了防攻击者（他能改代码），而是为了**防自己**：
 * 一个"顺手补一下上次记录"的改动会立刻暴露，而不是三个月后
 * 变成一段谁也解释不清的历史。
 *
 * ── 为什么记录里必须有 rationale 与 evidence？────────────────────────
 *
 * 因为可复算的意思是"**当时的信息现在还能重建**"。
 * 只写"把 memory 上限从 20 调到 30"是不够的：凭什么调？
 * 没有 rationale 的记录，三个月后和没有记录的区别不大。
 */

import { createHash } from 'node:crypto'

/** 一次改动的结局。 */
export type AuditOutcome = 'accepted' | 'rejected' | 'rolled-back'

/** 审计链里的一条。 */
export interface AuditEntry {
  /** 记录 id，形如 `audit-3`。 */
  readonly id: string
  /** 发生时刻。 */
  readonly time: number
  /** 谁改的：`agent`（自改）或 `human`。 */
  readonly actor: string
  /** 动作类型（`memory.merge` / `skill.archive` / `config.patch`…）。 */
  readonly action: string
  /** 改动对象。 */
  readonly target: string
  /** **凭什么** —— 这次改动的理由。 */
  readonly rationale: string
  /** 证据（引用的事件坐标、指标、回归结果）。 */
  readonly evidence: readonly string[]
  /** 改动前的状态（可 JSON 序列化）。 */
  readonly before: unknown
  /** 改动后的状态。 */
  readonly after: unknown
  /** 结局。 */
  readonly outcome: AuditOutcome
  /** 细节说明（拒绝原因 / 回归结果）。 */
  readonly detail: string
  /** 上一条的哈希（创世记录为固定前缀）。 */
  readonly prevHash: string
  /** 本条哈希。 */
  readonly hash: string
}

/** 创世哈希：让"第一条之前"也有个确定的值。 */
export const GENESIS_HASH = '0'.repeat(64)

/**
 * 审计链。
 *
 * 只追加、可验证、可复算。它**不做决策** —— 谁该被允许改什么是
 * `evolve.ts` 的事；这里只负责"如实记下来，并且证明没改过"。
 */
export class AuditLog {
  readonly #entries: AuditEntry[] = []
  #nextId = 1

  /** 全部记录（按时间顺序）。 */
  list(): readonly AuditEntry[] {
    return [...this.#entries]
  }

  /** 记录条数。 */
  get size(): number {
    return this.#entries.length
  }

  /** 链尾哈希。 */
  get headHash(): string {
    const last = this.#entries[this.#entries.length - 1]
    return last === undefined ? GENESIS_HASH : last.hash
  }

  /**
   * 追加一条记录。
   * @param draft 除 id / time / 哈希之外的全部字段
   * @returns 写入的记录
   */
  append(draft: Omit<AuditEntry, 'id' | 'time' | 'prevHash' | 'hash'>): AuditEntry {
    const prevHash = this.headHash
    const time = Date.now()
    const id = `audit-${this.#nextId}`
    this.#nextId += 1

    const hash = hashOf(prevHash, { id, time, ...draft })
    const entry: AuditEntry = { id, time, prevHash, hash, ...draft }
    this.#entries.push(entry)
    return entry
  }

  /** 按 id 取一条。 */
  get(id: string): AuditEntry | undefined {
    return this.#entries.find((entry) => entry.id === id)
  }

  /**
   * 校验链的完整性。
   * @returns 合法时 `ok: true`；否则给出**第一处**断裂的 id 与原因
   */
  verify(): { readonly ok: boolean; readonly brokenAt?: string; readonly reason?: string } {
    let expectedPrev = GENESIS_HASH
    for (const entry of this.#entries) {
      if (entry.prevHash !== expectedPrev) {
        return { ok: false, brokenAt: entry.id, reason: `prevHash 不匹配（期望 ${expectedPrev.slice(0, 12)}…）` }
      }
      const recomputed = hashOf(expectedPrev, {
        id: entry.id,
        time: entry.time,
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        rationale: entry.rationale,
        evidence: entry.evidence,
        before: entry.before,
        after: entry.after,
        outcome: entry.outcome,
        detail: entry.detail,
      })
      if (recomputed !== entry.hash) {
        return { ok: false, brokenAt: entry.id, reason: '内容与哈希不一致（记录被改过）' }
      }
      expectedPrev = entry.hash
    }
    return { ok: true }
  }

  /**
   * 复算一次改动：把"当时凭什么"重新摊开。
   * @param id 记录 id
   * @returns 记录与一份可读的复算报告
   * @throws id 不存在时
   */
  replay(id: string): { readonly entry: AuditEntry; readonly report: string } {
    const entry = this.get(id)
    if (entry === undefined) throw new Error(`没有这条审计记录：${id}`)

    const report = [
      `# ${entry.id}  ${new Date(entry.time).toISOString()}`,
      `执行者：${entry.actor}`,
      `动作：${entry.action} → ${entry.target}`,
      `理由：${entry.rationale}`,
      `证据：${entry.evidence.length === 0 ? '(无)' : entry.evidence.join(' | ')}`,
      `改动：${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)}`,
      `结局：${entry.outcome}（${entry.detail}）`,
      `链：${entry.prevHash.slice(0, 12)}… → ${entry.hash.slice(0, 12)}…`,
    ].join('\n')

    return { entry, report }
  }

  /** 导出（用于落盘或对比）。 */
  toJSON(): readonly AuditEntry[] {
    return this.list()
  }
}

/** 计算一条记录的内容哈希。 */
function hashOf(prevHash: string, payload: unknown): string {
  return createHash('sha256').update(`${prevHash}\n${stableStringify(payload)}`).digest('hex')
}

/**
 * 稳定序列化：键按字典序输出。
 *
 * 为什么不能直接用 `JSON.stringify`？因为对象的键顺序不同会算出不同哈希，
 * 而"同一条记录重新算哈希"在存取一轮之后就可能在键顺序上变了 ——
 * 结果是一个假报警，比没有校验更糟（它教人忽略报警）。
 * @param value 任意可序列化值
 * @returns 稳定字符串
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
