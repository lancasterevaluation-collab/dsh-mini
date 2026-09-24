/**
 * 第 10 步 ｜ 守卫：在工具**真正执行之前**把它拦下来
 *
 * 第 2 步的工具注册表只会做一件事：**执行**。它已经会校验参数、会把失败转成结果，
 * 但它**从不拒绝**——模型说调什么就调什么。
 *
 * 为什么这不够？回到 A/B/C 的三分法（见 docs/research/error-taxonomy.md）：
 *
 *     A 类 · 可重规划纠正  —— 状态没被改变，换个方法继续即可
 *     B 类 · 需回滚纠正    —— 状态被改了，但能撤销
 *     C 类 · 不可纠正      —— 影响不可收回
 *
 * 对 A 类，"事后把错误说清楚"就够了（第 1、2 步已经做了）。
 * 对 B 类，需要**检查点 + 回滚**（checkpoint.ts）。
 * 对 C 类，★ 事后再怎么纠正都来不及 —— 唯一的机会是**执行之前** ★。
 *
 * 这个文件就是"执行之前"那一层。
 *
 * ── 三个设计要点 ──────────────────────────────────────────────────────
 *
 * ① **守卫是纯函数。** `inspect(request, history)` —— 只看入参和调用历史，
 *    不碰 IO、不改状态。于是守卫本身**可测试、可组合、可推理**。
 *    真正有副作用的是"裁决之后怎么办"（放行 / 拒绝 / 问人）。
 *
 * ② **★ 单调性：拒绝不可被翻案 ★**。
 *    守卫链一旦给出 deny，**后面的规则再怎么 allow 都不能推翻它**。
 *    为什么必须这样？因为守卫常常由**插件**注册 —— 安全策略插件先注册，
 *    业务插件后注册；如果后者能翻案，前者就形同虚设。
 *    「只能越管越严」是这条链唯一的秩序。
 *
 * ③ **裁决是三分而不是二分。** allow / deny / ask。
 *    没有 ask 的话，"不确定要不要拦"就只能二选一：要么全放（危险），要么全拦（不可用）。
 *    ★ ask 的存在，是因为真实世界里大量动作属于"规则说不清，得人看一眼" ★。
 */

// ============================================================
// 一、副作用等级：给每个工具贴一个标签
// ============================================================

/**
 * 一次工具调用的副作用等级。
 *
 * 这个字段原本该在第 2 步就留出来 —— 我们当时漏了，
 * 结果发现"事前拦截"根本无从下手：不知道哪个工具危险，怎么拦？
 * ★ 这是"后面某一步暴露出前面接口缺口"的典型例子 ★。
 *
 * 三个取值对应 A/B/C 的**执行侧**：
 *   - `none`         → A 类的前置条件：什么都没改，随便重试
 *   - `reversible`   → B 类的判据：改了，但落在能回滚的载体上
 *   - `irreversible` → C 类的标志：改了且收不回
 */
export type SideEffect = 'none' | 'reversible' | 'irreversible'

/** 人类可读的等级名，用于日志和错误消息。 */
export function describeSideEffect(effect: SideEffect): string {
  switch (effect) {
    case 'none':
      return '无副作用（只读）'
    case 'reversible':
      return '可逆（可回滚）'
    case 'irreversible':
      return '不可逆（无法收回）'
  }
}

// ============================================================
// 二、守卫看到的"请求"与"历史"
// ============================================================

/** 一次待执行的工具调用 —— 守卫看到的就是这些。 */
export interface ToolCallRequest {
  /** 工具名。 */
  readonly name: string
  /** 模型给出的参数。**尚未执行**，所以它还是不可信的数据。 */
  readonly args: Readonly<Record<string, unknown>>
  /** 这个工具的副作用等级。 */
  readonly sideEffect: SideEffect
  /** 工作目录。 */
  readonly workspace: string
  /** 这是第几步（从 1 开始）。步数守卫要用。 */
  readonly step: number
}

