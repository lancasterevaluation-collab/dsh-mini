/**
 * 第 15 步 ｜ 诊断：把"这次失败了"归因到**某个组件**
 *
 * 一个只报"任务失败"的 harness 是没法维护的。真实值班时的第一句话是：
 *
 *     "这次的 47 次失败，有多少是模型的、多少是工具的、多少是守卫干的？"
 *
 * 没有这个分解，你只能一个个看日志；有了它，你能直接看出
 * "工具失败从昨天开始涨了 3 倍"这种**趋势**。
 *
 * ── 为什么归因必须"可被评分"？────────────────────────────────────────
 *
 * 因为"我猜是工具的问题"没有任何约束力。所以这里做两件事：
 *
 *   1. 归因是**规则**（不是模型瞎猜），因此可以逐条解释
 *   2. 规则可以被**评分**：拿一批人工标注，算 Macro-F1 与 Cohen's κ
 *
 * 为什么要 κ 而不只是准确率？因为类别极不平衡 —— 如果 90% 的失败都是
 * "工具报错"，那么一个"永远猜工具"的傻分类器也有 90% 准确率。
 * κ 扣掉了"随机也能蒙对"的那部分，所以它才是"到底有没有学到东西"的指标。
 * （κ 的判读惯例：<0 比随机还差，0–0.2 几乎没有，0.2–0.4 一般，
 *   0.4–0.6 中等，0.6–0.8 显著，>0.8 几乎完全一致。）
 *
 * ── 为什么置信区间要用 bootstrap？────────────────────────────────────
 *
 * 60 条标注里算出来的 κ=0.62，到底是"真的 0.62"还是"这一批恰好如此"？
 * 没有区间就无法回答。bootstrap 的做法是从样本里有放回地重采样 B 次，
 * 得到 κ 的分布，再取 2.5% / 97.5% 分位。
 * ★ 随机数用**固定种子**：诊断报告必须可复现，否则没法写进论文或事故报告。
 *
 * ── 与"Feedback Friction"的关系 ──────────────────────────────────────
 *
 * `feedback-quality` 这一类直接来自《Feedback Friction》（NeurIPS 2025）的
 * 错误分类：他们的表 1 把持续错误分成 反馈抗拒 / 反馈质量 / 其他。
 * 本模块的 `feedbackResistance` 字段让这套分类可以在自己的日志上复算 ——
 * 也就是"读完论文后，能在自己的 harness 上验证它"。
 */

import type { Session, SessionStats, TurnStatus } from '../kernel/session.ts'

/** 失败可归因到的组件。 */
export type FailureComponent =
  /** 模型层：鉴权、参数、内容过滤等**不该重试**的错误。 */
  | 'llm'
  /** 重试层：可重试的错误重试到耗尽。 */
  | 'retry'
  /** 工具层：工具执行报错（参数、路径、IO）。 */
  | 'tools'
  /** 守卫层：被规则拦下、或审批未通过。 */
  | 'guard'
  /** 循环层：步数用尽（任务没做完，但不是"错"）。 */
  | 'agent-loop'
  /** 反馈质量：反馈本身是错的（来自 Feedback Friction 的分类）。 */
  | 'feedback-quality'
  /** 模型不采纳反馈（反馈抗拒）。 */
  | 'feedback-resistance'
  /** 归不了。 */
  | 'unknown'

/** 全部组件（评分时要保证两边的标签都在这个集合里）。 */
export const FAILURE_COMPONENTS: readonly FailureComponent[] = [
  'llm',
  'retry',
  'tools',
  'guard',
  'agent-loop',
  'feedback-quality',
  'feedback-resistance',
  'unknown',
]

/** 归因用的特征 —— **全部来自日志**，没有"模型的自我报告"。 */
export interface FailureFeatures {
  readonly status: TurnStatus
  readonly steps: number
  readonly maxSteps: number
  readonly attempts: number
  readonly toolErrors: number
  readonly failedTools: readonly string[]
  readonly guardDenials: number
  readonly guardAsks: number
  readonly errorCodes: readonly string[]
  /** 由人工或 LLM 判定注入："这一次的反馈本身是错的"。 */
  readonly feedbackIsWrong: boolean
  /** 由人工或 LLM 判定注入："这次是模型没采纳正确反馈"。 */
  readonly feedbackIgnored: boolean
}

