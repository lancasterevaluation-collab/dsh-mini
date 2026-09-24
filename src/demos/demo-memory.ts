/**
 * 第 12 步演示：有界记忆 + nudge。
 *
 * 运行：  node src/demos/demo-memory.ts
 */

import { BoundedMemory, MemoryFullError } from '../evolution/memory.ts'
import { NudgeEngine, guardRejectionRule, nearStepLimitRule, repeatedAttemptRule, stuckToolRule } from '../evolution/nudge.ts'
import type { TurnView } from '../evolution/nudge.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 造一个 turn 视图（模拟"上一次任务跑得怎么样"）。 */
function makeView(overrides: Partial<TurnView> = {}): TurnView {
  const base: TurnView = {
    task: '演示任务',
    status: 'complete',
    steps: 3,
    maxSteps: 8,
    stats: {
      turns: 1, steps: 3, toolCalls: 2, toolErrors: 0, tokens: 150, messages: 6,
      attempts: 0, guardDenials: 0, guardAsks: 0,
    },
    failedTools: [],
    usedTools: ['read_file'],
    facts: {},
  }
  return { ...base, ...overrides }
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：容量是硬上限 —— 写满即拒绝
  // ==========================================================
  console.log('======== 演示 1：写满即拒绝（不是静默丢弃最旧的） ========')

  const memory = new BoundedMemory(3)
  const source = { sessionId: 'demo', seq: 1 }

  memory.add({ text: '这个项目用 pnpm 而不是 npm', scope: 'project', source, confidence: 0.9 })
  memory.add({ text: '用户偏好简短回答', scope: 'global', source, confidence: 0.7 })
  memory.add({ text: 'pnpm 的 workspace 配置在 pnpm-workspace.yaml', scope: 'project', source, confidence: 0.8 })

  show('当前记忆', { size: memory.size, limit: memory.limit, full: memory.full })

  try {
    memory.add({ text: '第 4 条应该写不进去', scope: 'project', source, confidence: 0.5 })
  } catch (error) {
    if (error instanceof MemoryFullError) {
      show('写入被拒绝（异常里带着可执行的信息）', {
        name: error.name,
        message: error.message,
        suggestions: error.suggestions,
      })
    } else throw error
  }

  // ==========================================================
  // 演示 2：合并 —— 唯一能腾出空间的方式
  // ==========================================================
  console.log('\n======== 演示 2：合并两条，信息不丢 ========')

  const [first, second] = memory.list()
  show('准备合并', [first?.id, second?.id])

  const merged = memory.merge(
    [first?.id as string, second?.id as string],
    '这个项目用 pnpm（不是 npm）；workspace 配置在 pnpm-workspace.yaml',
    { sessionId: 'demo', seq: 5 },
  )
  show('合并结果', merged)
  show('合并后的库', memory.list().map((entry) => ({ id: entry.id, text: entry.text, mergedFrom: entry.mergedFrom })))

  memory.add({ text: '现在有空间了', scope: 'project', source, confidence: 0.5 })
  show('又能写入了', { size: memory.size, limit: memory.limit })

  // ==========================================================
  // 演示 3：nudge —— 把"跑得糟"变成下一轮会读到的一句话
  // ==========================================================
  console.log('\n======== 演示 3：nudge 规则命中 ========')

  const engine = new NudgeEngine()
  engine.add(repeatedAttemptRule(2))
  engine.add(stuckToolRule(2))
  engine.add(nearStepLimitRule(0.8))
  engine.add(guardRejectionRule(2))
  show('已装规则', engine.ruleNames())

  const badView = makeView({
    status: 'max-steps',
    steps: 7,
    stats: {
      turns: 1, steps: 7, toolCalls: 9, toolErrors: 3, tokens: 900, messages: 18,
      attempts: 3, guardDenials: 2, guardAsks: 1,
    },
    failedTools: ['read_file', 'read_file', 'write_file'],
  })

  const fresh = engine.observe(badView)
  show('这次命中的提醒', fresh)

  // 重复观察不该把同一条提醒堆两遍
  const again = engine.observe(badView)
  show('再次观察（不重复堆积）', { 本次新增: again.length, 待注入总数: engine.pending.length })

  // ==========================================================
  // 演示 4：干净的一次任务不该被念
  // ==========================================================
  console.log('\n======== 演示 4：正常的 turn 不产生提醒 ========')

  const cleanEngine = new NudgeEngine()
  cleanEngine.add(repeatedAttemptRule(2))
  cleanEngine.add(stuckToolRule(2))
  cleanEngine.add(nearStepLimitRule(0.8))
  cleanEngine.add(guardRejectionRule(2))
  const clean = cleanEngine.observe(makeView())
  show('命中的提醒（应为空）', clean)

  // ==========================================================
  // 演示 5：拼进下一次任务
  // ==========================================================
  console.log('\n======== 演示 5：提醒怎么进入下一轮 ========')

  const composed = NudgeEngine.compose('把 README 更新一下', engine.take())
  show('拼接后的任务文本', composed)
  console.log('\n★ 注意它放在任务**前面**：模型对开头的约束最敏感。')
  console.log('  而且它最终会作为一条真实的 user/message 进日志 —— 有据可查。')
  show('取走之后 pending 清空', engine.pending)

  // ==========================================================
  // 演示 6：删掉一条错误记忆
  // ==========================================================
  console.log('\n======== 演示 6：用户否定一条记忆 ========')
  const target = memory.list()[0]
  show('删除', { id: target?.id, removed: memory.remove(target?.id as string) })
  show('剩余', memory.list().map((entry) => entry.text))
}

await main()
