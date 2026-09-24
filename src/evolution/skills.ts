/**
 * 第 13 步 ｜ 技能库：渐进式披露（progressive disclosure）
 *
 * 技能和记忆的区别，一句话：
 *
 *   记忆 = **一句话的结论**（"这个项目用 pnpm 而不是 npm"）
 *   技能 = **一段可复用的流程**（"新增一个能力插件的 6 步清单"）
 *
 * 一段流程动辄几千字。如果每次任务都把全部技能全文塞进上下文，
 * 20 个技能就是几万 token —— 而其中 19 个与当前任务无关。
 *
 * 所以技能库的核心不是"存"，而是**分两级暴露**：
 *
 *     第一级（永远可见）：  name + 一句话描述 + 触发词        ← 几十字节
 *     第二级（按需读取）：  全文                               ← 几千字节
 *
 * 模型先看目录，判断"这条与我有关"之后才去读全文。
 * 这个决定把上下文成本从"技能总数"降到"实际用到的技能数"。
 *
 * ── 代价落在谁身上？──────────────────────────────────────────────────
 *
 * 落在**模型**身上：它必须多花一次工具调用（`read`）才能拿到全文，
 * 而且它可能判断错 —— 该读的没读、不该读的读了。
 * 这就是为什么 `description` 与 `triggers` 的质量比全文更重要：
 * 目录写歪了，渐进披露就退化成"谁也找不到"。
 *
 * ── 为什么区分 upstream / local？─────────────────────────────────────
 *
 * 因为技能有两个来源：**上游带进来的**（教学材料、团队规范）和
 * **本地长出来的**（这次任务里总结出来的）。
 * 两者混在一起管理会让"这条到底是谁写的"永远说不清，
 * 而第 16 步的演化门控需要这个区分：**上游技能不允许被本地流程改写**。
 */

/** 技能从哪来。 */
export type SkillSource =
  /** 上游提供（随项目/课程带进来）—— **本地流程不得删改**。 */
  | 'upstream'
  /** 本地长出来的（Claude 式 Curator 从经历里总结）。 */
  | 'local'

/** 技能的生命周期状态。 */
export type SkillStatus = 'active' | 'stale' | 'archived'

/** 一条技能。 */
export interface Skill {
  /** 技能名（唯一，等于"要读哪一篇"的坐标）。 */
  readonly name: string
  /** 一句话描述 —— **这是渐进披露的全部预算**，写歪了就白搭。 */
  readonly description: string
  /** 触发词：任务里出现这些词时，这条技能值得被读。 */
  readonly triggers: readonly string[]
  /** 全文。 */
  readonly body: string
  /** 来源。 */
  readonly source: SkillSource
  /** 写入时刻。 */
  readonly createdAt: number
  /** 最近一次被读取的时刻；0 表示从未被读过。 */
  lastUsedAt: number
  /** 被读取过几次。 */
  useCount: number
  /** 生命周期状态。 */
  status: SkillStatus
}

/** 目录里的一条（**只含便宜字段**）。 */
export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly triggers: readonly string[]
  readonly status: SkillStatus
}

/** 新增技能时的入参。 */
export interface NewSkill {
  readonly name: string
  readonly description: string
  readonly triggers: readonly string[]
  readonly body: string
  readonly source: SkillSource
}

/** 读全文的结果。 */
export interface SkillReadResult {
  readonly name: string
  readonly body: string
  readonly triggers: readonly string[]
  readonly source: SkillSource
  readonly useCount: number
}

/**
 * 技能库。
 *
 * 它刻意**不提供** `all()` 这样的"把全文都给我"的方法 ——
 * 因为那种方法一旦存在，调用方就会（在压力下）用它，
 * 渐进披露也就名存实亡。**能拿到全文的唯一路径是 `read(name)`。**
 */
export class SkillLibrary {
  readonly #skills = new Map<string, Skill>()

