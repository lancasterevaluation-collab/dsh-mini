# 新增一个能力插件（4 步）

triggers: 插件, plugin, 新能力, 加一个工具, 扩展点

## 什么时候用

要给这个 harness 加一个新能力（缓存、token 预算、文件监听…）时。

## 步骤

1. **先问挂在哪，再问怎么写**。列出你能监听的事件与能取到的服务。
   如果答案是"要在 agent-loop 里加个 if"，那么真正的答案是**没有合适的扩展点** ——
   先去补扩展点，再写插件。

2. **建 `src/plugins/<名字>.ts`**，导出 `default` 一个 `Plugin`：
   ```ts
   const plugin: Plugin = {
     name: 'cache',
     inject: ['tools'],            // 只声明"必须有"的依赖
     apply(ctx, config) {
       ctx.provide('cache', new Map())   // 注册服务 = 能力对外可见
     },
   }
   export default plugin
   ```
   `ctx.provide` 是**服务诞生**的动作，注册动作要写在 `apply` 里（卸载时自动回滚）。

3. **挂到 bundle**。在 `bundles/*.json` 里加一行，`plugin` 路径相对 bundle 文件所在目录：
   ```json
   { "id": "cache", "plugin": "../src/plugins/cache.ts", "config": { "max": 100 } }
   ```
   不改任何既有文件 —— 这是"配置即组合"的意义。

4. **验收**：`node src/apps/cli.ts --dump` 看到这一行；卸载它（`"disabled": true`）后任务行为应回到原样。

## 三个容易踩的坑

- **忘了 `return next()`**：监听器不调 `next()` 就是短路，后面的监听器静默失效。
- **在插件里 `import` 另一个插件**：要拿到别的能力，用 `ctx.require(name)`，不要 import。
- **把默认值写在 `apply` 里**：`config.x ?? 3` 会让"生效值是多少"只有读过这行才知道；
  应该有一个 `resolveXxxSpec(config)` 把它变成可打印的对象。
