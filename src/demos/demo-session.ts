/**
 * 第 7 步演示：会话日志。
 *
 * 运行：  node src/demos/demo-session.ts
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, assertModelVisibleMatchesLog } from '../kernel/session.ts'
import type { ToolCall } from '../kernel/llm.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}

/** 造一个工具调用（字段齐全）。 */
function makeCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
    parseError: '',
  }
}

async function main(): Promise<void> {
  const workDir = join(tmpdir(), 'agent-harness-lab-session')
  await rm(workDir, { recursive: true, force: true })

  // ==========================================================
  // 演示 1：记录一次完整的任务
  // ==========================================================
  console.log('======== 演示 1：记录一次任务 ========')

  const session = new Session('demo-1')

  const turn = session.startTurn()
  session.recordUser('帮我看看 src/kernel/llm.ts 有多少行')

  // 第 1 步：模型要求调用工具
  const step1 = session.startStep()
  const call = makeCall('call_1', 'read_file', { path: 'src/kernel/llm.ts' })
  session.recordAssistant('', [call], { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 })
  session.recordToolCall(call.id, call.name)
  session.recordToolResult(call.id, call.name, '   1│ /**\n   2│  * 第 1 步 ｜ 模型层\n...（共 419 行）', false)
  session.endStep(step1)

  // 第 2 步：模型给出最终回答
  const step2 = session.startStep()
  session.recordAssistant('这个文件一共 419 行。', undefined, { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 })
  session.endStep(step2)

  session.endTurn(turn)

  show('事件流（注意 seq 只增不跳）', session.events.map((e) => `${e.seq} ${e.type}`))

  // ==========================================================
  // 演示 2：只有「表面事件」产生消息
  // ==========================================================
  console.log('\n======== 演示 2：表面事件 vs 过程事件 ========')

  const messages = session.deriveMessages()
  show('派生出的消息（这是要发给模型的东西）', messages)
  show('对比', {
    事件总数: session.events.length,
    消息总数: messages.length,
    差值说明: '差的就是过程事件（turn/start、step/start、tool/call…）—— 它们只用于记账',
  })

  // ==========================================================
  // 演示 3：统计 —— 「平均完成步数」从哪来
  // ==========================================================
  console.log('\n======== 演示 3：统计 ========')

  show('这次任务的统计', session.stats())
  console.log('说明：steps 就是「这道题花了多少步」；tokens 是累计用量。')

  // ==========================================================
  // 演示 4：持久化与加载
  // ==========================================================
  console.log('\n======== 演示 4：存盘与读回 ========')

  const path = join(workDir, 'session.jsonl')
  await session.save(path)
  show('存盘路径', path)

  const loaded = await Session.load('demo-1', path)
  show('读回后的事件数', loaded.events.length)
  show('读回后的消息数与原来一致吗', loaded.deriveMessages().length === messages.length)
  show('读回后的统计', loaded.stats())

  // ==========================================================
  // 演示 5：修复未闭合的 turn
  // ==========================================================
  console.log('\n======== 演示 5：进程崩在 turn 中间 ========')

  const broken = new Session('broken')
  broken.startTurn()
  broken.recordUser('这个任务跑到一半就崩了')
  // ★ 故意不调 endTurn

  const brokenPath = join(workDir, 'broken.jsonl')
  await broken.save(brokenPath)
  show('崩之前的最后一条事件', broken.events[broken.events.length - 1]?.type)

  const repaired = await Session.load('broken', brokenPath)
  show('读回后的最后一条事件（应被补成 turn/end）', repaired.events[repaired.events.length - 1])
  show('修复后的统计（turns 应该是 1）', repaired.stats())

  // ==========================================================
  // 演示 6：不变量检查
  // ==========================================================
  console.log('\n======== 演示 6：Model-visible ⟺ logged ========')

  // 正确的情况：实际消息就是派生的消息
  try {
    assertModelVisibleMatchesLog(session, session.deriveMessages())
    show('一致的检查', '通过')
  } catch (error) {
    show('不该失败', error instanceof Error ? error.message : String(error))
  }

  // 篡改：有人绕过日志，直接改了消息
  const tampered = session.deriveMessages()
  tampered[0] = { role: 'user', content: '（被偷偷改过的内容）' }
  try {
    assertModelVisibleMatchesLog(session, tampered)
    show('篡改没被抓到', '这是 bug')
  } catch (error) {
    show('篡改被抓出来', error instanceof Error ? error.message : String(error))
  }

  // 收尾
  await rm(workDir, { recursive: true, force: true })
  console.log('\n演示结束。')
}

await main()
