/**
 * 第 12 步 ｜ 有界记忆：为什么"能记住"必须先能"记不下"
 *
 * 一个直觉的做法是给 agent 一个 `remember(text)`，然后它就越记越多。
 * 这条路在真实使用里会以三种方式坏掉：
 *
 *   1. **无界增长**：记忆迟早撑爆上下文预算，于是"记住它"变成"拖垮它"
 *   2. **无出处**：一条记忆从哪来？没有出处就无法复核，也无法在它错了时删掉
 *   3. **无替换**：两条互相矛盾的记忆会一直共存，模型每次都要自己挑一个信
 *
 * 所以这个模块的核心决定是：**容量是硬上限，写满即拒绝**。
 * 拒绝不是失败，而是把"你该合并了"这件事**显式化**：
 *
 *     memory.add(...)   // 满了 → 抛 MemoryFullError，并给出合并建议
 *     memory.merge(ids) // 合并 k 条为 1 条 —— 这是唯一能腾出空间的方式
 *
 * ── 为什么"合并"而不是"淘汰最旧"？────────────────────────────────────
 *
 * 淘汰最旧（LRU/FIFO）在缓存里是对的，在**记忆**里是错的：
 * 最旧的那条可能正是"用户从一开始就强调的约束"。
 * 合并则把它保住：两条关于同一件事的记忆合成一条更准的，信息不丢、条目变少。
 * 代价是"谁来合并"变成了必须回答的问题 —— 我们把它交给模型（见 nudge），
 * 因为只有它知道两条记忆说的是不是同一件事。
 *
 * ── 为什么每条记忆必须有 source？──────────────────────────────────────
 *
 * 因为"派生结论而非存原文"（第 14 步）要求任何结论都能**回到原始事件**。
 * `source` 是那条回程路：界面显示"这条记忆来自第 3 次任务的第 17 条事件"，
 * 用户就能去核对；没有它，记忆库就是一个不可审计的传言集散地。
 */

/** 一条记忆从哪来 —— 回到原始事件的坐标。 */
export interface MemorySource {
  /** 会话 id。 */
  readonly sessionId: string
  /** 事件序号（`SessionEvent.seq`）。 */
  readonly seq: number
}

/** 一条记忆。 */
export interface MemoryEntry {
  /** 唯一 id，形如 `mem-3`。合并与删除都靠它。 */
  readonly id: string
  /** 结论本身 —— **不是**原始对话，是提炼后的一句话。 */
  readonly text: string
  /** 作用范围：`global` 跟随用户，`project` 只对本项目有效。 */
  readonly scope: 'global' | 'project'
  /** 出处。 */
  readonly source: MemorySource
  /** 写入时刻（毫秒）。 */
  readonly createdAt: number
  /**
   * 置信度 0–1。
   * 为什么需要它？因为"用户明确说过的"和"模型推断出来的"不该同等对待，
   * 而合并时我们要保留更可信的那条。
   */
  readonly confidence: number
  /** 这条记忆被合并过几次（0 表示始终独立）。 */
  readonly mergedFrom: number
}

/** 写新条目时的入参（id 与时间由记忆库生成）。 */
export type MemoryDraft = Omit<MemoryEntry, 'id' | 'createdAt' | 'mergedFrom'> & {
  readonly mergedFrom?: number
}

/**
 * 记忆库已满。
 *
 * 它携带**合并建议**而不是只有一个"满了" —— 因为调用方（模型）需要的是
 * "接下来该做什么"，不是"你失败了"。异常里带上可执行的信息，
 * 是"失败要能被自动处理"的最低要求。
 */
export class MemoryFullError extends Error {
  /** 建议合并的条目 id（按"最该合并"排序）。 */
  readonly suggestions: readonly string[]
  /** 当前容量。 */
  readonly limit: number

  /**
   * @param limit 容量上限
   * @param suggestions 建议合并的 id
   */
  constructor(limit: number, suggestions: readonly string[]) {
    super(
      `记忆库已满（${limit} 条）。请先用 merge(ids, text) 合并以下条目之一：` +
        `${suggestions.length === 0 ? '(无可用建议)' : suggestions.join(' / ')}`,
    )
    this.name = 'MemoryFullError'
    this.limit = limit
    this.suggestions = suggestions
  }
}

/** 两个 id 是否相关（用于给出合并建议）。 */
function relatedness(a: MemoryEntry, b: MemoryEntry): number {
  if (a.scope !== b.scope) return 0
  // 极简的"词重叠"相似度：不引入分词依赖，但足以把同话题的条目排到前面
  const words = (text: string): Set<string> =>
    new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2))
  const left = words(a.text)
  const right = words(b.text)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/**
 * 有界记忆库。
 *
 * 它是**纯数据结构**：不认识 Context、不认识会话、不写磁盘格式以外的东西。
 * 接进框架的活在 `plugins/evolution.ts` 里 —— 依赖方向因此保持单向。
 */
