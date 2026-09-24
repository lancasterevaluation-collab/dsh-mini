/**
 * 第 5 步演示：作用域隔离（局部遮蔽）。
 *
 * 运行：  node src/demos/demo-scope.ts
 */

import { Context } from '../framework/context.ts'
import type { Plugin } from '../framework/context.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
}

async function main(): Promise<void> {
  // ==========================================================
  // 准备：一个全局的「工具集」服务
  // ==========================================================
  const root = new Context('root')
  root.provide('tools', ['read_file', 'write_file', 'delete_all'])

  console.log('======== 演示 1：全局服务对所有容器可见 ========')

  const plain = new Context('plain', root)
  show('root 看到', root.get('tools'))
  show('plain 看到', plain.get('tools'))
  show('tools 是谁提供的', root.ownerOf('tools'))

  // ==========================================================
  // 演示 2：局部遮蔽
  // ==========================================================
  console.log('\n======== 演示 2：局部遮蔽全局 ========')

  const agent1 = new Context('agent1', root)
  agent1.isolate('tools', ['read_file']) // ← 只读工具集

  show('agent1 看到', agent1.get('tools'))
  show('root 看到（不受影响）', root.get('tools'))
  show('agent1 的 tools 是谁提供的', agent1.ownerOf('tools'))
  show('agent1 能看见的服务名', agent1.serviceNames())

  // ==========================================================
  // 演示 3：两个作用域互不影响
  // ==========================================================
  console.log('\n======== 演示 3：两个作用域互不影响 ========')

  const agent2 = new Context('agent2', root)
  agent2.isolate('tools', ['read_file', 'write_file'])

  show('agent2 看到', agent2.get('tools'))
  show('agent1 还是只读吗', agent1.get('tools'))
  show('root 还是全量吗', root.get('tools'))

  // ==========================================================
  // 演示 4：局部只对子树可见
  // ==========================================================
  console.log('\n======== 演示 4：局部只对子树可见，兄弟看不到 ========')

  const grandchild = new Context('grandchild', agent1)
  const sibling = new Context('sibling', root)

  show('agent1 的孙子看到（继承）', grandchild.get('tools'))
  show('root 的另一个子容器看到（不该被影响）', sibling.get('tools'))

  // ==========================================================
  // 演示 5：撤销局部后回落到全局
  // ==========================================================
  console.log('\n======== 演示 5：撤销局部后回落全局 ========')

  const agent3 = new Context('agent3', root)
  show('一开始（全局）', agent3.get('tools'))

  const undo = agent3.isolate('tools', ['只读'])
  show('遮蔽后', agent3.get('tools'))

  undo()
  show('撤销后（回落）', agent3.get('tools'))

  // ==========================================================
  // 演示 6：插件在自己的子容器里隔离，不影响外部
  // ==========================================================
  console.log('\n======== 演示 6：插件的隔离不外泄 ========')

  const isolatedPlugin: Plugin = {
    name: 'plugin-isolated',
    apply(ctx) {
      // 只在这个插件的子树内有效
      ctx.isolate('tools', ['read_file'])
      ctx.provide('self-check', `插件内部看到：${(ctx.get<string[]>('tools') ?? []).join(',')}`)
    },
  }

  await root.plugin(isolatedPlugin)
  show('插件内部看到', root.get('self-check'))
  show('插件外部看到（不受影响）', root.get('tools'))
  show('容器树', root.tree())

  // ==========================================================
  // 演示 7：一个作用域里局部服务重名
  // ==========================================================
  console.log('\n======== 演示 7：同一作用域内局部重名 ========')

  const dup = new Context('dup', root)
  dup.isolate('x', 1)
  try {
    dup.isolate('x', 2)
  } catch (error) {
    show('重复的局部服务被拒绝', error instanceof Error ? error.message : String(error))
  }

  // 收尾
  root.dispose()
  console.log('\n所有容器已卸载。')
}

await main()
