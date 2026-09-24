/**
 * 演示插件：提供一个 config 服务。
 *
 * 注意它的 apply 第二个参数 —— 那就是配置文件里 `config` 字段传进来的东西。
 */

import type { Plugin } from '../framework/context.ts'

const plugin: Plugin = {
  name: 'demo-config',

  apply(ctx, config) {
    // 配置来自外部 JSON，所以在这里做一次取值归一化（边界处校验的原则）
    const workspace = typeof config?.['workspace'] === 'string' ? config['workspace'] : '（未指定）'
    const model = typeof config?.['model'] === 'string' ? config['model'] : 'mock'

    ctx.provide('config', { workspace, model })
  },
}

export default plugin