  /**
   * 加一条技能。
   * @param skill 技能内容
   * @returns 存进去的技能
   * @throws name 重复时（同名技能必须先去重，不能悄悄覆盖上游的）
   */
  add(skill: NewSkill): Skill {
    if (this.#skills.has(skill.name)) {
      throw new Error(`技能名重复："${skill.name}" —— 覆盖上游技能必须显式删除后再加`)
    }
    const entry: Skill = {
      ...skill,
      createdAt: Date.now(),
      lastUsedAt: 0,
      useCount: 0,
      status: 'active',
    }
    this.#skills.set(entry.name, entry)
    return entry
  }

  /** 按名字取（含全文，**调用方自己负责不要把它塞进上下文**）。 */
  get(name: string): Skill | undefined {
    return this.#skills.get(name)
  }

  /** 技能总数。 */
  get size(): number {
    return this.#skills.size
  }

  /**
   * 第一级：目录。只返回便宜字段。
   * @param includeArchived 是否把已归档的也列出来（默认不列）
   * @returns 摘要列表
   */
  catalog(includeArchived = false): readonly SkillSummary[] {
    return [...this.#skills.values()]
      .filter((skill) => includeArchived || skill.status !== 'archived')
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
        status: skill.status,
      }))
  }

  /**
   * 第二级：读全文。**读一次就算用了一次** —— 生命周期靠它衰减。
   * @param name 技能名
   * @param now 当前时刻（便于测试注入）
   * @returns 全文与元信息
   * @throws 技能不存在时
   */
  read(name: string, now = Date.now()): SkillReadResult {
    const skill = this.#skills.get(name)
    if (skill === undefined) {
      throw new Error(`没有这个技能："${name}"；可用：${this.catalog(true).map((item) => item.name).join(', ')}`)
    }
    skill.lastUsedAt = now
    skill.useCount += 1
    return {
      name: skill.name,
      body: skill.body,
      triggers: skill.triggers,
      source: skill.source,
      useCount: skill.useCount,
    }
  }

  /**
   * 按任务文本匹配候选技能（**只返回目录条目**，不返回全文）。
   *
   * 匹配规则故意简单：触发词命中即候选，按命中数排序。
   * 复杂语义匹配的代价是把"召回"交给另一个模型 —— 那会让
   * "为什么这条技能被选中"变得不可解释，而技能库最怕的就是这个。
   * @param task 任务文本
   * @returns 命中的摘要（命中数多的在前）
   */
  match(task: string): readonly SkillSummary[] {
    const haystack = task.toLowerCase()
    const scored: { summary: SkillSummary; hits: number }[] = []

    for (const summary of this.catalog()) {
      let hits = 0
      for (const trigger of summary.triggers) {
        if (trigger !== '' && haystack.includes(trigger.toLowerCase())) hits += 1
      }
      if (hits > 0) scored.push({ summary, hits })
    }

    scored.sort((a, b) => b.hits - a.hits)
    return scored.map((item) => item.summary)
  }

  /**
   * 改一条技能的状态。**上游技能只能 active ↔ stale**，不允许归档 ——
   * 归档意味着"它不再出现在目录里"，而那是删除的委婉说法。
   * @param name 技能名
   * @param status 目标状态
   * @throws 技能不存在、或试图归档上游技能时
   */
  setStatus(name: string, status: SkillStatus): Skill {
    const skill = this.#skills.get(name)
    if (skill === undefined) throw new Error(`没有这个技能："${name}"`)
    if (skill.source === 'upstream' && status === 'archived') {
      throw new Error(`上游技能不能被归档："${name}"（请改描述或加一条本地技能替代它）`)
    }
    skill.status = status
    return skill
  }

  /** 删除（只允许删本地技能）。 */
  remove(name: string): boolean {
    const skill = this.#skills.get(name)
    if (skill === undefined) return false
    if (skill.source === 'upstream') {
      throw new Error(`上游技能不能被删除："${name}"`)
    }
    return this.#skills.delete(name)
  }

  /** 全部技能（**管理用途**：Curator、导出、审计；不要用于喂上下文）。 */
  adminList(): readonly Skill[] {
    return [...this.#skills.values()]
  }
}
