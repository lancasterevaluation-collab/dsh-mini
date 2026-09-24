/**
 * 演示插件：依赖 config，并派生出 greeting。
 *
 * 注意它声明了 `inject: ['config']` —— 所以**装载顺序不影响它**：
 * 即使它排在 config 前面，也会挂起等待，直到 config 出现。
 */

import type { Plugin } from '../framework/context.ts'

const plugin: Plugin = {
  name: 'demo-greeter',

  inject: ['config'],

  apply(ctx, config) {
    const cfg = ctx.require<{ workspace: string; model: string }>('config')
    const prefix = typeof config?.['prefix'] === 'string' ? config['prefix'] : '你好'

    ctx.provide('greeting', `${prefix}｜工作目录 ${cfg.workspace}｜模型 ${cfg.model}`)
  },
}

export default plugin