/** 一次归因的结论。 */
export interface Diagnosis {
  readonly component: FailureComponent
  readonly reason: string
  /** 规则命中的强度 0–1（不是概率，是"证据有多确定"）。 */
  readonly confidence: number
  /** 支撑该结论的具体观察。 */
  readonly evidence: readonly string[]
}

/** 不可重试的错误码前缀（与第 9 步的策略一致）。 */
const NON_RETRYABLE = ['AUTH', 'INVALID', 'CONTENT', 'CANCELLED']

/**
 * 从会话日志提取归因特征。
 * @param session 会话
 * @param maxSteps 步数上限
 * @param injections 外部注入的两个判定（默认都为 false）
 * @returns 特征
 */
export function featuresOf(
  session: Session,
  maxSteps: number,
  injections: { readonly feedbackIsWrong?: boolean; readonly feedbackIgnored?: boolean } = {},
): FailureFeatures {
  const stats: SessionStats = session.stats()
  const failedTools: string[] = []
  const errorCodes: string[] = []

  for (const event of session.events) {
    const data = event.data as Record<string, unknown>
    if (event.type === 'tool/result' && data.isError === true) failedTools.push(String(data.name))
    if (event.type === 'assistant/attempt') errorCodes.push(String(data.code))
  }

  const lastTurnEnd = [...session.events].reverse().find((event) => event.type === 'turn/end')
  const status = ((lastTurnEnd?.data as { reason?: TurnStatus } | undefined)?.reason ?? 'error') as TurnStatus

  return {
    status,
    steps: stats.steps,
    maxSteps,
    attempts: stats.attempts,
    toolErrors: stats.toolErrors,
    failedTools,
    guardDenials: stats.guardDenials,
    guardAsks: stats.guardAsks,
    errorCodes,
    feedbackIsWrong: injections.feedbackIsWrong ?? false,
    feedbackIgnored: injections.feedbackIgnored ?? false,
  }
}

/**
 * 规则归因。
 *
 * 顺序是刻意的：**先归因"最早发生的那一层"**。
 * 因为一次失败往往是链式的（模型失败 → 重试 → 超步数），
 * 而根因是最早那一环；把链尾当作根因会让所有故障都归到"步数用尽"。
 * @param features 特征
 * @returns 归因结论
 */