/** 已经执行过的一次调用 —— 守卫用来判断"是不是在重复上一次"。 */
export interface ToolCallRecord {
  /** 工具名。 */
  readonly name: string
  /** 原始参数。 */
  readonly args: Readonly<Record<string, unknown>>
  /** 这次调用**是否失败**。 */
  readonly isError: boolean
  /** 结果文本的摘要（守卫不该看全文，避免浪费内存）。 */
  readonly summary: string
}

// ============================================================
// 三、裁决：三分而不是二分
// ============================================================

/**
 * 一次守卫裁决。
 *
 * `allow` 是**默认值**而不是"某条规则的结论" —— 没有规则反对才叫允许。
 * 这个方向很重要：新增规则只会让系统**更严**，不会让系统**更松**。
 */
export type GuardVerdict =
  /** 放行，继续执行。 */
  | { readonly kind: 'allow' }
  /** 拒绝。**理由会回灌给模型**，让它知道该换个做法。 */
  | { readonly kind: 'deny'; readonly reason: string }
  /** 拿不准，需要人看一眼。 `question` 是给人看的问题。 */
  | { readonly kind: 'ask'; readonly question: string }

/** 造一个放行裁决。 */
export function allow(): GuardVerdict {
  return { kind: 'allow' }
}

/** 造一个拒绝裁决。 */
export function deny(reason: string): GuardVerdict {
  return { kind: 'deny', reason }
}

/** 造一个"要问人"的裁决。 */
export function ask(question: string): GuardVerdict {
  return { kind: 'ask', question }
}

// ============================================================
// 四、规则与守卫链
// ============================================================

/**
 * 一条守卫规则。
 *
 * `inspect` 必须是**纯函数**：同样的请求 + 同样的历史 → 同样的裁决。
 * 这条约束让守卫可以被单测，也让"为什么这次被拦了"能被复现 ——
 * 而安全相关的决定**必须可复现**。
 */
export interface GuardRule {
  /** 规则名。拒绝时会写进日志，出问题时要能定位到规则。 */
  readonly name: string
  /**
   * 检查一次调用。
   * @param request 待执行的调用
   * @param history 本次 turn 里已经执行过的调用（按时间顺序）
   * @returns 裁决
   */
  readonly inspect: (request: ToolCallRequest, history: readonly ToolCallRecord[]) => GuardVerdict
}

/** 守卫链的最终结果：裁决 + 是哪条规则给出的。 */
export interface GuardOutcome {
  readonly verdict: GuardVerdict
  /** 做出该裁决的规则名；没有任何规则表态时是 `'(默认)'`。 */
  readonly byRule: string
}

/**
 * 守卫链：按注册顺序跑规则，**裁决只能越跑越严**。
 *
 * 严重度排序：`deny` > `ask` > `allow`。
 *
 * 实现方式很直白 —— 记住"目前为止最严的裁决"，遇到更严的就替换。
 * 关键在于**后面遇到更松的不会替换回去**，这就是单调性。
 */
export class GuardChain {
  readonly #rules: GuardRule[] = []
  #sealed = false

  /** 目前注册了几条规则。 */
  get size(): number {
    return this.#rules.length
  }

  /** 规则名，按注册顺序。 */
  names(): string[] {
    return this.#rules.map((rule) => rule.name)
  }

  /**
   * 追加一条规则。
   * @param rule 要追加的规则
   * @throws 链已被 {@link seal} 封存时
   * @throws 规则重名时 —— 重名会让"哪条规则拦的"变得无法回答
   */
  add(rule: GuardRule): void {
    if (this.#sealed) {
      throw new Error(`守卫链已封存，不能再添加规则 "${rule.name}"`)
    }
    if (this.#rules.some((existing) => existing.name === rule.name)) {
      throw new Error(`守卫规则名重复："${rule.name}"`)
    }
    this.#rules.push(rule)
  }

  /**
   * 封存：从此不能再加规则。
   *
   * 为什么需要？因为"守卫可以在任意时刻被追加"意味着
   * **一个晚注册的插件可以改变早先已承诺的策略**。
   * 在把守卫链交给不受信任的代码之前先封存，是表达
   * "策略已经定稿"的唯一方式。
   */
  seal(): void {
    this.#sealed = true
  }

