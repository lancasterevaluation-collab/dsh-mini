/**
 * 离线规则 provider：让"没有 key"时对话框也能真的回应
 *
 * 起因是一个很具体的尴尬：`MockProvider` 的脚本是**固定的**，
 * 于是交互式对话框里敲什么得到的都是同一句台词 ——
 * 那不像对话，像录音回放。
 *
 * 这个 provider 用规则 + 模板补上这段体验：
 *
 *     你 › 看看这个目录里有什么
 *     助手 › （我调用了 list_dir）工作目录里有 3 个条目：README.md、important.txt、notes.txt
 *
 * ── ★ 它不是模型，而且必须自报家门 ★ ─────────────────────────────────
 *
 * 它是正则匹配 + 模板拼装。**所以每次回答里都带着「离线规则模式」这个标记**，
 * 并会说明"要真正的对话请配 DEEPSEEK_API_KEY"。
 *
 * 为什么这一点不能省？因为一个看起来像模型、实际上只是 `if (input.includes('目录'))`
 * 的东西，会让人对系统的能力产生错误判断 —— 那是最糟的一类演示。
 * 整个项目对外的说法是"演示跑在 mock 上，从没假装调用过真实模型"，
 * 这个文件必须守住这句话。
 *
 * ── 它为什么住在 kernel/ 而不是 plugins/ ──────────────────────────────
 *
 * 因为它只实现 `Provider` 接口（一个纯能力），不认识 Context、不认识事件。
 * "把它注册成 `llm` 服务"是 plugins/llm.ts 的事 —— 依赖方向由此保持单向。
 *
 * ── 已知缺陷（坦白）──────────────────────────────────────────────────
 *
 * 1. 意图靠关键词，问法一变就落回兜底回答（"总结一下这个项目"能识别，
 *    "这个仓库是干嘛的"就未必）
 * 2. 它不理解上下文里的代词（"再读一个"办不到）
 * 3. 工具结果的"总结"是机械截断，不是真的概括
 * 4. 没有流式输出（一次性返回整段）
 */

import { LLMError } from './llm.ts'
import type { ChatMessage, LLMResponse, Provider, ToolCall } from './llm.ts'

/** 每次回答都会带上的标记 —— 提醒使用者"这不是真模型"。 */
export const LOCAL_PROVIDER_TAG = '离线规则模式'

/** 一句话说清怎么切到真模型。 */
export const LOCAL_PROVIDER_HINT =
  '要真正的对话，请设置环境变量 DEEPSEEK_API_KEY，然后用 --profile profiles/chat-deepseek.json 启动。'

/** 规则能看到的上下文。 */
interface IntentContext {
  /** 当前注册表里可用的工具名（规则据此决定能不能调工具）。 */
  readonly toolNames: readonly string[]
}

/** 一次规划的结果：要么直接回答，要么先调一个工具。 */
type IntentPlan =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly args: Record<string, unknown> }

/** 一条意图规则。 */
interface Intent {
  readonly name: string
  readonly match: RegExp
  readonly plan: (input: string, context: IntentContext) => IntentPlan
}

/** 从输入里捞出看起来像文件路径的东西。 */
function extractPath(input: string): string | undefined {
  const match = input.match(/([\w./\\-]+\.[A-Za-z0-9]{1,6})\b/)
  return match?.[1]
}

/**
 * 意图表。
 *
 * ★ 顺序即优先级 ★：越具体的规则必须排在越前面。
 * 例如 `/help` 要排在"读文件"前面，否则"帮我看帮助.md"会被当成读文件 ——
 * 这类顺序 bug 的表现是"偶尔答错"，最难查。
 */
const INTENTS: readonly Intent[] = [
  {
    name: 'help',
    match: /^(帮助|help|你会什么|能做什么|怎么用|\/help)/i,
    plan: () => ({
      kind: 'answer',
      text: [
        `我是【${LOCAL_PROVIDER_TAG}】：规则匹配 + 模板，不是语言模型。`,
        '',
        '我现在能做的事：',
        '  · 看看这个目录里有什么      → 调用 list_dir',
        '  · 读一下 README.md          → 调用 read_file',
        '  · 介绍这个项目              → 读 README 并摘要',
        '  · 随便聊点别的              → 我会说明自己是离线模式',
        '',
        LOCAL_PROVIDER_HINT,
      ].join('\n'),
    }),
  },
  {
    name: 'greeting',
    match: /^(你好|您好|hi|hello|hey|哈喽)/i,
    plan: () => ({
      kind: 'answer',
      text: `你好。我是【${LOCAL_PROVIDER_TAG}】—— 只认关键词，不是真模型。\n试试：「看看这个目录里有什么」。`,
    }),
  },
  {
    name: 'about',
    match: /(介绍|这个项目|这是什么|这个仓库|干嘛的|README)/i,
    plan: (_input, context) => {
      if (!context.toolNames.includes('read_file')) {
        return { kind: 'answer', text: '这个工作区里没有 read_file 工具，我读不了 README。' }
      }
      return { kind: 'tool', name: 'read_file', args: { path: 'README.md' } }
    },
  },
  {
    name: 'list',
    match: /(列|看看|看一下|有哪些|有什么|目录|文件列表|结构|清单|list)/i,
    plan: (_input, context) => {
      if (!context.toolNames.includes('list_dir')) {
        return { kind: 'answer', text: '这个工作区里没有 list_dir 工具，我列不了目录。' }
      }
      return { kind: 'tool', name: 'list_dir', args: { path: '.' } }
    },
  },
  {
    name: 'read',
    match: /(读|打开|显示|查看|cat|show|看看)\s*/i,
    plan: (input, context) => {
      const path = extractPath(input)
      if (path === undefined) {
        return { kind: 'answer', text: '要读哪个文件？直接把文件名带上，例如：读一下 notes.txt' }
      }
      if (!context.toolNames.includes('read_file')) {
        return { kind: 'answer', text: '这个工作区里没有 read_file 工具。' }
      }
      return { kind: 'tool', name: 'read_file', args: { path } }
    },
  },
  {
    name: 'delete',
    match: /(删|remove|delete|rm\s)/i,
    plan: (input) => {
      const path = extractPath(input)
      return {
        kind: 'answer',
        text: [
          `删除是不可逆操作${path === undefined ? '' : `（${path}）`}，它必须过守卫的审批。`,
          '本项目的默认配置里审批人是一条白名单，而且是空的 —— 也就是一律拒绝。',
          '要真的删，得显式放开：node src/apps/cli.ts --patch patches/allow-delete.json "删掉 important.txt"',
        ].join('\n'),
      }
    },
  },
  {
    name: 'write',
    match: /(写|创建|新建|保存|write|create)/i,
    plan: () => ({
      kind: 'answer',
      text: [
        '写文件会改变工作目录的状态，属于「可逆但有副作用」的操作 —— 执行前会拍检查点。',
        `不过【${LOCAL_PROVIDER_TAG}】不知道该写什么内容，所以这一步得用真模型来做。`,
        LOCAL_PROVIDER_HINT,
      ].join('\n'),
    }),
  },
]

