/**
 * 第 10 步演示：守卫。
 *
 * 运行：  node src/demos/demo-guard.ts
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent } from '../kernel/agent.ts'
import { builtinTools } from '../kernel/builtin-tools.ts'
import { CheckpointStore } from '../kernel/checkpoint.ts'
import {
  allow,
  allowListApprover,
  deny,
  describeSideEffect,
  GuardChain,
  irreversibleGuard,
  loopGuard,
  pathGuard,
  quotaGuard,
} from '../kernel/guard.ts'
import type { SideEffect, ToolCallRequest } from '../kernel/guard.ts'
import { MockProvider } from '../kernel/llm.ts'
import { Session } from '../kernel/session.ts'
import { ToolRegistry } from '../kernel/tools.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 演示用的工作目录。放在 workspace/ 下，与 CLI 演示的沙箱保持一致。 */
const WORKSPACE = 'workspace/guard-demo'

/** 每次演示前把工作目录重置成已知状态。 */
async function resetWorkspace(): Promise<void> {
  await rm(WORKSPACE, { recursive: true, force: true })
  await mkdir(WORKSPACE, { recursive: true })
  await writeFile(join(WORKSPACE, 'a.txt'), '原始内容\n', 'utf8')
  await writeFile(join(WORKSPACE, 'important.txt'), '重要数据\n', 'utf8')
}

/** 装全部内置工具。 */
function makeTools(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of builtinTools) registry.register(tool)
  return registry
}

/** 一个只判 deny 的规则 —— 用来演示单调性。 */
const lockdownRule = { name: 'lockdown', inspect: (): ReturnType<typeof deny> => deny('全局封锁') }

/** 一个永远放行的规则 —— 用来演示"翻不了案"。 */
const permissiveRule = { name: 'permissive', inspect: (): ReturnType<typeof allow> => allow() }

/** 造一个假的请求，用于直接测守卫链（不经过 agent）。 */
function fakeRequest(name: string, sideEffect: SideEffect): ToolCallRequest {
  return { name, args: {}, sideEffect, workspace: WORKSPACE, step: 1 }
}