export class BoundedMemory {
  readonly #limit: number
  readonly #entries: MemoryEntry[] = []
  #nextId = 1

  /**
   * @param limit 容量上限（必须为正整数）
   * @param entries 初始条目（用于从磁盘恢复）
   * @throws limit 非法时
   */
  constructor(limit: number, entries: readonly MemoryEntry[] = []) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`记忆库容量必须是正整数，收到 ${String(limit)}`)
    }
    this.#limit = limit
    for (const entry of entries) {
      this.#entries.push(entry)
      const numeric = Number.parseInt(entry.id.replace(/^mem-/, ''), 10)
      if (Number.isInteger(numeric) && numeric >= this.#nextId) this.#nextId = numeric + 1
    }
  }

  /** 容量上限。 */
  get limit(): number {
    return this.#limit
  }

  /** 当前条数。 */
  get size(): number {
    return this.#entries.length
  }

  /** 是否已满。 */
  get full(): boolean {
    return this.#entries.length >= this.#limit
  }

  /** 全部条目（按写入顺序）。 */
  list(): readonly MemoryEntry[] {
    return [...this.#entries]
  }

  /**
   * 写入一条记忆。
   * @param draft 条目内容（id 与时间由本方法生成）
   * @returns 真正写进去的条目
   * @throws {@link MemoryFullError} 已满时 —— **不静默丢弃最旧的**
   */
  add(draft: MemoryDraft): MemoryEntry {
    if (this.full) throw new MemoryFullError(this.#limit, this.suggestMerge())

    const entry: MemoryEntry = {
      id: `mem-${this.#nextId}`,
      createdAt: Date.now(),
      mergedFrom: draft.mergedFrom ?? 0,
      text: draft.text,
      scope: draft.scope,
      source: draft.source,
      confidence: draft.confidence,
    }
    this.#nextId += 1
    this.#entries.push(entry)
    return entry
  }

  /**
   * 合并若干条为一条：腾出空间，同时保留信息。
   * @param ids 要被合并掉的条目 id（至少两条）
   * @param text 合并后的新结论
   * @param source 新结论的出处（一般是其中最新那条）
   * @returns 合并后的条目
   * @throws ids 少于两条、或有不存在的 id 时
   */
  merge(ids: readonly string[], text: string, source: MemorySource): MemoryEntry {
    if (ids.length < 2) {
      throw new Error('合并至少要两条 —— 一条的话请直接改它的内容，不需要 merge')
    }

    const targets = ids.map((id) => {
      const found = this.#entries.find((entry) => entry.id === id)
      if (found === undefined) throw new Error(`要合并的条目不存在：${id}`)
      return found
    })

    const merged: MemoryEntry = {
      id: `mem-${this.#nextId}`,
      createdAt: Date.now(),
      // 记录"这条是 3 条合出来的" —— 否则记忆库会看起来像丢了信息
      mergedFrom: targets.reduce((sum, entry) => sum + entry.mergedFrom + 1, 0),
      text,
      // 合并后的范围取更保守的那个（project 比 global 更受限）
      scope: targets.every((entry) => entry.scope === 'global') ? 'global' : 'project',
      source,
      // 合并通常提升可信度，但不超过 1
      confidence: Math.min(1, Math.max(...targets.map((entry) => entry.confidence)) + 0.05),
    }
    this.#nextId += 1

    const removeIds = new Set(ids)
    const kept = this.#entries.filter((entry) => !removeIds.has(entry.id))
    this.#entries.length = 0
    this.#entries.push(...kept, merged)
    return merged
  }

  /**
   * 删掉一条（用户明确否定它时用）。
   * @param id 条目 id
   * @returns 是否真的删掉了
   */
  remove(id: string): boolean {
    const index = this.#entries.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    this.#entries.splice(index, 1)
    return true
  }

  /** 按 id 取一条。 */
  get(id: string): MemoryEntry | undefined {
    return this.#entries.find((entry) => entry.id === id)
  }

  /**
   * 给出"该合并哪几条"的建议：同范围内最相似的一对，各配上最相似的另一条。
   *
   * 它服务的是"写满时模型该怎么办" —— 所以建议必须是**可直接执行**的 id 组合，
   * 而不是"你考虑合并一下"。
   * @returns 建议的 id 列表（可为空）
   */
  suggestMerge(): string[] {
    const candidates: { ids: string[]; score: number }[] = []
    for (let i = 0; i < this.#entries.length; i += 1) {
      for (let j = i + 1; j < this.#entries.length; j += 1) {
        const left = this.#entries[i] as MemoryEntry
        const right = this.#entries[j] as MemoryEntry
        const score = relatedness(left, right)
        if (score > 0) candidates.push({ ids: [left.id, right.id], score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, 3).flatMap((candidate) => candidate.ids)
  }

  /** 序列化（供磁盘持久化）。 */
  toJSON(): { limit: number; entries: readonly MemoryEntry[] } {
    return { limit: this.#limit, entries: this.list() }
  }
}
