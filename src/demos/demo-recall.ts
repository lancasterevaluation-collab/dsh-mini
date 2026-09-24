/**
 * 第 14 步演示：历史检索（FTS5）+ 用户建模（派生结论）。
 *
 * 运行：  node src/demos/demo-recall.ts
 */

import { RecallIndex, searchableTextOf } from '../evolution/recall.ts'
import { UserModel, confidenceOf, extractSignals } from '../evolution/user-model.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 造一批历史事件（模拟三周前跑过的三次任务）。 */
const HISTORY: readonly { sessionId: string; seq: number; type: string; data: unknown }[] = [
  { sessionId: 's-1', seq: 3, type: 'user/message', data: { text: '把 README 更新一下，简短点' } },
  { sessionId: 's-1', seq: 7, type: 'tool/result', data: { name: 'read_file', content: '读取文件失败：ENOENT: no such file or directory', isError: true } },
  { sessionId: 's-1', seq: 11, type: 'assistant/attempt', data: { attempt: 2, code: 'RATE_LIMIT', message: '请求过于频繁' } },
  { sessionId: 's-2', seq: 2, type: 'user/message', data: { text: '检查 pnpm 的 workspace 配置' } },
  { sessionId: 's-2', seq: 5, type: 'assistant/message', data: { content: '这个项目用 pnpm，workspace 配置在 pnpm-workspace.yaml' } },
  { sessionId: 's-2', seq: 9, type: 'tool/guard', data: { verdict: 'deny', byRule: 'pathGuard', detail: '路径越界：../outside.txt' } },
  { sessionId: 's-3', seq: 4, type: 'tool/result', data: { name: 'write_file', content: '写入成功', isError: false } },
  { sessionId: 's-3', seq: 6, type: 'user/message', data: { text: '以后回答用中文，不要解释过程' } },
]

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：建索引
  // ==========================================================
  console.log('======== 演示 1：把历史事件索引进 FTS5 ========')

  const index = new RecallIndex()
  for (const item of HISTORY) {
    const text = searchableTextOf(item.type, item.data)
    if (text !== '') index.index({ sessionId: item.sessionId, seq: item.seq, type: item.type, text })
  }
  show('已索引', { location: index.location, size: index.size })
  console.log('\n★ 注意 searchableTextOf 只索引"有语义的那部分" —— 字段名不进索引，')
  console.log('  否则搜 toolCallId 会命中一切。')

  // ==========================================================
  // 演示 2：中文检索（trigram 分词器的意义）
  // ==========================================================
  console.log('\n======== 演示 2：中文与标识符都能搜到 ========')

  for (const query of ['读取文件失败', 'pnpm', 'pathGuard', 'ENOENT']) {
    const hits = index.search(query)
    console.log(`\n查询 "${query}" → ${hits.length} 条`)
    for (const hit of hits) {
      console.log(`  [${hit.sessionId}#${hit.seq}] ${hit.type}  分数=${hit.score.toFixed(4)}`)
      console.log(`      ${hit.text.slice(0, 70)}`)
    }
  }

  console.log('\n★ trigram 让中文可检索（默认 unicode61 会把整句话当成一个 token）。')
  console.log('  代价：查询至少要 3 个字符 —— 更短的走 LIKE 回退（见 search()）。')

  // ==========================================================
  // 演示 3：短查询回退
  // ==========================================================
  console.log('\n======== 演示 3：短查询走 LIKE 回退 ========')
  show('查询 "pn"（2 字符）', index.search('pn').map((hit) => hit.text.slice(0, 40)))

  // ==========================================================
  // 演示 4：按类型取最近的
  // ==========================================================
  console.log('\n======== 演示 4：按类型取最近 ========')
  show('最近的 assistant/attempt', index.recent('assistant/attempt'))
  show('最近的 tool/guard', index.recent('tool/guard'))

  // ==========================================================
  // 演示 5：用户建模 —— 派生结论，而不是存原文
  // ==========================================================
  console.log('\n======== 演示 5：从任务里提取信号（规则，可解释） ========')

  const model = new UserModel()
  const task = '把 README 更新一下，简短点，用中文'
  show('原始任务（不会存这条原文）', task)
  show('提取到的信号', extractSignals(task, { sessionId: 's-1', seq: 3 }))

  // ==========================================================
  // 演示 6：重复出现才成为偏好
  // ==========================================================
  console.log('\n======== 演示 6：同一结论观察到多次，置信度上升 ========')

  model.observeTask('把 README 更新一下，简短点', { sessionId: 's-1', seq: 3 })
  show('一次之后', model.list().map((item) => ({ text: item.text, 置信: item.confidence.toFixed(3) })))

  model.observeTask('再写一段说明，简短点', { sessionId: 's-2', seq: 1 })
  model.observeTask('总结一下，简短点', { sessionId: 's-3', seq: 2 })
  show('三次之后', model.list().map((item) => ({
    text: item.text,
    observations: item.observations,
    置信: item.confidence.toFixed(3),
    证据数: item.evidence.length,
  })))

  console.log('\n★ 置信度是"次数"的函数，不是模型自报的：')
  for (const n of [1, 2, 3, 5, 9]) console.log(`  ${n} 次 → ${confidenceOf(n).toFixed(3)}`)

  // ==========================================================
  // 演示 7：给模型看的摘要（只保留高置信度）
  // ==========================================================
  console.log('\n======== 演示 7：注入模型的摘要 ========')
  show('摘要（阈值 0.6）', model.brief(0.6))
  show('阈值提到 0.8 后', model.brief(0.8) === '' ? '(空 —— 没有足够确定的结论)' : model.brief(0.8))

  // ==========================================================
  // 演示 8：结论可回溯到事件
  // ==========================================================
  console.log('\n======== 演示 8：每条结论都能回到原始事件 ========')
  const conclusion = model.list()[0]
  show('结论与它的全部出处', conclusion)

  index.close()
}

await main()
