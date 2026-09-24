/**
 * 演示插件：服务名**由配置决定**。
 *
 * 为什么需要它？
 *   同一个插件可以被配置装载多次（不同 id），但如果它硬编码一个服务名，
 *   第二次装载就会报「服务重复注册」—— 因为全局命名空间是唯一的。
 *
 * 两种解法：
 *   ① 让服务名来自配置（这个插件用的办法）
 *   ② 用作用域隔离（第 5 步的 isolate）—— 但那样服务就只在自己的子树里可见
 *
 * 这条经验在真实系统里同样成立：**插件不该假设"只有一个我"。**
 */

import type { Plugin } from '../framework/context.ts'

const plugin: Plugin = {
  name: 'demo-named-service',

  apply(ctx, config) {
    const serviceName = typeof config?.['serviceName'] === 'string'
      ? config['serviceName']
      : 'unnamed'
    const value = typeof config?.['value'] === 'string' ? config['value'] : `我是 ${serviceName}`

    ctx.provide(serviceName, value)
  },
}

export default plugin
