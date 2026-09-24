/**
 * 第 14 步 ｜ recall：用 FTS5 检索历史
 *
 * "agent 记得三个月前那次失败"听起来像魔法，其实是**索引**问题：
 * 会话日志已经是 append-only 的事实流，缺的只是"按内容找回来"的能力。
 *
 * ── 为什么不用 embeddings？────────────────────────────────────────────
 *
 * 向量检索更"聪明"，但在这个场景里有三个具体劣势：
 *
 *   1. **要模型**：零依赖前提下没有本地编码器，每次检索都要调 API
 *   2. **不可解释**：命中了但说不出"为什么它匹配" —— 而审计要这个答案
 *   3. **不能精确**：搜 `pathGuard` 这种标识符时，字面匹配天然更准
 *
 * 而日志检索的真实查询几乎都是"找那句话/那个文件/那个错误码" —— 字面题。
 * 所以选 FTS5：它是 SQLite 自带的、零依赖的、可解释的倒排索引。
 *
 * ── 一个必须处理的细节：中文 ─────────────────────────────────────────
 *
 * FTS5 默认的 `unicode61` 分词器把连续 CJK 当**一个 token** ——
 * 也就是说"读取文件失败了"会被当成一个词，搜"读取"搜不到。
 * 解法是 `tokenize='trigram'`：按 3 字符滑窗建索引。它对中文有效，
 * 代价是**查询至少要有 3 个字符**，短查询得走 LIKE 回退。
 *
 * （Node 的 `node:sqlite` 是实验性 API，会打印一条 ExperimentalWarning。
 * 这是"零依赖"的直接后果 —— 用内置能力替代 npm 包。)
 */

import { DatabaseSync } from 'node:sqlite'

/** 一条被索引的事件。 */
export interface IndexedEvent {
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly text: string
}

/** 一次命中的结果。 */
export interface RecallHit extends IndexedEvent {
  /** 相关性分数，**越大越相关**（已把 bm25 的负值翻正）。 */
  readonly score: number
}

/** trigram 分词器要求的最小查询长度。 */
export const MIN_MATCH_LENGTH = 3

/**
 * 历史事件索引。
 *
 * 它是**纯存储组件**：不认识框架，输入是事件文本，输出是命中。
 * 接进 agent 的活在 `plugins/evolution.ts` 里。
 */
export class RecallIndex {
  readonly #db: DatabaseSync
  readonly #location: string

  /**
   * @param location 数据库路径；`:memory:` 表示只在内存里（默认）
   */
  constructor(location = ':memory:') {
    this.#location = location
    this.#db = new DatabaseSync(location)
    // trigram：让中文可检索；session_id / seq / type 是元数据，不参与分词
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
      USING fts5(session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, text, tokenize='trigram')
    `)
  }

  /** 索引所在位置。 */
  get location(): string {
    return this.#location
  }

  /** 已索引的事件数。 */
  get size(): number {
    const row = this.#db.prepare('SELECT count(*) AS n FROM events_fts').get() as { n: number }
    return row.n
  }

  /**
   * 索引一条事件。
   * @param event 事件文本与元数据
   */
  index(event: IndexedEvent): void {
    this.#db
      .prepare('INSERT INTO events_fts(session_id, seq, type, text) VALUES (?, ?, ?, ?)')
      .run(event.sessionId, event.seq, event.type, event.text)
  }

  /**
   * 批量索引。
   * @param events 事件列表
   */
  indexMany(events: readonly IndexedEvent[]): void {
    // 手动事务：几百条逐条提交会慢一个数量级
    this.#db.exec('BEGIN')
    try {
      for (const event of events) this.index(event)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 检索。
   *
   * 长查询走 FTS5（按相关性排序），短查询回退 LIKE（trigram 索引不到）。
   * @param query 查询词
   * @param limit 最多几条
   * @returns 命中（按相关性降序）
   */
  search(query: string, limit = 5): readonly RecallHit[] {
    const trimmed = query.trim()
    if (trimmed === '') return []

    if (trimmed.length < MIN_MATCH_LENGTH) return this.#searchLike(trimmed, limit)

    // MATCH 里的引号必须转义成两个 —— 否则用户输入的引号会变成语法错误
    const phrase = `"${trimmed.replace(/"/g, '""')}"`
    try {
      const rows = this.#db
        .prepare(`
          SELECT session_id, seq, type, text, bm25(events_fts) AS rank
          FROM events_fts
          WHERE events_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(phrase, limit) as { session_id: string; seq: number; type: string; text: string; rank: number }[]

      return rows.map((row) => ({
        sessionId: row.session_id,
        seq: row.seq,
        type: row.type,
        text: row.text,
        // bm25 越小越相关（负数），翻成"越大越相关"更符合直觉
        score: -row.rank,
      }))
    } catch {
      // FTS 语法错误（奇怪的输入）不该让检索整个失败 —— 退回 LIKE
      return this.#searchLike(trimmed, limit)
    }
  }

  /**
   * 按类型列出最近的若干条（"把最近 3 次失败给我看看"）。
   * @param type 事件类型
   * @param limit 最多几条
   * @returns 命中（按 seq 降序）
   */
  recent(type: string, limit = 5): readonly RecallHit[] {
    const rows = this.#db
      .prepare('SELECT session_id, seq, type, text FROM events_fts WHERE type = ? ORDER BY seq DESC LIMIT ?')
      .all(type, limit) as { session_id: string; seq: number; type: string; text: string }[]

    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      text: row.text,
      score: 0,
    }))
  }

  /** 清空索引（重建时用）。 */
  clear(): void {
    this.#db.exec('DELETE FROM events_fts')
  }

  /** 关闭数据库。 */
  close(): void {
    this.#db.close()
  }

  /** 短查询回退：LIKE 子串匹配。 */
  #searchLike(term: string, limit: number): readonly RecallHit[] {
    const rows = this.#db
      .prepare('SELECT session_id, seq, type, text FROM events_fts WHERE text LIKE ? LIMIT ?')
      .all(`%${term}%`, limit) as { session_id: string; seq: number; type: string; text: string }[]

    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      text: row.text,
      // LIKE 没有相关性分数：用"命中位置占比"给一个粗糙的排序依据
      score: 1 / Math.max(1, row.text.length),
    }))
  }
}

/**
 * 从会话事件里取出一段可检索的文本。
 *
 * 为什么不让调用方把整个 `data` 直接 JSON 化？
 * 因为那会把字段名（`toolCallId` 之类）也塞进索引，于是搜 `id` 命中一切。
 * 只索引**有语义的那部分**，索引才有用。
 * @param type 事件类型
 * @param data 事件数据
 * @returns 要索引的文本（空串表示这条不值得索引）
 */
export function searchableTextOf(type: string, data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>

  if (type === 'user/message') return typeof record.text === 'string' ? record.text : ''
  if (type === 'assistant/message') return typeof record.content === 'string' ? record.content : ''
  if (type === 'tool/result') {
    const name = typeof record.name === 'string' ? record.name : ''
    const content = typeof record.content === 'string' ? record.content : ''
    return `${name} ${content}`
  }
  if (type === 'assistant/attempt') {
    return `${String(record.code ?? '')} ${String(record.message ?? '')}`
  }
  if (type === 'tool/guard') return `${String(record.byRule ?? '')} ${String(record.detail ?? '')}`
  return ''
}
