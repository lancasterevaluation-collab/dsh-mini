/**
 * 第 8 步演示：agent 循环。
 *
 * 运行：  node src/demos/demo-agent.ts
 */

import { Agent } from '../kernel/agent.ts'
import { MockProvider } from '../kernel/llm.ts'
import { Session } from '../kernel/session.ts'
import { ToolRegistry, ok } from '../kernel/tools.ts'
import type { Tool } from '../kernel/tools.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
}

/** 造一个注册表，装一个 echo 工具。 */
function makeTools(): ToolRegistry {
  const registry = new ToolRegistry()
  const echo: Tool = {
    name: 'echo',
    description: '把输入原样返回。',
    // 第 10 步给 Tool 加了必填的 sideEffect —— 回显不改变任何状态
    sideEffect: 'none',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    async handler(args) {
      return ok(`echo: ${String(args.text)}`)
    },
  }
  registry.register(echo)
  return registry
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：一次完整的任务
  // ==========================================================
  console.log('======== 演示 1：完整任务 ========')

  const session1 = new Session('demo-1')
  const provider1 = new MockProvider([
    { toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] },
    { content: '工具返回了 hello。' },
  ])
  const agent1 = new Agent({
    provider: provider1,
    tools: makeTools(),
    session: session1,
    workspace: '.',
  })

  const result1 = await agent1.run('用 echo 工具回显 hello')
  show('结果', result1)
  show('事件流', session1.events.map((e) => `${e.seq} ${e.type}`))
  show('最终派生出的消息（这就是模型看到的全部）', session1.deriveMessages())

  // ==========================================================
  // 演示 2：一次要求多个工具（配对规则）
  // ==========================================================
  console.log('\n======== 演示 2：一次要求两个工具 ========')

  const session2 = new Session('demo-2')
  const provider2 = new MockProvider([
    {
      toolCalls: [
        { name: 'echo', arguments: { text: 'A' } },
        { name: 'echo', arguments: { text: 'B' } },
      ],
    },
    { content: '两个都完成了。' },
  ])
  const agent2 = new Agent({
    provider: provider2, tools: makeTools(), session: session2, workspace: '.',
  })

  const result2 = await agent2.run('回显 A 和 B')
  show('结果', result2)

  const assistantEvent = session2.events.find((e) => e.type === 'assistant/message')
  const toolResults = session2.events.filter((e) => e.type === 'tool/result')
  show('配对检查', {
    '第 1 步 assistant 要求的工具数': (assistantEvent?.data as { toolCalls?: unknown[] }).toolCalls?.length ?? 0,
    '实际产生的 tool/result 数': toolResults.length,
    说明: '★ 必须相等 —— 少一条服务端就 400',
  })

  // ==========================================================
  // 演示 3：工具失败也产生结果（配对的另一半）
  // ==========================================================
  console.log('\n======== 演示 3：工具失败 ========')

  const session3 = new Session('demo-3')
  const provider3 = new MockProvider([
    { toolCalls: [{ name: 'does_not_exist', arguments: {} }] },
    { toolCalls: [{ name: 'echo', arguments: { text: 123 } }] },
    { content: '我知道错了。' },
  ])
  const agent3 = new Agent({
    provider: provider3, tools: makeTools(), session: session3, workspace: '.',
  })

  await agent3.run('试试不存在的工具')
  show('两次失败的结果都进了日志', session3.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => {
      const data = e.data as { isError: boolean; content: string }
      return `${data.isError ? '✗' : '✓'} ${data.content.split('\n')[0]}`
    }))

  // ==========================================================
  // 演示 4：步数超限
  // ==========================================================
  console.log('\n======== 演示 4：步数超限 ========')

  const session4 = new Session('demo-4')
  const provider4 = new MockProvider([
    { toolCalls: [{ name: 'echo', arguments: { text: '1' } }] },
    { toolCalls: [{ name: 'echo', arguments: { text: '2' } }] },
    { toolCalls: [{ name: 'echo', arguments: { text: '3' } }] },
  ])
  const agent4 = new Agent({
    provider: provider4, tools: makeTools(), session: session4, workspace: '.', maxSteps: 3,
  })

  const result4 = await agent4.run('永远不会结束的任务')
  show('结果', result4)
  show('turn 是怎么闭合的', session4.events[session4.events.length - 1])

  // ==========================================================
  // 演示 5：取消
  // ==========================================================
  console.log('\n======== 演示 5：取消 ========')

  const session5 = new Session('demo-5')
  const agent5 = new Agent({
    provider: new MockProvider([{ content: '（不该被调用）' }]),
    tools: makeTools(),
    session: session5,
    workspace: '.',
  })

  const controller = new AbortController()
  controller.abort() // 一开始就取消

  const result5 = await agent5.run('这个任务会被取消', controller.signal)
  show('结果', result5)
  show('turn 的 reason', (session5.events[session5.events.length - 1]?.data as { reason?: string }).reason)

  // ==========================================================
  // 演示 6：统计 —— 「平均完成步数」的数据来源
  // ==========================================================
  console.log('\n======== 演示 6：统计 ========')

  for (const [name, session] of [['demo-1', session1], ['demo-2', session2], ['demo-4', session4]] as const) {
    const stats = session.stats()
    console.log(`  ${name.padEnd(8)} steps=${stats.steps}  turns=${stats.turns}  工具=${stats.toolCalls}  错误=${stats.toolErrors}`)
  }
  console.log('\n说明：把一批任务的 steps 求平均，就是导师问的「平均完成步数」。')
}

await main()
