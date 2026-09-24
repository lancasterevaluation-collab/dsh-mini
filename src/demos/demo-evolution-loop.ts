/**
 * 进化闭环演示（第 12–16 步的集成）：跑两次任务，看第一次的教训如何进入第二次。
 *
 * 运行：  node src/demos/demo-evolution-loop.ts
 *
 * 这个演示刻意用**完整的 profile 装载**（不是手工 new），
 * 因为"插件化"这件事只有在真实装载路径下才算被验证过。
 */

import { resolve } from 'node:path'
import { loadProfile } from '../framework/loader.ts'
import type { AgentService } from '../plugins/agent-loop.ts'
import type { EvolutionServices } from '../plugins/evolution.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const HERE = import.meta.dirname

async function main(): Promise<void> {
  const loaded = await loadProfile(resolve(HERE, '../../profiles/evolution.json'), [], {
    // 让装载日志安静一点：这个演示的重点是闭环，不是每个插件的自述
  })

  const ctx = loaded.ctx
  const agent = ctx.get<AgentService>('agent')
  const evolution = ctx.get<EvolutionServices>('evolution')
  if (agent === undefined || evolution === undefined) {
    console.error('profile 里缺少 agent 或 evolution 服务')
    process.exitCode = 1
    return
  }

  show('插件树', ctx.tree())

  try {
    // ==========================================================
    // 第 1 次任务：一个会被守卫拒绝的任务
    // ==========================================================
    console.log('\n======== 第 1 次任务：请求删除文件（会被守卫拒绝） ========')

    const first = await agent.runTask('删掉 important.txt')
    show('第 1 次结果', first)
    show('第 1 次的守卫记录', agent.session.events
      .filter((event) => event.type === 'tool/guard')
      .map((event) => {
        const data = event.data as { byRule: string; detail: string }
        return `${data.byRule}：${data.detail.split('\n')[0]}`
      }))

    // ==========================================================
    // 第 2 次任务：同样的会话，但任务文本会被扩展点改写
    // ==========================================================
    console.log('\n======== 第 2 次任务：读 README ========')

    const second = await agent.runTask('读一下 README 并总结')
    show('第 2 次结果', second)

    // ==========================================================
    // 关键证据 1：模型收到的任务里带上了提醒
    // ==========================================================
    console.log('\n======== 证据 1：提醒是怎么进到模型眼里的 ========')

    const userMessages = agent.session.events
      .filter((event) => event.type === 'user/message')
      .map((event) => (event.data as { text: string }).text)

    show('第 2 次任务实际记进日志的 user/message', userMessages[1])

    console.log('\n★ 注意两点：')
    console.log('  1. 提醒是作为**真实的 user/message** 进日志的 —— 所以"谁在什么时候被提醒了什么"可查')
    console.log('  2. 它没有凭空插进会话中间（那会破坏 append-only 的事实性）')

    // ==========================================================
    // 关键证据 2：历史被索引了
    // ==========================================================
    console.log('\n======== 证据 2：FTS5 检索历史 ========')

    for (const query of ['important', '拒绝', 'README']) {
      const hits = evolution.recall.search(query, 3)
      console.log(`\n查询 "${query}" → ${hits.length} 条`)
      for (const hit of hits) {
        console.log(`  [${hit.sessionId}#${hit.seq}] ${hit.type}：${hit.text.slice(0, 60)}`)
      }
    }

    // ==========================================================
    // 关键证据 3：用户建模（派生结论）
    // ==========================================================
    console.log('\n======== 证据 3：用户模型（结论 + 出处） ========')

    for (const conclusion of evolution.userModel.list()) {
      console.log(`  ${conclusion.kind}｜${conclusion.text}`)
      console.log(`      观察 ${conclusion.observations} 次，置信 ${conclusion.confidence.toFixed(2)}，出处 ${conclusion.evidence.map((item) => `${item.sessionId}#${item.seq}`).join(', ')}`)
    }
    show('注入模型的摘要', evolution.userModel.brief() || '(空)')

    // ==========================================================
    // 关键证据 4：技能库（渐进式披露）
    // ==========================================================
    console.log('\n======== 证据 4：技能目录（只有名字与描述） ========')

    show('目录', evolution.skills.catalog().map((item) => `${item.name} — ${item.description}`))
    show('任务「加一个缓存插件」匹配到', evolution.skills.match('加一个缓存插件').map((item) => item.name))

    // ==========================================================
    // 关键证据 5：诊断
    // ==========================================================
    console.log('\n======== 证据 5：对刚才两次任务做归因 ========')

    const { classifyFailure, featuresOf } = await import('../evolution/diagnose.ts')
    const stats = agent.session.stats()
    const features = featuresOf(agent.session, 8)
    const diagnosis = classifyFailure(features)
    show('整个会话的特征与归因', {
      步数: stats.steps,
      工具调用: stats.toolCalls,
      工具失败: stats.toolErrors,
      守卫拒绝: stats.guardDenials,
      归因: diagnosis.component,
      理由: diagnosis.reason,
      证据: diagnosis.evidence,
    })

    // ==========================================================
    // 总览
    // ==========================================================
    console.log('\n======== 进化层总览 ========')
    console.log(evolution.summary())
    console.log(`\n审计链校验：${evolution.audit.verify().ok ? '通过' : '失败'}（本次演示没有自改提案，所以链是空的）`)
  } finally {
    loaded.unloadAll()
  }
}

await main()
