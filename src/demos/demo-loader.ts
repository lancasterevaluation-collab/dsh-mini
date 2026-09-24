/**
 * 第 6 步演示：配置装载。
 *
 * 运行：  node src/demos/demo-loader.ts
 * 注意：  必须在项目根目录运行（profile 路径相对于当前目录）。
 */

import { loadProfile } from '../framework/loader.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
}

/** 等一轮微任务，让挂起插件的唤醒跑完。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：只加载 base bundle
  // ==========================================================
  console.log('======== 演示 1：base-only ========')

  const base = await loadProfile('profiles/base-only.json')
  show('config（来自 bundle）', base.ctx.get('config'))
  show('greeting', base.ctx.get('greeting'))
  show('legacy-extra 装载了吗（disabled，应为 false）', base.ctx.has('legacy'))
  base.dump()

  // ==========================================================
  // 演示 2：dev profile —— patch 覆盖
  // ==========================================================
  console.log('\n======== 演示 2：dev（profile 的 patch 生效） ========')

  const dev = await loadProfile('profiles/dev.json')
  show('config（被 patch 覆盖）', dev.ctx.get('config'))
  show('greeting（前缀也被覆盖）', dev.ctx.get('greeting'))

  // ==========================================================
  // 演示 3：再加一层 --patch
  // ==========================================================
  console.log('\n======== 演示 3：dev + 命令行 patch ========')

  const cli = await loadProfile('profiles/dev.json', ['patches/cli-override.json'])
  show('config（★ 注意 workspace 丢了）', cli.ctx.get('config'))
  show('greeting', cli.ctx.get('greeting'))
  show('新启用的插件', cli.ctx.get('legacy'))
  show('新插入的插件', cli.ctx.get('extra'))
  cli.dump()

  // ==========================================================
  // 演示 4：装载顺序相反也能工作
  // ==========================================================
  console.log('\n======== 演示 4：顺序相反（inject 挂起） ========')

  const reversed = await loadProfile('profiles/reversed.json')
  show('装载完成后 greeting（已经就绪）', reversed.ctx.get('greeting'))
  console.log('说明：greeter 排在 config 前面，装载它时依赖未就绪 → 挂起；')
  console.log('      但两行 await 之间的间隙让唤醒的微任务跑完了，')
  console.log('      所以 loadProfile 返回时它已经启动完毕。')

  // ==========================================================
  // 演示 5：patch 指向不存在的 id
  // ==========================================================
  console.log('\n======== 演示 5：patch 指向不存在的 id ========')

  try {
    await loadProfile('profiles/dev.json', ['patches/bad-id.json'])
  } catch (error) {
    show('被拒绝', error instanceof Error ? error.message : String(error))
  }

  // ==========================================================
  // 收尾：卸载
  // ==========================================================
  base.unloadAll()
  dev.unloadAll()
  cli.unloadAll()
  reversed.unloadAll()

  show('卸载后 dev 的 config 还在吗（应为 false）', dev.ctx.has('config'))
  console.log('\n演示结束。')
}

await main()
