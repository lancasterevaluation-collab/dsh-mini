/**
 * 第 4 步演示：事件（waterfall）与依赖注入（inject）。
 *
 * 运行：  node src/demos/demo-events.ts
 */

import { Context } from '../framework/context.ts'
import type { Plugin } from '../framework/context.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 等一轮微任务 + 定时器，让 `void emit(...)` 的异步分发跑完。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：waterfall 的执行顺序
  // ==========================================================
  console.log('======== 演示 1：监听器的调用顺序 ========')

  const root1 = new Context('root1')
  const trace: string[] = []

  root1.on('service/provided', async (payload, next) => {
    trace.push(`① 看到 ${payload.name}`)
    return await next()
  })
  root1.on('service/provided', async (payload, next) => {
    trace.push(`② 看到 ${payload.name}`)
    return await next()
  })
  root1.on('service/provided', async (payload, next) => {
    trace.push(`③ 看到 ${payload.name}`)
    return await next()
  })

  root1.provide('demo-service', 1)
  await tick()
  show('调用顺序（= 注册顺序）', trace)

  // ==========================================================
  // 演示 2：短路 —— 不调 next() 就到此为止
  // ==========================================================
  console.log('\n======== 演示 2：短路 ========')

  const root2 = new Context('root2')
  const seen: string[] = []

  root2.on('service/provided', async (_payload, next) => {
    seen.push('第一级：放行')
    return await next()
  })
  root2.on('service/provided', async () => {
    seen.push('第二级：我处理了，不再往下传')
    return { handled: true } // ← 没有调 next()
  })
  root2.on('service/provided', async (_payload, next) => {
    seen.push('第三级：不应该出现')
    return await next()
  })

  root2.provide('y', 2)
  await tick()
  show('短路的结果', seen)

  // ==========================================================
  // 演示 3：卸载监听器
  // ==========================================================
  console.log('\n======== 演示 3：卸载监听器 ========')

  const root3 = new Context('root3')
  const log: string[] = []

  const off = root3.on('service/provided', async (payload, next) => {
    log.push(`监听器收到 ${payload.name}`)
    return await next()
  })

  root3.provide('a', 1)
  await tick()
  off()
  root3.provide('b', 2)
  await tick()
  show('记录（b 不该出现）', log)

  // ==========================================================
  // 演示 4：依赖不齐 → 挂起 → 依赖就绪 → 自动启动
  // ==========================================================
  console.log('\n======== 演示 4：inject 挂起与唤醒 ========')

  const root4 = new Context('root4')
  const events: string[] = []

  root4.on('plugin/pending', async (payload, next) => {
    events.push(`挂起：${payload.name}（缺 ${payload.missing.join(', ')}）`)
    return await next()
  })
  root4.on('plugin/started', async (payload, next) => {
    events.push(`启动：${payload.name}`)
    return await next()
  })

  const consumer: Plugin = {
    name: 'plugin-consumer',
    inject: ['llm'],
    apply(ctx) {
      const llm = ctx.require<{ model: string }>('llm')
      ctx.provide('answer', `我拿到了 llm，模型是 ${llm.model}`)
    },
  }

  // llm 还不存在 —— 应该挂起，而不是抛错
  await root4.plugin(consumer)
  await tick()
  show('装载 consumer 之后', events)
  show('此时 answer 存在吗', root4.get('answer') !== undefined)

  // 现在提供 llm
  root4.provide('llm', { model: 'deepseek-chat' })
  await tick()
  show('提供 llm 之后', events)
  show('answer 的内容', root4.get('answer'))

  // ==========================================================
  // 演示 5：插件卸载时，它挂的监听器一起消失
  // ==========================================================
  console.log('\n======== 演示 5：监听器随插件卸载 ========')

  const root5 = new Context('root5')
  const hits: string[] = []

  const listenerPlugin: Plugin = {
    name: 'plugin-listener',
    apply(ctx) {
      ctx.on('service/provided', async (payload, next) => {
        hits.push(`${ctx.name} 收到 ${payload.name}`)
        return await next()
      })
    },
  }

  const unload = await root5.plugin(listenerPlugin)
  root5.provide('a', 1)
  await tick()
  unload()
  root5.provide('b', 2)
  await tick()
  show('记录（b 不该出现，因为插件已卸载）', hits)
  show('root5 现在还有监听器的事件', root5.eventNames())

  // ==========================================================
  // 演示 6：挂起的插件被卸载时，不会再被唤醒
  // ==========================================================
  console.log('\n======== 演示 6：挂起的插件被卸载 ========')

  const root6 = new Context('root6')
  const late: string[] = []

  root6.on('plugin/started', async (payload, next) => {
    late.push(`启动：${payload.name}`)
    return await next()
  })

  const waiting: Plugin = {
    name: 'plugin-waiting',
    inject: ['never-comes'],
    apply(ctx) {
      ctx.provide('should-not-exist', 1)
    },
  }

  const cancelWaiting = await root6.plugin(waiting)
  cancelWaiting() // ← 依赖还没来，就把它卸载了
  root6.provide('never-comes', 1) // ← 依赖来了，但它已经卸载了
  await tick()
  show('启动记录（应为空）', late)
  show('should-not-exist 存在吗（应为 false）', root6.get('should-not-exist') !== undefined)

  // 收尾
  root1.dispose()
  root2.dispose()
  root3.dispose()
  root4.dispose()
  root5.dispose()
  root6.dispose()
  console.log('\n所有容器已卸载。')
}

await main()