export function classifyFailure(features: FailureFeatures): Diagnosis {
  const evidence: string[] = []

  // ① 守卫拒绝是最早的干预点：它拦下的调用根本没执行
  // ★ 必须同时算 ask：`irreversibleGuard` 这类规则给的是"转人工"，
  //   而审批未通过时统计落在 guardAsks 而不是 guardDenials。
  //   只看 deny 会让"不可逆操作被拒绝"这一类整个漏掉（写集成演示时踩到的）。
  const guardInterventions = features.guardDenials + features.guardAsks
  if (guardInterventions > 0 && features.toolErrors >= guardInterventions) {
    evidence.push(`守卫干预 ${guardInterventions} 次（deny ${features.guardDenials} / ask ${features.guardAsks}），工具失败 ${features.toolErrors} 次`)
    return {
      component: 'guard',
      reason: '操作被守卫规则拒绝或审批未通过，模型没有拿到工具结果',
      confidence: 0.8,
      evidence,
    }
  }

  // ② 模型层的**不可重试**错误：重试层在这里什么都做不了
  const fatal = features.errorCodes.filter((code) => NON_RETRYABLE.some((prefix) => code.startsWith(prefix)))
  if (fatal.length > 0) {
    evidence.push(`不可重试的错误码：${[...new Set(fatal)].join(', ')}`)
    return {
      component: 'llm',
      reason: '模型请求以不可重试的错误结束（鉴权 / 参数 / 内容），与重试策略无关',
      confidence: 0.9,
      evidence,
    }
  }

  // ③ 可重试的错误**重试到耗尽** → 归到重试层（那是它负责的边界）
  if (features.attempts >= 2 && features.status === 'error' && features.errorCodes.length > 0) {
    evidence.push(`失败尝试 ${features.attempts} 次：${[...new Set(features.errorCodes)].join(', ')}`)
    return {
      component: 'retry',
      reason: '可重试错误在预算内没能恢复（重试耗尽或预算用尽）',
      confidence: 0.75,
      evidence,
    }
  }

  // ④ 工具报错（参数 / 路径 / IO）
  if (features.toolErrors > 0) {
    const kinds = [...new Set(features.failedTools)].slice(0, 3)
    evidence.push(`工具失败 ${features.toolErrors} 次：${kinds.join(', ')}`)
    return {
      component: 'tools',
      reason: '工具执行返回了错误结果（模型收到失败内容后仍未完成）',
      confidence: 0.7,
      evidence,
    }
  }

  // ⑤ 步数用尽：不是"错"，是"没做完"
  // ★ 两个条件都要认：正常的 max-steps 结局，以及"步数已经触顶"这个事实。
  //   只认前者会漏掉一类真实情况：turn 以 complete 结束，但它其实是用光了预算
  //   才勉强给出答案的（写 demo 时正是踩到这一条才补上）。
  if (features.status === 'max-steps' || features.steps >= features.maxSteps) {
    evidence.push(`步数 ${features.steps}/${features.maxSteps}（状态 ${features.status}）`)
    return {
      component: 'agent-loop',
      reason: '步数预算用尽 —— 属于预算问题，通常意味着任务该被拆小',
      confidence: 0.85,
      evidence,
    }
  }

  // ⑥ 反馈类（来自 Feedback Friction 的两类）
  if (features.feedbackIsWrong) {
    evidence.push('反馈本身被判定为错误')
    return {
      component: 'feedback-quality',
      reason: '纠正性反馈本身不正确，模型被引向了错误方向',
      confidence: 0.7,
      evidence,
    }
  }
  if (features.feedbackIgnored) {
    evidence.push('反馈正确但模型未采纳')
    return {
      component: 'feedback-resistance',
      reason: '反馈正确且清晰，模型仍未吸收（Feedback Friction）',
      confidence: 0.7,
      evidence,
    }
  }

  evidence.push(`状态 ${features.status}，步数 ${features.steps}/${features.maxSteps}`)
  return {
    component: 'unknown',
    reason: '现有规则无法归因 —— 这条应该被人工看一眼，然后补一条规则',
    confidence: 0.2,
    evidence,
  }
}

/** 评分结果。 */
export interface Metrics {
  /** 参与评分的样本数。 */
  readonly n: number
  /** 每个类别的精确率 / 召回率 / F1 / 支持数。 */
  readonly perClass: Record<string, { readonly precision: number; readonly recall: number; readonly f1: number; readonly support: number }>
  /** 各类 F1 的算术平均（**不考虑类占比**，正是不平衡时该看的指标）。 */
  readonly macroF1: number
  /** 准确率。 */
  readonly accuracy: number
  /** Cohen's κ：扣掉随机一致之后的同意度。 */
  readonly kappa: number
  /** Macro-F1 的 95% bootstrap 置信区间。 */
  readonly macroF1CI: readonly [number, number]
  /** κ 的 95% bootstrap 置信区间。 */
  readonly kappaCI: readonly [number, number]
}

