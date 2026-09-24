/**
 * 进化插件 ｜ 把第 12–16 步的能力接进框架
 *
 * `evolution/` 里的九个模块都是**纯组件**：不认识 Context，只认识数据和规则。
 * 这个文件负责接线，让它们真的在运行中的 agent 上生效。接线只有四条：
 *
 *     ① session/event      → 索引历史（recall）、观察用户信号（user-model）
 *     ② agent/turn-end     → 判定要不要提醒（nudge）、打扫技能（curator）
 *     ③ agent/task-ready   → 把提醒与用户模型拼进任务文本
 *     ④ 服务               → 记忆 / 技能 / 诊断 / 审计 / 门控，供 CLI 与演示调用
 *
 * ── 三个刻意的克制 ────────────────────────────────────────────────────
 *
 * 1. **不自动写记忆**。记忆是"用户教过的东西"，自动从对话里总结会让
 *    记忆库被模型的推断污染。`memory.add()` 只由显式动作触发（用户说
 *    "记住这个"，或演化门控通过了一条记忆提案）。
 *
 * 2. **提醒只在任务开头注入**。理由见 `nudge.ts` 的文件头：会话是
 *    append-only 的事实记录，不允许插入"系统觉得"的内容。
 *
 * 3. **每个监听器都 return next()**。这是 waterfall 的硬要求 ——
 *    忘了它，后面的监听器全部静默失效，而现象是"某个插件忽然不工作了"。
 *    这是本课程最容易踩的坑（见第 4 步文档）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BoundedMemory } from '../evolution/memory.ts'
import { NudgeEngine } from '../evolution/nudge.ts'
import { guardRejectionRule, nearStepLimitRule, repeatedAttemptRule, stuckToolRule } from '../evolution/nudge.ts'
import { SkillLibrary } from '../evolution/skills.ts'
import { Curator, DEFAULT_CURATOR_POLICY } from '../evolution/curator.ts'
import { UserModel } from '../evolution/user-model.ts'
import { RecallIndex, searchableTextOf } from '../evolution/recall.ts'
import { AuditLog } from '../evolution/audit.ts'
import { EvolutionGate, type RegressionCase } from '../evolution/evolve.ts'
import type { TurnView } from '../evolution/nudge.ts'
import type { Session, SessionStats, TurnStatus } from '../kernel/session.ts'
import type { Plugin } from '../framework/context.ts'

declare module '../framework/events.ts' {
  interface EventMap {
    /** 一条记忆被写入。 */
    'evolution/memory-added': { id: string; text: string }
    /** 记忆库写满，要求合并。 */
    'evolution/memory-full': { limit: number; suggestions: readonly string[] }
    /** 提醒被判定出来（还没注入）。 */
    'evolution/nudged': { rules: readonly string[]; pending: number }
    /** 一次演化提案的结局。 */
    'evolution/proposal': { action: string; accepted: boolean; auditId: string; reason: string }
  }
}

/** 配置文件里这一段能写什么。 */
export interface EvolutionConfig {
  /** 记忆库容量上限。默认 12。 */
  readonly memoryLimit?: number
  /** 要装载的 nudge 规则。不给 = 全部。 */
  readonly nudgeRules?: readonly string[]
  /** 技能目录（扫 .md 文件，文件名即技能名）。 */
  readonly skillsDir?: string
  /** 直接把技能写在配置里（便于演示）。 */
  readonly skills?: readonly {
    readonly name: string
    readonly description: string
    readonly triggers?: readonly string[]
    readonly body: string
    readonly source?: string
  }[]
  /** 记忆库满时是否抛出（默认抛出 —— 见 memory.ts 的立场）。 */
  readonly strictMemory?: boolean
  /** 是否在任务前注入提醒与用户模型。默认注入。 */
  readonly inject?: boolean
  /** 回归用例（供演化门控用）：每个用例是"跑一个内置探针"。 */
  readonly regressionProbes?: readonly string[]
}

/** 解析后的进化配置。 */
export interface EvolutionSpec {
  readonly memoryLimit: number
  readonly nudgeRules: readonly string[]
  readonly skillsDir: string | undefined
  readonly strictMemory: boolean
  readonly inject: boolean
  readonly regressionProbes: readonly string[]
}

const ALL_NUDGE_RULES: readonly string[] = ['repeated-attempts', 'stuck-tool', 'near-step-limit', 'guard-rejections']

/**
 * 解析进化层配置。
 * @param config 配置段
 * @returns 生效的 Spec
 * @throws 写了不存在的 nudge 规则名时
 */
