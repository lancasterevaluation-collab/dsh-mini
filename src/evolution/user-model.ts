/**
 * 第 14 步 ｜ 用户建模：**派生结论，而不是存原文**
 *
 * 最容易走错的一步是把它做成"对话存档"：
 *
 *     用户: 你好，帮我看看这个项目
 *     用户: 顺便把 README 更新一下
 *     ... 500 条原文 ...
 *
 * 存原文有三个代价，每一个都会在真实使用里咬人：
 *
 *   1. **不可用**：下次任务开始时，你要么全塞进上下文（贵），要么不塞（白存）
 *   2. **不可纠**：用户改主意了，旧原文还在，"以哪句为准"没有答案
 *   3. **不可信**：原文里一次性的口误，会被当成长期偏好
 *
 * 所以这里只存**结论**，而且每条结论都带两样东西：
 *
 *     evidence      —— 它凭什么（指回具体事件，可复核、可反驳）
 *     observations  —— 它被观察到几次（重复出现的才是偏好，一次只是噪声）
 *
 * ── 置信度为什么是"次数"的函数，而不是模型自报的？───────────────────
 *
 * 让模型自报"我有 0.8 的把握"是没用的：它的把握既不校准也不可比较。
 * 而"同一个结论在 5 次任务里出现过"是一个**可验证的事实**。
 * 所以置信度用观测次数算：`1 - 1/(n+1)` —— 一次 0.5、三次 0.75、九次 0.9。
 * 它单调、有界、可解释，而且不需要模型配合。
 */

import type { MemorySource } from './memory.ts'

/** 结论的类别。 */
export type ConclusionKind =
  /** 偏好：怎么回答（长度、风格、语言）。 */
  | 'preference'
  /** 约束：不能违反的事实（路径、技术选型、禁止项）。 */
  | 'constraint'
  /** 主题：反复出现的关注点（用于排序与提醒）。 */
  | 'topic'

/** 一次观测到的信号（尚未合并进结论）。 */
export interface UserSignal {
  readonly kind: ConclusionKind
  /** 提炼后的说法 —— **不是原文**。 */
  readonly text: string
  /** 出处。 */
  readonly evidence: MemorySource
}

/** 一条用户结论。 */
export interface UserConclusion {
  readonly id: string
  readonly kind: ConclusionKind
  readonly text: string
  /** 全部出处（按时间顺序）。 */
  readonly evidence: readonly MemorySource[]
  /** 被观察到几次。 */
  readonly observations: number
  /** 由 observations 算出的置信度 0–1。 */
  readonly confidence: number
}

/** 由观测次数算置信度：单调、有界、不需要模型自报。 */
export function confidenceOf(observations: number): number {
  if (observations <= 0) return 0
  return 1 - 1 / (observations + 1)
}

/**
 * 从一段任务文本里提取信号。
 *
 * 为什么用规则而不是让模型自己总结？
 *   因为**可解释**：用户问"你凭什么认为我偏好简短回答"，
 *   规则能给出命中的那句话；模型总结只能给出"我觉得"。
 *   规则会漏，但漏掉的代价（少一条偏好）远小于误判的代价（错误的长期约束）。
 * @param task 任务文本
 * @param source 出处（会话 + 事件序号）
 * @returns 提取到的信号（可能为空）
 */