/** 固定种子的线性同余随机数 —— 诊断报告必须可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    // Numerical Recipes 的常数；只要可复现就行，不需要密码学强度
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** 算一批预测的 per-class 指标 + Macro-F1。 */
function macroF1Of(gold: readonly string[], predicted: readonly string[]): { macro: number; perClass: Metrics['perClass'] } {
  const labels = [...new Set([...gold, ...predicted])]
  const perClass: Metrics['perClass'] = {}
  let sum = 0

  for (const label of labels) {
    let tp = 0
    let fp = 0
    let fn = 0
    let support = 0
    for (let index = 0; index < gold.length; index += 1) {
      const isGold = gold[index] === label
      const isPred = predicted[index] === label
      if (isGold) support += 1
      if (isGold && isPred) tp += 1
      else if (!isGold && isPred) fp += 1
      else if (isGold && !isPred) fn += 1
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    perClass[label] = { precision, recall, f1, support }
    sum += f1
  }

  return { macro: labels.length === 0 ? 0 : sum / labels.length, perClass }
}

/** 算 Cohen's κ。 */
function kappaOf(gold: readonly string[], predicted: readonly string[]): number {
  const n = gold.length
  if (n === 0) return 0

  const labels = [...new Set([...gold, ...predicted])]
  let observed = 0
  for (let index = 0; index < n; index += 1) if (gold[index] === predicted[index]) observed += 1
  const pObserved = observed / n

  let pExpected = 0
  for (const label of labels) {
    const goldCount = gold.filter((item) => item === label).length
    const predCount = predicted.filter((item) => item === label).length
    pExpected += (goldCount / n) * (predCount / n)
  }

  if (pExpected >= 1) return 1
  return (pObserved - pExpected) / (1 - pExpected)
}

/**
 * 给一份标注算全套指标（含 95% bootstrap 置信区间）。
 * @param gold 人工标注的组件
 * @param predicted 规则给出的组件（顺序必须与 gold 一致）
 * @param options 重采样次数与种子
 * @returns 指标
 * @throws 两边长度不一致时（静默对齐会得出虚假的高分）
 */
export function evaluate(
  gold: readonly string[],
  predicted: readonly string[],
  options: { readonly bootstrap?: number; readonly seed?: number } = {},
): Metrics {
  if (gold.length !== predicted.length) {
    throw new Error(`标注与预测长度不一致：${gold.length} vs ${predicted.length}`)
  }

  const n = gold.length
  const { macro: macroF1, perClass } = macroF1Of(gold, predicted)
  const accuracy = n === 0 ? 0 : gold.filter((item, index) => item === predicted[index]).length / n
  const kappa = kappaOf(gold, predicted)

  const rounds = options.bootstrap ?? 1000
  const random = makeRandom(options.seed ?? 20250921)
  const macroSamples: number[] = []
  const kappaSamples: number[] = []

  for (let round = 0; round < rounds && n > 0; round += 1) {
    const goldSample: string[] = []
    const predSample: string[] = []
    for (let index = 0; index < n; index += 1) {
      const pick = Math.floor(random() * n)
      goldSample.push(gold[pick] as string)
      predSample.push(predicted[pick] as string)
    }
    macroSamples.push(macroF1Of(goldSample, predSample).macro)
    kappaSamples.push(kappaOf(goldSample, predSample))
  }

  const quantile = (values: readonly number[], q: number): number => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const position = (sorted.length - 1) * q
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    if (lower === upper) return sorted[lower] as number
    const weight = position - lower
    return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight
  }

  return {
    n,
    perClass,
    macroF1,
    accuracy,
    kappa,
    macroF1CI: [quantile(macroSamples, 0.025), quantile(macroSamples, 0.975)],
    kappaCI: [quantile(kappaSamples, 0.025), quantile(kappaSamples, 0.975)],
  }
}

/**
 * 按 κ 的惯例给一个可读判读。
 * @param kappa κ 值
 * @returns 判读文本
 */
export function interpretKappa(kappa: number): string {
  if (kappa < 0) return '比随机还差 —— 规则方向错了'
  if (kappa < 0.2) return '几乎没有一致（slight）'
  if (kappa < 0.4) return '一般（fair）—— 可以先用，但要继续补规则'
  if (kappa < 0.6) return '中等（moderate）—— 可用于趋势监控'
  if (kappa < 0.8) return '显著（substantial）—— 可用于自动归因'
  return '几乎完全一致（almost perfect）'
}