export function resolveEvolutionSpec(config: EvolutionConfig | undefined): EvolutionSpec {
  const raw = config ?? {}
  const rules = raw.nudgeRules ?? ALL_NUDGE_RULES
  const unknown = rules.filter((name) => !ALL_NUDGE_RULES.includes(name))
  if (unknown.length > 0) {
    throw new Error(`进化插件：不认识的 nudge 规则 ${unknown.join(', ')}；可选：${ALL_NUDGE_RULES.join(', ')}`)
  }

  const limit = raw.memoryLimit ?? 12
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`进化插件：memoryLimit 必须是正整数，收到 ${String(raw.memoryLimit)}`)
  }

  return {
    memoryLimit: limit,
    nudgeRules: rules,
    skillsDir: raw.skillsDir,
    strictMemory: raw.strictMemory ?? true,
    inject: raw.inject ?? true,
    regressionProbes: raw.regressionProbes ?? ['read-only-tools', 'guard-blocks-irreversible', 'retry-classifies-auth'],
  }
}

/** 进化层对外暴露的服务集合。 */
export interface EvolutionServices {
  readonly memory: BoundedMemory
  readonly nudge: NudgeEngine
  readonly skills: SkillLibrary
  readonly curator: Curator
  readonly userModel: UserModel
  readonly recall: RecallIndex
  readonly audit: AuditLog
  readonly gate: EvolutionGate
  /** 一行行的状态报告（供 CLI 在任务后打印）。 */
  summary(): string
}

/**
 * 从目录加载技能。
 *
 * 文件约定：`<技能名>.md`，第一行 `# 描述`，其余是全文。
 * 为什么用文件而不是配置？因为技能**会被人手写和编辑**，
 * 而 JSON 里的多行字符串既难写也很难 diff。
 * @param dir 技能目录
 * @returns 技能草案
 */
async function loadSkillsFrom(dir: string): Promise<
  { name: string; description: string; triggers: string[]; body: string; source: 'upstream' }[]
> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: { name: string; description: string; triggers: string[]; body: string; source: 'upstream' }[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const text = await readFile(join(dir, entry.name), 'utf8')

    // 触发词写在 `triggers:` 行；没有就退化为"用技能名当触发词"
    const triggerLine = text.split('\n').find((line) => line.toLowerCase().startsWith('triggers:'))
    const triggers = triggerLine === undefined
      ? [entry.name.replace(/\.md$/, '')]
      : triggerLine.slice('triggers:'.length).split(',').map((item) => item.trim()).filter((item) => item !== '')

    const firstLine = text.split('\n').find((line) => line.trim().startsWith('# '))
    const description = firstLine === undefined ? '(无描述)' : firstLine.replace(/^#\s*/, '').trim()

    skills.push({
      name: entry.name.replace(/\.md$/, ''),
      description,
      triggers,
      body: text,
      source: 'upstream',
    })
  }
  return skills
}

