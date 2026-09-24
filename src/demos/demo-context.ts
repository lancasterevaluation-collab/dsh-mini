/**
 * 第 3 步演示：ctx 容器到底解决了什么问题。
 *
 * 运行：  node src/demos/demo-context.ts
 */

import { Context } from '../framework/context.ts'
import type { Plugin } from '../framework/context.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 报错信息统一打印。 */
function showError(title: string, error: unknown): void {
  show(title, error instanceof Error ? error.message : String(error))
}

// ============================================================
// 三个插件：用来演示注册、查找、卸载
// ============================================================

/** 提供 config 服务。 */
const configPlugin: Plugin = {
  name: 'plugin-config',
  apply(ctx) {
    ctx.provide('config', { workspace: 'D:/agent-harness-lab', model: 'deepseek-chat' })
  },
}

/** 依赖 config，并提供一个派生出来的服务。 */
const greeterPlugin: Plugin = {
  name: 'plugin-greeter',
  apply(ctx) {
    // 注意：greeter 自己没注册 config，它是从父容器查到的
    const config = ctx.require<{ workspace: string; model: string }>('config')
    ctx.provide('greeting', `你好，工作目录是 ${config.workspace}，模型是 ${config.model}`)
  },
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：注册 + 跨插件查找
  // ==========================================================
  console.log('======== 演示 1：服务注册与跨插件查找 ========')

  const root1 = new Context('root1')
  await root1.plugin(configPlugin)
  await root1.plugin(greeterPlugin)

  show('root1 上能看见的服务', root1.serviceNames())
  show('每个服务是谁注册的', root1.serviceNames().map((name) => `${name} ← ${root1.ownerOf(name)}`))
  show('容器树的形状', root1.tree())
  show('greeting 的内容（它是 greeter 插件生成的）', root1.require<string>('greeting'))

  // ==========================================================
  // 演示 2：fail loud —— 缺依赖立刻炸
  // ==========================================================
  console.log('\n======== 演示 2：取不存在的服务 ========')

  try {
    root1.require('nonexistent')
  } catch (error) {
    showError('require 抛出的错误', error)
  }

  show('用 get 查（自己判空，不抛错）', root1.get('nonexistent'))

  // ==========================================================
  // 演示 3：卸载插件 —— 它注册的服务随之消失
  // ==========================================================
  console.log('\n======== 演示 3：卸载插件 ========')

  const root3 = new Context('root3')
  await root3.plugin(configPlugin)
  const unloadGreeter = await root3.plugin(greeterPlugin)

  show('卸载前可见服务', root3.serviceNames())
  unloadGreeter()
  show('卸载后可见服务', root3.serviceNames())
  show('config 还在吗（它属于另一个插件）', root3.get('config') !== undefined)

  // ==========================================================
  // 演示 4：卸载是逆序的
  // ==========================================================
  console.log('\n======== 演示 4：逆序撤销 ========')

  const order: string[] = []
  const orderedPlugin: Plugin = {
    name: 'plugin-ordered',
    apply(ctx) {
      ctx.effect(() => { order.push('① 被撤销') })
      ctx.effect(() => { order.push('② 被撤销') })
      ctx.effect(() => { order.push('③ 被撤销') })
    },
  }

  const root4 = new Context('root4')
  const unloadOrdered = await root4.plugin(orderedPlugin)
  unloadOrdered()
  show('撤销顺序（注意是倒过来的）', order)

  // ==========================================================
  // 演示 5：装载失败 → 已注册的部分被回滚干净
  // ==========================================================
  console.log('\n======== 演示 5：装载到一半失败 ========')

  const root5 = new Context('root5')
  const halfBrokenPlugin: Plugin = {
    name: 'plugin-half-broken',
    apply(ctx) {
      ctx.provide('good-service', '我已经注册好了')
      throw new Error('插件装载到一半，突然失败')
    },
  }

  try {
    await root5.plugin(halfBrokenPlugin)
  } catch (error) {
    showError('装载失败的报错', error)
  }

  show('half-broken 留下的服务（应该是空的）', root5.serviceNames())

  // ==========================================================
  // 演示 6：服务名全局唯一 —— 后来的插件抢不到这个名字
  // ==========================================================
  console.log('\n======== 演示 6：服务名冲突 ========')

  const root6 = new Context('root6')
  await root6.plugin(configPlugin)
  show('config 是谁注册的', root6.ownerOf('config'))

  const rivalPlugin: Plugin = {
    name: 'plugin-rival',
    apply(ctx) {
      ctx.provide('config', { workspace: '/另一个目录', model: 'gpt' })
    },
  }

  try {
    await root6.plugin(rivalPlugin)
  } catch (error) {
    showError('后来的插件被拒绝（报错里指出了是谁占着这个名字）', error)
  }

  show('config 还是原来那个吗', root6.get('config'))
  console.log('\n→ 默认没有隔离是这套设计的代价；第 5 步的 scope 会补上显式隔离层。')

  // 收尾
  root1.dispose()
  root3.dispose()
  root4.dispose()
  root5.dispose()
  root6.dispose()
  console.log('\n所有容器已卸载。')
}

await main()
