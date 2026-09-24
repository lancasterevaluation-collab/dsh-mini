/**
 * 能力插件 ⑤ ｜ guard：把第 10 步的守卫链挂成服务，并让规则可被"贡献"
 *
 * 第 10 步留下的形状是一条**链**（`GuardChain`）：规则按注册顺序检查，
 * 任一规则拒绝即拒绝，且后注册的规则**翻不了案**（单调性）。
 *
 * 这个插件要做三件事，缺一件都不成：
 *
 *   1. **规则来自配置** —— 写 "loop"/"quota"/... 才装载，而不是代码里 `if`
 *   2. **规则可被贡献** —— 别的插件（比如第 15 步的诊断）能挂自己的规则，
 *      而不是只能改这个文件。所以注册动作走 `guard/rules` 服务
 *   3. **每个任务一条新链** —— 配额（`quotaGuard`）的计数是闭包状态，
 *      一条链活到底会让"第二个任务一开始就已经超额"
 *
 * ── 为什么 #3 不是可选优化？────────────────────────────────────────────
 *
 * 配额说的是"**这次任务**里最多调 2 次工具"。如果链是进程级的，
 * 第二个任务第一次调用就会被拒，而现象是"工具全都不工作了" ——
 * 排查时你会去看工具注册、看权限、看路径，最后才发现是计数没清。
 * 把链的生命周期绑在任务上，这类 bug 在结构上就不存在了。
 *
 * ── 审批人为什么也在这里？──────────────────────────────────────────────
 *
 * 因为守卫给 `ask` 之后必须有人回答，而"谁有资格批准"是部署决定的事
 * （交互式 CLI 会问人，CI 里只能白名单）。把它和规则放在同一个插件里，
 * 是为了让"这个环境下能自动批准什么"成为**一段可读的配置**。
 */

import {
  allowListApprover,
  denyAllApprover,
  GuardChain,
  irreversibleGuard,
  loopGuard,
  pathGuard,
  quotaGuard,
} from '../kernel/guard.ts'
import type { Approver, GuardRule } from '../kernel/guard.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 一条守卫规则被挂上链。 */
    'guard/rule-added': { name: string; by: string }
    /** 为一个任务造了一条新链。 */
    'guard/chain-created': { rules: readonly string[] }
  }
}

/** 内置规则的代号。 */
export type BuiltinRuleName = 'loop' | 'irreversible' | 'quota' | 'path'

/** 配置文件里这一段能写什么。 */
export interface GuardConfig {
  /** 要装载的内置规则。不给 = 全部装载（守卫默认开）。 */
  readonly rules?: readonly string[]
  /** `loop` 规则：连续多少次相同调用算循环。 */
  readonly loopThreshold?: number
  /** `quota` 规则：一次任务最多调用多少次工具。 */
  readonly maxCalls?: number
  /** `path` 规则：检查哪个参数是路径。 */
  readonly pathKey?: string
  /** 自动批准的名单；`"none"` 表示一律拒绝。不给 = 不自动批准任何东西。 */
  readonly approve?: readonly string[] | string
}

/** 解析后的守卫配置。 */
export interface GuardSpec {
  readonly rules: readonly BuiltinRuleName[]
  readonly loopThreshold: number
  readonly maxCalls: number
  readonly pathKey: string
  readonly approve: readonly string[]
}

const ALL_RULES: readonly BuiltinRuleName[] = ['loop', 'irreversible', 'quota', 'path']

/**
 * 解析守卫配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws 写了不存在的规则名 / 非法的数值时
 */
export function resolveGuardSpec(config: GuardConfig | undefined): GuardSpec {
  const raw = config ?? {}
  const rules = raw.rules ?? ALL_RULES

  const unknown = rules.filter((name) => !ALL_RULES.includes(name as BuiltinRuleName))
  if (unknown.length > 0) {
    throw new Error(`guard 插件：不认识的规则 ${unknown.join(', ')}；可选：${ALL_RULES.join(', ')}`)
  }

  const approve = raw.approve === undefined
    ? []
    : raw.approve === 'none'
      ? []
      : Array.isArray(raw.approve)
        ? raw.approve
        : (() => {
            throw new Error('guard 插件：config.approve 只能是数组或 "none"')
          })()

  return {
    rules: rules as readonly BuiltinRuleName[],
    loopThreshold: raw.loopThreshold ?? 3,
    maxCalls: raw.maxCalls ?? 8,
    pathKey: raw.pathKey ?? 'path',
    approve,
  }
}

/** 规则贡献点 —— 别的插件用它挂自己的规则。 */
export interface RuleRegistry {
  /**
   * 挂一条规则。
   * @param rule 规则实现
   */
  add(rule: GuardRule): void
  /** 当前规则名（按挂载顺序）。 */
  names(): string[]
}

/** 链工厂 —— agent 循环每个任务要一条新链。 */
export interface GuardFactory {
  /**
   * 造一条包含当前全部规则的新链。
   * @returns 新链
   */
  create(): GuardChain
}

/** 守卫插件的服务集合。 */
export interface GuardServices {
  readonly spec: GuardSpec
  readonly rules: RuleRegistry
  readonly factory: GuardFactory
  readonly approver: Approver
}

/** guard 插件。 */
export const guardPlugin: Plugin = {
  name: 'guard',
  apply(ctx, config) {
    const spec = resolveGuardSpec(config as GuardConfig | undefined)

    // 规则**不是一次性**的：插件可以随时贡献，新任务造的链会带上它们
    const contributed: GuardRule[] = []
    const builtinNames: string[] = []

    const rules: RuleRegistry = {
      add: (rule) => {
        contributed.push(rule)
        void ctx.emit('guard/rule-added', { name: rule.name, by: ctx.name })
      },
      names: () => [...builtinNames, ...contributed.map((rule) => rule.name)],
    }

    /** 按配置造内置规则。**每次造链都新建一份** —— 配额计数因此与任务同寿。 */
    const buildBuiltins = (): GuardRule[] => {
      const built: GuardRule[] = []
      for (const name of spec.rules) {
        if (name === 'loop') built.push(loopGuard(spec.loopThreshold))
        else if (name === 'irreversible') built.push(irreversibleGuard())
        else if (name === 'quota') built.push(quotaGuard(spec.maxCalls))
        else built.push(pathGuard(spec.pathKey))
      }
      return built
    }

    const factory: GuardFactory = {
      create: () => {
        const chain = new GuardChain()
        const names: string[] = []
        for (const rule of [...buildBuiltins(), ...contributed]) {
          chain.add(rule)
          names.push(rule.name)
        }
        builtinNames.length = 0
        builtinNames.push(...names)
        void ctx.emit('guard/chain-created', { rules: names })
        return chain
      },
    }

    // 审批人：白名单为空 = 一律拒绝（安全的默认值）
    const approver: Approver = spec.approve.length === 0
      ? denyAllApprover
      : allowListApprover(spec.approve)

    const services: GuardServices = { spec, rules, factory, approver }

    ctx.provide('guards', services)
    ctx.provide('guard/spec', spec)
    ctx.provide('approver', approver)

    console.log(
      `[guard] 已装载：规则=${spec.rules.join(', ')}；自动批准=${spec.approve.length === 0 ? '(无，一律问人)' : spec.approve.join(', ')}`,
    )
  },
}

export default guardPlugin