/** 兜底回答：明确说清"我答不了"以及为什么。 */
function fallback(input: string): IntentPlan {
  const preview = input.length > 40 ? `${input.slice(0, 40)}…` : input
  return {
    kind: 'answer',
    text: [
      `我没法回答「${preview}」—— 我是【${LOCAL_PROVIDER_TAG}】，只认几条关键词规则。`,
      '',
      '能认的有：看看目录 / 读某个文件 / 介绍这个项目 / 帮助。',
      LOCAL_PROVIDER_HINT,
    ].join('\n'),
  }
}

/** 把工具结果整理成一段人话。 */
function summarizeToolResult(name: string, content: string): string {
  const trimmed = content.trim()
  if (trimmed === '') return '工具什么都没返回。'

  if (name === 'list_dir') {
    const entries = trimmed.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const head = entries.slice(0, 12)
    return [
      `工作目录里有 ${entries.length} 个条目：`,
      ...head.map((entry) => `  · ${entry}`),
      ...(entries.length > head.length ? [`  … 还有 ${entries.length - head.length} 个`] : []),
    ].join('\n')
  }

  if (name === 'read_file') {
    const lines = trimmed.split('\n')
    const head = lines.slice(0, 10)
    return [
      `读到了 ${lines.length} 行，开头是：`,
      '```',
      ...head,
      ...(lines.length > head.length ? ['…'] : []),
      '```',
    ].join('\n')
  }

  const lines = trimmed.split('\n')
  return lines.length <= 8
    ? trimmed
    : `${lines.slice(0, 8).join('\n')}\n… （共 ${lines.length} 行）`
}

/**
 * 离线规则 provider。
 *
 * 它的 `chat()` 分两种情况：
 *   - 最后一条消息是 **user** → 匹配意图，决定"直接回答"还是"先调工具"
 *   - 最后一条消息是 **tool** → 把工具结果整理成人话
 *
 * 这个两段式形状是刻意的：它模拟了真实模型的"先要工具、再据结果回答"，
 * 所以上层循环、日志派生、守卫这些机制全都能真实地跑起来。
 */
export class LocalProvider implements Provider {
  #callCount = 0

  /** 被调用了几次（演示与排查用）。 */
  get calls(): number {
    return this.#callCount
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    if (signal?.aborted === true) {
      // 取消语义必须和别的 provider 一致，否则取消路径测不出来
      throw new LLMError('CANCELLED', '请求在开始前已被取消')
    }

    this.#callCount += 1

    const toolNames = (tools ?? [])
      .map((schema) => (schema as { function?: { name?: unknown } }).function?.name)
      .filter((name): name is string => typeof name === 'string')

    const last = messages[messages.length - 1]
    if (last === undefined) {
      return { content: '（没有收到任何消息）', toolCalls: [], usage: {} }
    }

    // ── 情况一：刚拿到工具结果 → 整理成人话 ──
    if (last.role === 'tool') {
      const content = summarizeToolResult(last.name ?? '(未知工具)', last.content)
      return {
        content: `（${LOCAL_PROVIDER_TAG}）${content}`,
        toolCalls: [],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }
    }

    // ── 情况二：用户刚说话 → 匹配意图 ──
    if (last.role === 'user') {
      const input = last.content
      const context: IntentContext = { toolNames }

      for (const intent of INTENTS) {
        if (!intent.match.test(input)) continue
        const plan = intent.plan(input, context)

        if (plan.kind === 'answer') {
          return {
            content: `（${LOCAL_PROVIDER_TAG}）${plan.text}`,
            toolCalls: [],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }
        }

        const call: ToolCall = {
          id: `local-${this.#callCount}`,
          name: plan.name,
          arguments: plan.args,
          rawArguments: JSON.stringify(plan.args),
          parseError: '',
        }
        return {
          content: '',
          toolCalls: [call],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }
      }

      const plan = fallback(input)
      return {
        content: `（${LOCAL_PROVIDER_TAG}）${plan.kind === 'answer' ? plan.text : ''}`,
        toolCalls: [],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }
    }

    // 兜底：assistant / system 结尾的请求（正常循环不会走到这里）
    return { content: `（${LOCAL_PROVIDER_TAG}）我没有更多要说的了。`, toolCalls: [], usage: {} }
  }
}
