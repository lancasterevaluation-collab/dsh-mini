/**
 * 第 12 步 ｜ nudge：把"观察到的问题"变成"下一次会读到的一句话"
 *
 * 记忆解决的是"记住用户教过的东西"，nudge 解决的是另一类问题：
 * **这一次跑得很糟，而模型自己看不出来**。
 *
 * 三个真实场景：
 *
 *   1. 同一份请求重试了 4 次才成功 → 下次该让它先检查参数，而不是硬试
 *   2. 同一个工具连续失败 3 次 → 它在瞎撞，该提醒它换方法
 *   3. 步数用掉 7/8 还没收工 → 下一次该早点给结论，而不是把预算烧完
 *
 * 这些信息全都在日志里，**但模型看不到** —— 日志里没有"你已经重试 4 次了"
 * 这句话。所以需要在 turn 之间插一句。
 *
 * ── 为什么不直接把它 append 进会话？────────────────────────────────────
 *
 * 因为会话是 **append-only 的事实记录**。往里塞一句"系统觉得你该少试几次"，
 * 会让"模型看到的历史"里混进**不是模型产生、也不是用户说的**内容，
 * 而第 7 步的核心不变量是"模型看到的都能从日志重建" —— 一旦允许注入，
 * 日志就不再是完整原因，只是部分原因。
 *
 * 所以我们的做法是：**提醒在下一次任务开始之前，作为任务文本的一部分进入**。
 * 它因此留下了两条可查的证据：`agent/task-ready` 事件的改写、以及日志里
 * 那条真实的 `user/message`。谁在什么时候被提醒了什么，全都查得到。
 *
 * ── 规则为什么是可插拔的？──────────────────────────────────────────────
 *
 * 因为"什么算跑得糟"是**部署决定**：教学场景关心"重试次数"，
 * 生产场景可能关心"token 花了多少"。把规则做成对象，就能按 profile 换，
 * 而不需要改这个文件的 `if`。
 */

import type { SessionStats, TurnStatus } from '../kernel/session.ts'

/** 一次 turn 结束后，nudge 规则能看到的东西。 */
export interface TurnView {
  /** 这次的任务描述。 */
  readonly task: string
  /** 结局。 */
  readonly status: TurnStatus
  /** 走了几步。 */
  readonly steps: number
  /** 步数上限（用于"快用完了"这类规则）。 */
  readonly maxSteps: number
  /** 会话统计（含 attempts / guardDenials 等第 9、10 步的字段）。 */
  readonly stats: SessionStats
  /** 这次失败过的工具名（按出现顺序，可重复）。 */
  readonly failedTools: readonly string[]
  /** 这次调用过的工具名（去重）。 */
  readonly usedTools: readonly string[]
  /** 外部注入的额外事实（比如"记忆库满了"）。 */
  readonly facts: Readonly<Record<string, number | string | boolean>>
}

/** 一条 nudge 规则。 */
export interface NudgeRule {
  /** 规则名，会出现在提醒文本里，便于追溯是谁提的。 */
  readonly name: string
  /**
   * 观察一次 turn。返回提醒文本 = 要提醒；返回 `undefined` = 不提醒。
   * @param view 这次 turn 的视图
   * @returns 提醒文本或不提醒
   */
  readonly inspect: (view: TurnView) => string | undefined
}

/** 重试过多的规则。 */
export function repeatedAttemptRule(threshold = 2): NudgeRule {
  return {
    name: 'repeated-attempts',
    inspect: (view) =>
      view.stats.attempts >= threshold
        ? `上一次任务里模型请求失败了 ${view.stats.attempts} 次才成功。` +
          '这次请先核对参数与环境，不要用同样的方式反复重试。'
        : undefined,
  }
}

/** 同一个工具反复失败的规则。 */
export function stuckToolRule(threshold = 2): NudgeRule {
  return {
    name: 'stuck-tool',
    inspect: (view) => {
      const counts = new Map<string, number>()
      for (const name of view.failedTools) counts.set(name, (counts.get(name) ?? 0) + 1)
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      if (worst === undefined || worst[1] < threshold) return undefined
      return `上一次任务里 ${worst[0]} 连续失败 ${worst[1]} 次，说明方法不对而不是运气不好。` +
        '这次先读清楚再调用，一次做对。'
    },
  }
}

/** 步数快用尽的规则。 */
export function nearStepLimitRule(ratio = 0.8): NudgeRule {
  return {
    name: 'near-step-limit',
    inspect: (view) => {
      if (view.maxSteps <= 0) return undefined
      const used = view.steps / view.maxSteps
      // 只在"没做完"的时候提醒：正常收工的 turn 不需要被念
      if (view.status !== 'max-steps' && used < ratio) return undefined
      return `上一次任务用掉了 ${view.steps}/${view.maxSteps} 步` +
        `${view.status === 'max-steps' ? '并且没能在预算内收工' : ''}。` +
        '这次请优先做最关键的几步，尽早给出结论。'
    },
  }
}

/** 守卫反复干预的规则（拒绝与转人工都算 —— 见 diagnose.ts 里同一条修正）。 */
export function guardRejectionRule(threshold = 2): NudgeRule {
  return {
    name: 'guard-rejections',
    inspect: (view) => {
      const interventions = view.stats.guardDenials + view.stats.guardAsks
      if (interventions < threshold) return undefined
      return `上一次任务里有 ${interventions} 次操作被守卫拦下` +
        `（拒绝 ${view.stats.guardDenials} / 问人 ${view.stats.guardAsks}）。` +
        '这次请先确认你打算做的事在工作目录内、且没有重复调用。'
    },
  }
}

/** nudge 引擎。 */
export class NudgeEngine {
  readonly #rules: NudgeRule[] = []
  #pending: string[] = []

  /** 挂一条规则。 */
  add(rule: NudgeRule): void {
    this.#rules.push(rule)
  }

  /** 当前规则名。 */
  ruleNames(): string[] {
    return this.#rules.map((rule) => rule.name)
  }

  /** 待注入的提醒（只读）。 */
  get pending(): readonly string[] {
    return [...this.#pending]
  }

  /**
   * 观察一次 turn，把命中的规则转成待注入的提醒。
   * @param view turn 视图
   * @returns 这次新增的提醒（没命中就是空数组）
   */
  observe(view: TurnView): readonly string[] {
    const fresh: string[] = []
    for (const rule of this.#rules) {
      const message = rule.inspect(view)
      if (message === undefined) continue
      // 同一条提醒不重复堆积 —— 否则第二次跑会带着四句一样的话
      if (this.#pending.some((existing) => existing.startsWith(`[${rule.name}]`))) continue
      const line = `[${rule.name}] ${message}`
      this.#pending.push(line)
      fresh.push(line)
    }
    return fresh
  }

  /**
   * 取走全部待注入提醒（取走即清空）。
   * @returns 提醒文本
   */
  take(): readonly string[] {
    const taken = this.#pending
    this.#pending = []
    return taken
  }

  /** 清空（不返回）。 */
  clear(): void {
    this.#pending = []
  }

  /**
   * 把提醒拼进任务文本。
   *
   * 放在**前面**是刻意的：模型对开头的约束最敏感，而 nudge 的价值
   * 恰恰是"改变它这一轮的做法"，把它塞在长任务描述后面等于没说。
   * @param task 原始任务
   * @param nudges 提醒
   * @returns 拼好的任务文本
   */
  static compose(task: string, nudges: readonly string[]): string {
    if (nudges.length === 0) return task
    return ['【系统提醒】', ...nudges.map((line) => `- ${line}`), '', '【任务】', task].join('\n')
  }
}
