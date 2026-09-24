/**
 * 第 13 步演示：技能库（渐进式披露）+ Curator（生命周期）。
 *
 * 运行：  node src/demos/demo-skills.ts
 */

import { Curator } from '../evolution/curator.ts'
import { SkillLibrary } from '../evolution/skills.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** UTF-8 字节数 —— "渐进披露省了多少"要用字节说话。 */
function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

const DAY = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const library = new SkillLibrary()

  // ==========================================================
  // 演示 1：两种来源的技能
  // ==========================================================
  console.log('======== 演示 1：上游技能与本地技能 ========')

  library.add({
    name: 'adding-a-capability-plugin',
    description: '给 harness 加一个新能力插件（4 步）',
    triggers: ['插件', 'plugin', '新能力'],
    body: '（上游规范全文）\n'.repeat(60),
    source: 'upstream',
  })
  library.add({
    name: 'debugging-waterfall',
    description: '诊断"重试没生效"（5 步排查）',
    triggers: ['重试没生效', 'retry', '监听器', '短路'],
    body: '（上游排查手册全文）\n'.repeat(50),
    source: 'upstream',
  })
  library.add({
    name: 'this-repo-layout',
    description: '本项目目录约定：src/{kernel,framework,plugins,apps,evolution}',
    triggers: ['目录', '结构', 'layout'],
    body: '（本地总结全文）\n'.repeat(20),
    source: 'local',
  })

  show('技能总数', library.size)

  // ==========================================================
  // 演示 2：渐进式披露省了多少
  // ==========================================================
  console.log('\n======== 演示 2：渐进式披露的收益（字节说话） ========')

  const catalog = library.catalog()
  const catalogBytes = bytes(JSON.stringify(catalog))
  const fullBytes = library.adminList().reduce((sum, skill) => sum + bytes(skill.body), 0)

  show('目录（第一级）', catalog)
  show('成本对比', {
    '目录总字节': catalogBytes,
    '全部全文总字节': fullBytes,
    压缩比: `${(fullBytes / catalogBytes).toFixed(1)}×`,
    '不读全文时省下': `${fullBytes - catalogBytes} 字节`,
  })
  console.log('\n★ 模型先只看到目录。只有当它判断"这条与我有关"时才 read(name) 拿全文。')

  // ==========================================================
  // 演示 3：按任务匹配 —— 只给名字，不给全文
  // ==========================================================
  console.log('\n======== 演示 3：按任务匹配（仍然只返回目录条目） ========')

  show('任务「帮我加一个缓存插件」匹配到', library.match('帮我加一个缓存插件'))

  const read = library.read('adding-a-capability-plugin')
  show('读取后（第二级）', { name: read.name, useCount: read.useCount, bodyBytes: bytes(read.body) })
  show('目录里它现在被用过几次', library.catalog().find((item) => item.name === read.name))

  // ==========================================================
  // 演示 4：Curator —— 长期不用就降级
  // ==========================================================
  console.log('\n======== 演示 4：Curator 生命周期 ========')

  const curator = new Curator(library)
  const now = Date.now()

  // 让"本地技能"刚被用过，"上游技能"很久没用
  library.get('this-repo-layout')!.lastUsedAt = now

  const report1 = curator.review(now + 40 * DAY)
  show('过 40 天（超过 staleAfter=30 天）', report1)
  show('状态分布', curator.census())

  const report2 = curator.review(now + 200 * DAY)
  show('再过 160 天（超过 archiveAfter=90 天）', report2)
  show('状态分布', curator.census())

  console.log('\n★ 注意 protectedUpstream：上游技能最多降到 stale，永远不会被归档。')
  console.log('  它们仍然出现在 catalog 里，只是被标注出来了。')

  // ==========================================================
  // 演示 5：归档 ≠ 删除；恢复与拒绝
  // ==========================================================
  console.log('\n======== 演示 5：归档可逆，上游不可删 ========')

  show('默认目录不含 archived', library.catalog().map((item) => item.name))
  show('显式包含 archived', library.catalog(true).map((item) => `${item.name}(${item.status})`))

  const restored = curator.restore('debugging-waterfall')
  show('恢复上游技能', restored)

  try {
    library.remove('debugging-waterfall')
  } catch (error) {
    show('删上游技能被拒绝', error instanceof Error ? error.message : String(error))
  }

  show('删本地技能（允许）', library.remove('this-repo-layout'))
  show('剩余技能', library.adminList().map((skill) => `${skill.name}(${skill.source})`))
}

await main()
