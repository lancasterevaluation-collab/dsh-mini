/**
 * 第 1 步演示：亲眼看一遍「模型返回的东西到底长什么样」。
 *
 * 运行：  node src/demos/demo-llm.ts
 * 联网：  完全不需要。全部走 MockProvider。
 */

import { DeepSeekProvider, LLMError, MockProvider } from '../kernel/llm.ts'
import type { ChatMessage, LLMResponse } from '../kernel/llm.ts'

/** 打印一段结构化的东西，方便逐字段核对。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：模型只说了一句话（没有工具调用）
  // ==========================================================
  console.log('======== 演示 1：普通问答 ========')

  const talker = new MockProvider([
    { content: '你好，我是被 mock 出来的模型。', usage: { prompt_tokens: 12, completion_tokens: 9 } },
  ])

  const askWhat: ChatMessage[] = [
    { role: 'system', content: '你是一个简洁的助手。' },
    { role: 'user', content: '你好' },
  ]

  const answer = await talker.chat(askWhat)
  show('模型返回的完整结构', answer)
  show('content 字段', answer.content)
  show('toolCalls 字段', answer.toolCalls)
  show('usage 字段', answer.usage)

  // ==========================================================
  // 演示 2：模型要求调用工具
  // ==========================================================
  console.log('\n======== 演示 2：模型要求调用工具 ========')

  const caller = new MockProvider([
    {
      content: '',
      toolCalls: [{ name: 'read_file', arguments: { path: 'src/llm.ts' } }],
      usage: { prompt_tokens: 30, completion_tokens: 18 },
    },
    { content: '这个文件一共 300 行。' },
  ])

  const wantToRead: ChatMessage[] = [
    { role: 'system', content: '你可以使用工具。' },
    { role: 'user', content: '看一下 src/llm.ts' },
  ]

  const firstTurn = await caller.chat(wantToRead)
  show('第 1 轮：content 是空的', firstTurn.content)
  show('第 1 轮：模型要调用的工具', firstTurn.toolCalls)

  // 关键：arguments 已经被解析成对象，可以直接用
  const call = firstTurn.toolCalls[0]
  if (call !== undefined) {
    show('arguments 是对象，可以直接取字段', call.arguments.path)
    show('rawArguments 是原始字符串', call.rawArguments)
    show('parseError 为空表示解析成功', call.parseError === '')
  }

  // 把「工具结果」按线格式回灌给模型，看它怎么接着回答
  const withResult: ChatMessage[] = [
    ...wantToRead,
    { role: 'assistant', content: firstTurn.content, toolCalls: firstTurn.toolCalls },
    { role: 'tool', content: '（这里是 read_file 的真实输出，省略）', toolCallId: call?.id, name: 'read_file' },
  ]

  const secondTurn = await caller.chat(withResult)
  show('第 2 轮：模型给出了最终回答', secondTurn.content)

  // ==========================================================
  // 演示 3：模型给出的参数是坏 JSON
  // ==========================================================
  console.log('\n======== 演示 3：参数解析失败（这一步很重要） ========')

  const broken = new MockProvider([
    { toolCalls: [{ name: 'read_file', arguments: '{"path": "src/llm.ts",}' }] },
  ])

  const brokenCall = (await broken.chat(askWhat)).toolCalls[0]
  show('坏参数时的 toolCall', brokenCall)
  show('parseError 里写清了原因（这段文字会回灌给模型）', brokenCall?.parseError)

  // ==========================================================
  // 演示 4：脚本用完 + 失败分类
  // ==========================================================
  console.log('\n======== 演示 4：错误分类 ========')

  const empty = new MockProvider([])
  try {
    await empty.chat(askWhat)
  } catch (cause) {
    if (cause instanceof LLMError) {
      show('捕获到的 LLMError.code', cause.code)
      show('捕获到的 LLMError.message', cause.message)
    } else {
      throw cause
    }
  }

  // 证明「模型看到的 = 我们给它的」
  show('MockProvider 记录下来的第 1 次请求消息数', talker.seenMessages[0]?.length ?? 0)
  show('MockProvider 看到的第 1 条消息', talker.seenMessages[0]?.[0])

  // ==========================================================
  // 演示 5：真实调用（没有 API key 就自动跳过）
  // ==========================================================
  console.log('\n======== 演示 5：真实调用 DeepSeek ========')

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey === '') {
    console.log('未检测到 DEEPSEEK_API_KEY，跳过。')
    console.log('想跑通这一步，先设置环境变量（PowerShell）：')
    console.log('  $env:DEEPSEEK_API_KEY = "sk-你的key"')
    console.log('  node src/demo-llm.ts')
    return
  }

  const real = new DeepSeekProvider({
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: 'deepseek-chat',
    timeoutMs: 60_000,
  })

  try {
    const realAnswer: LLMResponse = await real.chat([
      { role: 'system', content: '回答保持一句话。' },
      { role: 'user', content: '用一句话说明什么是 agent loop。' },
    ])
    show('真实模型返回的 content', realAnswer.content)
    show('真实模型返回的 usage', realAnswer.usage)
  } catch (cause) {
    if (cause instanceof LLMError) {
      show('真实调用失败', { code: cause.code, status: cause.status, message: cause.message })
    } else {
      throw cause
    }
  }
}

await main()
