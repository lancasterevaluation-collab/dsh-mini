# 诊断"重试没生效"

triggers: 重试没生效, retry, 监听器, 事件, waterfall, 短路

## 症状

任务失败得太快（该重试的没重试），或者该失败的却重试了十几次。

## 排查顺序（不要跳步）

1. **插件装载了吗？**
   ```sh
   node src/apps/cli.ts --dump "任务"
   ```
   看 `retry` 这一行是否存在、是否被 `disabled`。dump 是配置系统的解药。

2. **事件有没有分发？**
   在会话日志里找 `retry/decided`。没有这条 → 说明钩子根本没被调用
   （循环没拿到 `requestErrorHook`，或 `agent-loop` 没取到 `retry` 服务）。
   有这条但只有一条 → 说明第一次裁决就是 `fail`，问题在**错误分类**。

3. **分类对不对？**
   `retry/decided` 里的 `code` 字段。`AUTH` / `INVALID` 属于**不可重试**，
   重试它们只会浪费预算 —— 这不是 bug。
   而 `SERVER` / `RATE_LIMIT` / `TIMEOUT` 该重试；如果没重试，去查
   `retryableCodes` 配置。

4. **预算拦住了吗？**
   `code` 对、但 `reason` 里出现"预算已用尽" → 是 `budget` 在起作用，
   不是分类错误。

5. **监听器短路了吗？**
   如果别处也监听了 `agent/request-error` 并且**没调 `next()`**，
   它后面的监听器全部失效。搜索 `ctx.on('agent/request-error'` 逐个确认
   每个都 `return next()`。

## 一句话记住

> 重试不是一个函数，是一个**插件的裁决**。所以排查它 = 排查装载、分发、分类、预算、短路这五件事。