  /** 链是否已封存。 */
  get sealed(): boolean {
    return this.#sealed
  }

  /**
   * 跑一遍所有规则，返回**最严**的那个裁决。
   *
   * ★ 注意：不提前返回。★ 即使第一条规则已经 deny，也要跑完剩下的 ——
   * 原因是所有规则的裁决都会进入调用轨迹，事后复盘时
   * "还有哪些规则也认为该拦"是有用信息。规则是纯函数，跑完不额外花什么代价。
   * @param request 待执行的调用
   * @param history 已经执行过的调用
   * @returns 最严的裁决，以及给出它的规则名
   */
  check(request: ToolCallRequest, history: readonly ToolCallRecord[]): GuardOutcome {
    let best: GuardOutcome = { verdict: allow(), byRule: '(默认)' }

    for (const rule of this.#rules) {
      const verdict = rule.inspect(request, history)
      if (severityOf(verdict) > severityOf(best.verdict)) {
        best = { verdict, byRule: rule.name }
      }
    }

    return best
  }
}

/** 裁决的严重度。数字越大越严 —— 比较它就能实现"只能收紧"。 */
export function severityOf(verdict: GuardVerdict): number {
  switch (verdict.kind) {
    case 'allow':
      return 0
    case 'ask':
      return 1
    case 'deny':
      return 2
  }
}

// ============================================================
// 五、内置守卫
// ============================================================

/** 循环守卫的默认阈值：同名同参连续出现几次就算"卡住了"。 */
export const DEFAULT_LOOP_THRESHOLD = 3

/** 稳定地把参数序列化 —— 键顺序不同不该被当成不同调用。 */
function canonicalArgs(args: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(args).sort()
  return JSON.stringify(keys.map((key) => [key, args[key]]))
}

/**
 * 循环守卫：连续用**完全相同的参数**调同一个工具，就拦下来。
 *
 * 为什么这是一个真实问题？因为没有它，模型陷入死循环时
 * 唯一的出路是"步数上限" —— 而那时已经烧掉了 N 步。
 * 循环检测能把这个代价从 N 步降到 3 步。
 *
 * ★ 注意"连续"这个词 ★：它只看**最近**的调用是不是都一样。
 * 如果中间插了别的调用，计数器就归零 ——
 * 因为"试了 A，失败，试了 B，再回来试 A"是正常策略，不该被拦。
 * @param threshold 连续重复几次触发；默认 {@link DEFAULT_LOOP_THRESHOLD}
 * @returns 一条守卫规则
 */
export function loopGuard(threshold: number = DEFAULT_LOOP_THRESHOLD): GuardRule {
  return {
    name: 'loop',
    inspect(request, history) {
      const signature = `${request.name} ${canonicalArgs(request.args)}`
      let repeats = 0
      // 从最近一次往回数，遇到不同签名就停
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const record = history[index]
        if (record === undefined) break
        const recordSignature = `${record.name} ${canonicalArgs(record.args)}`
        if (recordSignature !== signature) break
        repeats += 1
      }

      if (repeats + 1 >= threshold) {
        return deny(
          `检测到循环：${request.name} 已用完全相同的参数连续调用 ${repeats + 1} 次。` +
            `\n请不要再重复这次调用 —— 换成不同的做法，例如换一个工具、改参数，` +
            `或者直接说明你无法完成任务。`,
        )
      }
      return allow()
    },
  }
}

/**
 * 不可逆守卫：遇到声明为 `irreversible` 的工具就要求人工确认。
 *
 * 这是 C 类的**唯一机会** —— 一旦执行，任何事后的纠正都只是补救。
 *
 * 我们让它 `ask` 而不是直接 `deny`，因为"不可逆"不等于"不该做" ——
 * 提交代码、发消息、清理文件都是正常业务动作。
 * 真正缺的不是禁止，而是**确认**。
 * @returns 一条守卫规则
 */