async function main(): Promise<void> {
  await resetWorkspace()

  // ==========================================================
  // 演示 0：副作用等级表 —— 守卫的全部依据
  // ==========================================================
  console.log('======== 演示 0：工具副作用等级 ========')
  console.log('说明：第 2 步的 Tool 原本没有这个字段，第 10 步回填。\n')
  for (const tool of builtinTools) {
    console.log(`  ${tool.name.padEnd(14)} ${describeSideEffect(tool.sideEffect)}`)
  }
  console.log('\n★ 一个只有 read/write 的 harness 结构上产生不了 C 类失败；')
  console.log('  一旦接进 delete_file（或 rm / git push / 发消息），守卫就必须存在。')

  // ==========================================================
  // 演示 1：循环守卫 —— 连续相同调用被拦
  // ==========================================================
  console.log('\n======== 演示 1：循环守卫 ========')

  const session1 = new Session('guard-1')
  const guards1 = new GuardChain()
  guards1.add(loopGuard(3))

  const provider1 = new MockProvider([
    { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    { content: '我不重复了。' },
  ])

  const agent1 = new Agent({
    provider: provider1, tools: makeTools(), session: session1, workspace: WORKSPACE,
    guards: guards1,
  })

  const result1 = await agent1.run('反复读同一个文件')
  show('结果', result1)
  show('三次调用的结局（第 3 次应该被拦）', session1.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => {
      const d = e.data as { isError: boolean; content: string }
      return `${d.isError ? '✗' : '✓'} ${d.content.split('\n')[0]}`
    }))
  show('守卫拦截记录', session1.events
    .filter((e) => e.type === 'tool/guard')
    .map((e) => {
      const d = e.data as { verdict: string; byRule: string; detail: string }
      return `${d.verdict} by ${d.byRule}：${d.detail.split('\n')[0]}`
    }))
  show('统计', session1.stats())

  // ==========================================================
  // 演示 2：不可逆守卫 —— 审批人拒绝
  // ==========================================================
  console.log('\n======== 演示 2：不可逆操作被拒绝 ========')

  await resetWorkspace()
  const session2 = new Session('guard-2')
  const guards2 = new GuardChain()
  guards2.add(irreversibleGuard())

  const provider2 = new MockProvider([
    { toolCalls: [{ name: 'delete_file', arguments: { path: 'important.txt' } }] },
    { content: '好的，我不删了。' },
  ])

  const agent2 = new Agent({
    provider: provider2, tools: makeTools(), session: session2, workspace: WORKSPACE,
    guards: guards2,
    // ★ 空名单 = 什么也不自动批准
    approver: allowListApprover([]),
  })

  await agent2.run('删掉 important.txt')
  const stillThere = await readFile(join(WORKSPACE, 'important.txt'), 'utf8').then(() => true, () => false)
  show('文件还在吗（应该是 true）', stillThere)
  show('模型收到的失败原因', session2.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => (e.data as { content: string }).content))

  // ==========================================================
  // 演示 3：同一个操作，换个审批人就通过了
  // ==========================================================
  console.log('\n======== 演示 3：审批人批准 ========')

  await resetWorkspace()
  const session3 = new Session('guard-3')
  const guards3 = new GuardChain()
  guards3.add(irreversibleGuard())

  const provider3 = new MockProvider([
    { toolCalls: [{ name: 'delete_file', arguments: { path: 'important.txt' } }] },
    { content: '已删除。' },
  ])

  const agent3 = new Agent({
    provider: provider3, tools: makeTools(), session: session3, workspace: WORKSPACE,
    guards: guards3,
    // ★ 只把 delete_file 放进自动批准名单
    approver: allowListApprover(['delete_file']),
  })

  await agent3.run('删掉 important.txt')
  const gone = await readFile(join(WORKSPACE, 'important.txt'), 'utf8').then(() => false, () => true)
  show('文件被删了吗（应该是 true）', gone)

  // ==========================================================
  // 演示 4：路径守卫 —— 执行前就拦住，而不是等 handler 抛错
  // ==========================================================
  console.log('\n======== 演示 4：路径越界 ========')

  await resetWorkspace()
  const session4 = new Session('guard-4')
  const guards4 = new GuardChain()
  guards4.add(pathGuard('path'))

  const provider4 = new MockProvider([
    { toolCalls: [{ name: 'write_file', arguments: { path: '../outside.txt', content: '越界' } }] },
    { content: '明白了。' },
  ])

  const agent4 = new Agent({
    provider: provider4, tools: makeTools(), session: session4, workspace: WORKSPACE,
    guards: guards4,
  })

  await agent4.run('往上一级写文件')
  show('模型收到的原因', session4.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => (e.data as { content: string }).content))
  console.log('\n★ 注意：即使没有守卫，handler 里的 resolveInsideWorkspace 也会拦住它。')
  console.log('  两者差别在**时机** —— 守卫在副作用发生前，handler 在解析路径时。')

  // ==========================================================
  // 演示 5：配额守卫 —— 限制调用总数，而不是步数
  // ==========================================================
  console.log('\n======== 演示 5：配额守卫 ========')

  const session5 = new Session('guard-5')
  const guards5 = new GuardChain()
  guards5.add(quotaGuard(2))

  const provider5 = new MockProvider([
    { toolCalls: [{ name: 'list_dir', arguments: {} }] },
    { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
    { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
    { content: '配额到了，我直接回答。' },
  ])

  const agent5 = new Agent({
    provider: provider5, tools: makeTools(), session: session5, workspace: WORKSPACE,
    guards: guards5, maxSteps: 10,
  })

  const result5 = await agent5.run('随便看点东西')
  show('结果（只走了 4 步就收工）', result5)
  show('调用次数 / 被拦次数', {
    toolCalls: session5.stats().toolCalls,
    guardDenials: session5.stats().guardDenials,
  })

  // ==========================================================
  // 演示 6：★ 单调性 —— 拒绝不可被翻案 ★
  // ==========================================================
  console.log('\n======== 演示 6：单调性 ========')

  const chain = new GuardChain()
  chain.add(lockdownRule)   // 先注册：一律拒绝
  chain.add(permissiveRule) // 后注册：一律放行（想翻案）

  const outcome = chain.check(fakeRequest('write_file', 'reversible'), [])
  show('裁决', outcome.verdict)
  show('是哪条规则给的', outcome.byRule)
  console.log('\n★ 后注册的 permissive 无法推翻先注册的 lockdown —— 这就是单调性。')
  console.log('  它保证：一个晚注册的插件，改变不了系统早先承诺的安全策略。')

  // ==========================================================
  // 演示 7：B 类 —— 检查点与回滚
  // ==========================================================
  console.log('\n======== 演示 7：检查点与回滚（B 类） ========')

  await resetWorkspace()
  const store = new CheckpointStore(WORKSPACE)

  const cp = await store.snapshot(1)
  show('拍的快照', { id: cp.id, step: cp.step, 文件数: cp.files.length, 文件: cp.files.map((f) => f.path) })

  // 模拟模型犯错：改坏一个、多建一个
  await writeFile(join(WORKSPACE, 'a.txt'), '被改坏了\n', 'utf8')
  await writeFile(join(WORKSPACE, 'b.txt'), '多出来的文件\n', 'utf8')
  show('犯错之后', {
    'a.txt': await readFile(join(WORKSPACE, 'a.txt'), 'utf8').then((t) => t.trim()),
    'b.txt 是否存在': await readFile(join(WORKSPACE, 'b.txt'), 'utf8').then(() => true, () => false),
  })

  const report = await store.rollback('cp-1')
  show('回滚报告', report)
  show('回滚之后', {
    'a.txt': await readFile(join(WORKSPACE, 'a.txt'), 'utf8').then((t) => t.trim()),
    'b.txt 是否存在': await readFile(join(WORKSPACE, 'b.txt'), 'utf8').then(() => true, () => false),
  })
  console.log('\n★ 注意 removed —— 回滚不只要"还原改坏的"，还要"撤销多建出来的"。')
  console.log('  只还原不删除的回滚，会让错误的痕迹留下来，并被下一次快照当成"原本就有"。')

  // ==========================================================
  // 演示 8：四类证据一起看
  // ==========================================================
  console.log('\n======== 演示 8：汇总 ========')
  for (const [name, session] of [
    ['循环守卫', session1], ['审批拒绝', session2], ['审批通过', session3],
    ['路径越界', session4], ['配额超限', session5],
  ] as const) {
    const stats = session.stats()
    console.log(
      `  ${name.padEnd(10)} 步=${stats.steps}  调用=${stats.toolCalls}  工具错=${stats.toolErrors}` +
        `  ★拒绝=${stats.guardDenials}  ★问人=${stats.guardAsks}`,
    )
  }
  console.log('\n说明：guardDenials / guardAsks 是第 10 步给统计加的两个字段 ——')
  console.log('      它们是"干预触发率"的数据来源（见 error-taxonomy.md 的沉默型问题 #2）。')
}

await main()