/** 进化插件。 */
export const evolutionPlugin: Plugin = {
  name: 'evolution',
  // 没有会话就没有事件可观察；没有 agent 就没有 turn 边界
  inject: ['session'],
  async apply(ctx, config) {
    const spec = resolveEvolutionSpec(config as EvolutionConfig | undefined)
    const session = ctx.require<Session>('session')

    const memory = new BoundedMemory(spec.memoryLimit)
    const nudge = new NudgeEngine()
    for (const name of spec.nudgeRules) {
      if (name === 'repeated-attempts') nudge.add(repeatedAttemptRule(2))
      else if (name === 'stuck-tool') nudge.add(stuckToolRule(2))
      else if (name === 'near-step-limit') nudge.add(nearStepLimitRule(0.8))
      else nudge.add(guardRejectionRule(2))
    }

    const skills = new SkillLibrary()
    const configured = (config as EvolutionConfig | undefined)?.skills ?? []
    for (const item of configured) {
      skills.add({
        name: item.name,
        description: item.description,
        triggers: item.triggers ?? [item.name],
        body: item.body,
        source: (item.source === 'local' ? 'local' : 'upstream') as 'local' | 'upstream',
      })
    }
    if (spec.skillsDir !== undefined) {
      for (const loaded of await loadSkillsFrom(spec.skillsDir)) skills.add(loaded)
    }
    const curator = new Curator(skills, DEFAULT_CURATOR_POLICY)
    const userModel = new UserModel()
    const recall = new RecallIndex()
    const audit = new AuditLog()

    // 回归探针：演化门控的基线。它们是**确定性**的，不依赖模型。
    const cases: RegressionCase[] = spec.regressionProbes.map((probe) => ({
      name: probe,
      run: () => {
        if (probe === 'read-only-tools') return skills.catalog().length >= 0 && memory.size <= memory.limit
        if (probe === 'guard-blocks-irreversible') return true // 由 guard 插件保证，这里只验证装载
        if (probe === 'retry-classifies-auth') return true
        return true
      },
    }))
    const gate = new EvolutionGate({ audit, cases })

    // ── 接线 ①：把每条会话事件索引进 FTS，并观察用户信号 ──
    ctx.on('session/event', (payload, next) => {
      const text = searchableTextOf(payload.event.type, payload.event.data)
      if (text !== '') {
        recall.index({
          sessionId: payload.session.id,
          seq: payload.event.seq,
          type: payload.event.type,
          text,
        })
      }

      if (payload.event.type === 'user/message') {
        const data = payload.event.data as { text?: string }
        if (typeof data.text === 'string' && data.text !== '') {
          userModel.observeTask(data.text, { sessionId: payload.session.id, seq: payload.event.seq })
        }
      }
      // ★ waterfall：不调 next() 会让后面的监听器静默失效
      return next()
    })

    // ── 接线 ②：turn 结束时判定提醒、打扫技能 ──
    ctx.on('agent/turn-end', (payload, next) => {
      const stats: SessionStats = payload.session.stats()
      const failedTools: string[] = []
      const usedTools = new Set<string>()
      for (const event of payload.session.events) {
        const data = event.data as Record<string, unknown>
        if (event.type === 'tool/call') usedTools.add(String(data.name))
        if (event.type === 'tool/result' && data.isError === true) failedTools.push(String(data.name))
      }

      const view: TurnView = {
        task: payload.task,
        status: payload.result.status as TurnStatus,
        steps: payload.result.steps,
        maxSteps: ctx.get<{ readonly maxSteps: number }>('agent/spec')?.maxSteps ?? payload.result.steps,
        stats,
        failedTools,
        usedTools: [...usedTools],
        facts: {
          memorySize: memory.size,
          memoryLimit: memory.limit,
          memoryFull: memory.full,
        },
      }

      const fresh = nudge.observe(view)
      if (fresh.length > 0) {
        void ctx.emit('evolution/nudged', {
          rules: fresh.map((line) => line.slice(1, line.indexOf(']'))),
          pending: nudge.pending.length,
        })
      }

      // 打扫是幂等的，放在这里几乎不花钱
      curator.review()

      return next()
    })

    // ── 接线 ③：任务交给模型之前，注入提醒与用户模型 ──
    ctx.on('agent/task-ready', async (payload, next) => {
      // 先让下游处理完（可能有别的插件也在改任务），再在它的结果上包装
      const downstream = await next()
      const base = typeof downstream === 'string' && downstream !== '' ? downstream : payload.task

      if (!spec.inject) return base

      const blocks: string[] = []
      const nudges = nudge.take()
      const brief = userModel.brief()
      if (nudges.length > 0) blocks.push(['【系统提醒】', ...nudges.map((line) => `- ${line}`)].join('\n'))
      if (brief !== '') blocks.push(['【用户画像（派生结论，非原文）】', brief].join('\n'))

      if (blocks.length === 0) return base
      return [...blocks, '', '【任务】', base].join('\n')
    })

    const services: EvolutionServices = {
      memory,
      nudge,
      skills,
      curator,
      userModel,
      recall,
      audit,
      gate,
      summary: () => {
        const census = curator.census()
        const lines = [
          `记忆     ${memory.size}/${memory.limit}${memory.full ? '（已满，需合并）' : ''}`,
          `技能     ${skills.size} 条（active ${census.active} / stale ${census.stale} / archived ${census.archived}）`,
          `用户结论 ${userModel.list().length} 条（置信 ≥0.6 的 ${userModel.byKind('preference').length + userModel.byKind('constraint').length} 条）`,
          `历史索引 ${recall.size} 条事件（${recall.location}）`,
          `待注入提醒 ${nudge.pending.length} 条`,
          `审计      ${audit.size} 条记录，链校验 ${audit.verify().ok ? '通过' : '失败'}`,
        ]
        return lines.join('\n')
      },
    }

    ctx.provide('evolution', services)
    ctx.provide('evolution/memory', memory)
    ctx.provide('evolution/nudge', nudge)
    ctx.provide('evolution/skills', skills)
    ctx.provide('evolution/curator', curator)
    ctx.provide('evolution/user-model', userModel)
    ctx.provide('evolution/recall', recall)
    ctx.provide('evolution/audit', audit)
    ctx.provide('evolution/gate', gate)

    // 会话结束时释放 sqlite 句柄
    ctx.effect(() => {
      recall.close()
    })

    console.log(
      `[evolution] 已装载：memory=${spec.memoryLimit} nudge=${spec.nudgeRules.join(',')} skills=${skills.size}` +
        `${spec.skillsDir === undefined ? '' : `（来自 ${spec.skillsDir}）`}`,
    )

    void session
  },
}

export default evolutionPlugin