export function extractSignals(task: string, source: MemorySource): readonly UserSignal[] {
  const signals: UserSignal[] = []
  const text = task.toLowerCase()

  const preferenceRules: readonly { readonly pattern: RegExp; readonly text: string }[] = [
    { pattern: /(简短|简洁|少废话|一句话|别啰嗦|简短点)/, text: '用户偏好简短的回答' },
    { pattern: /(详细|展开|解释清楚|讲透|教学)/, text: '用户偏好详细的解释' },
    { pattern: /(不要解释|只要结果|直接给答案)/, text: '用户只要结果，不要过程解释' },
    { pattern: /(中文|用中文)/, text: '用户偏好中文回复' },
    { pattern: /(英文|用英语)/, text: '用户偏好英文回复' },
  ]
  for (const rule of preferenceRules) {
    if (rule.pattern.test(text)) signals.push({ kind: 'preference', text: rule.text, evidence: source })
  }

  const constraintRules: readonly { readonly pattern: RegExp; readonly text: string }[] = [
    { pattern: /(不要|别|禁止)(删|改|动)\s*([^\s，。]+)/, text: '用户禁止擅自删除或修改指定内容' },
    { pattern: /(只读|不要写|不许写)/, text: '用户要求只读，不要写入' },
    { pattern: /(权限|越界|工作目录)/, text: '用户关注操作范围限制' },
  ]
  for (const rule of constraintRules) {
    if (rule.pattern.test(text)) signals.push({ kind: 'constraint', text: rule.text, evidence: source })
  }

  // 主题：任务里出现的具体对象（文件路径是最常见的一类）
  const paths = task.match(/[\w./\\-]+\.(ts|js|json|md|py|txt)\b/g)
  if (paths !== null) {
    const unique = [...new Set(paths)].slice(0, 3)
    for (const path of unique) {
      signals.push({ kind: 'topic', text: `任务经常涉及文件 ${path}`, evidence: source })
    }
  }

  return signals
}

/** 用户模型：把信号累积成结论。 */
export class UserModel {
  readonly #conclusions: UserConclusion[] = []
  #nextId = 1

  /** 全部结论。 */
  list(): readonly UserConclusion[] {
    return [...this.#conclusions]
  }

  /** 按类别过滤。 */
  byKind(kind: ConclusionKind): readonly UserConclusion[] {
    return this.#conclusions.filter((item) => item.kind === kind)
  }

  /**
   * 观察一条信号。
   *
   * 同一个说法（确切匹配）会**累加证据**而不是新增一条结论 ——
   * 这正是"重复出现才算偏好"的实现。
   * @param signal 信号
   * @returns 更新后的结论
   */
  observe(signal: UserSignal): UserConclusion {
    const existing = this.#conclusions.find(
      (item) => item.kind === signal.kind && item.text === signal.text,
    )

    if (existing === undefined) {
      const created: UserConclusion = {
        id: `user-${this.#nextId}`,
        kind: signal.kind,
        text: signal.text,
        evidence: [signal.evidence],
        observations: 1,
        confidence: confidenceOf(1),
      }
      this.#nextId += 1
      this.#conclusions.push(created)
      return created
    }

    const observations = existing.observations + 1
    const updated: UserConclusion = {
      ...existing,
      evidence: [...existing.evidence, signal.evidence],
      observations,
      confidence: confidenceOf(observations),
    }
    const index = this.#conclusions.indexOf(existing)
    this.#conclusions[index] = updated
    return updated
  }

  /**
   * 从一条任务里观察（提取 + 累积）。
   * @param task 任务文本
   * @param source 出处
   * @returns 这次的结论（含新建与更新）
   */
  observeTask(task: string, source: MemorySource): readonly UserConclusion[] {
    return extractSignals(task, source).map((signal) => this.observe(signal))
  }

  /**
   * 给模型看的一小段摘要。
   *
   * 只保留置信度 ≥ 阈值的结论，按置信度排序 ——
   * 因为"一次性的说法"不该被当成事实推广。
   * @param minConfidence 最低置信度
   * @param maxLines 最多几行
   * @returns 摘要文本（可能为空串）
   */
  brief(minConfidence = 0.6, maxLines = 5): string {
    const lines = this.#conclusions
      .filter((item) => item.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxLines)
      .map((item) => `- (${item.kind}，置信 ${item.confidence.toFixed(2)}，见 ${item.observations} 次) ${item.text}`)
    return lines.join('\n')
  }

  /** 删掉一条（用户否定了它）。 */
  remove(id: string): boolean {
    const index = this.#conclusions.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.#conclusions.splice(index, 1)
    return true
  }
}