export function irreversibleGuard(): GuardRule {
  return {
    name: 'irreversible',
    inspect(request) {
      if (request.sideEffect !== 'irreversible') return allow()
      return ask(
        `即将执行不可逆操作：${request.name}(${canonicalArgs(request.args)})。` +
          `\n这个动作产生的影响无法收回，执行前需要确认。`,
      )
    },
  }
}

/**
 * 配额守卫：限制这个 turn 里的工具调用总数。
 *
 * 和"步数上限"（第 8 步）的区别：一步可以调多个工具，
 * 所以"20 步"可能意味着"60 次调用"。**限制调用数才管得住成本。**
 * @param maxCalls 允许的最大调用次数
 * @returns 一条守卫规则
 */
export function quotaGuard(maxCalls: number): GuardRule {
  return {
    name: 'quota',
    inspect(_request, history) {
      if (history.length >= maxCalls) {
        return deny(
          `本次任务已执行 ${history.length} 次工具调用，达到上限 ${maxCalls}。` +
            `\n请基于已有信息给出答案，不要再调用工具。`,
        )
      }
      return allow()
    },
  }
}

/**
 * 路径守卫：拒绝写到工作目录之外。
 *
 * ★ 这一条是 `builtin-tools.ts` 里 `resolveInsideWorkspace` 的**补强**，
 * 而且它演示了防御的**分层原则** ★：
 *   - `resolveInsideWorkspace` 在 handler 里做真实路径解析（知道 symlink、`..`、盘符）
 *   - 这条守卫在**执行前**做一次粗筛（看参数里的字符串）
 *
 * 两者看起来重复，但职责不同：前者是正确性，后者是**在副作用发生前**就拒绝。
 * 安全机制的分层不是冗余 —— 每一层拦截的时机不同。
 * @param key 参数里表示路径的字段名
 * @returns 一条守卫规则
 */
export function pathGuard(key: string): GuardRule {
  return {
    name: 'path',
    inspect(request) {
      const raw = request.args[key]
      if (typeof raw !== 'string') return allow()

      const normalized = raw.replaceAll('\\', '/')
      const escapes =
        normalized.startsWith('/') ||
        /^[a-zA-Z]:\//.test(normalized) ||
        normalized.split('/').includes('..')

      if (escapes) {
        return deny(
          `参数 ${key} 指向工作目录之外："${raw}"。` +
            `\n只能使用工作目录内的相对路径，且不能包含 ".."。`,
        )
      }
      return allow()
    },
  }
}

// ============================================================
// 六、审批通道
// ============================================================

/** 审批的结果。 */
export interface ApprovalDecision {
  /** 是否批准。 */
  readonly approved: boolean
  /** 拒绝时给模型看的说明。 */
  readonly reason?: string
}

/**
 * 审批人：当守卫给出 `ask` 时，由它来拍板。
 *
 * 真实系统里这通常是一个异步的人类通道（可能超时、可能没人应答）。
 * 这里用接口把它抽象掉，是为了让"谁来批"成为**可替换的依赖**：
 * 测试里换成一个自动批准的函数，部署时换成终端交互。
 */
export interface Approver {
  /**
   * 请求批准。
   * @param request 待执行的调用
   * @param question 守卫提出的问题
   * @returns 批准与否
   */
  readonly request: (request: ToolCallRequest, question: string) => Promise<ApprovalDecision>
}

/** 一个永远拒绝的审批人 —— 用于"无人值守且不许做危险动作"的场景。 */
export const denyAllApprover: Approver = {
  request: async () => ({ approved: false, reason: '当前没有可用的审批通道，该操作被拒绝。' }),
}

/**
 * 一个按工具名白名单自动批准的审批人 —— 用于测试与自动化演示。
 * @param allowed 允许自动批准的工具名
 * @returns 一个审批人
 */
export function allowListApprover(allowed: readonly string[]): Approver {
  const set = new Set(allowed)
  return {
    request: async (request) =>
      set.has(request.name)
        ? { approved: true }
        : { approved: false, reason: `工具 ${request.name} 不在自动批准名单里。` },
  }
}
