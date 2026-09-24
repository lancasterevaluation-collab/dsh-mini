/**
 * 第 2 步 ｜ 工具注册表
 *
 * 模型能「要求」调用工具，但要真正执行它，需要三样东西：
 *   1. 一张表       —— 名字 → 工具定义
 *   2. 一份说明书    —— 转成 JSON Schema 发给模型，它才知道有哪些工具、参数怎么填
 *   3. 一道关卡     —— 模型给的参数不可信，用之前必须校验
 *
 * 这个文件只做框架，不碰任何真实 IO —— 所以它天然可测试。
 * 具体工具（读文件、写文件）在 builtin-tools.ts 里。
 */

import type { SideEffect } from './guard.ts'

// ============================================================
// 一、JSON Schema：给模型看的「参数说明书」
// ============================================================

/**
 * JSON Schema 的一个最小可用子集。
 *
 * 完整规范有几十个关键字，但真正让模型填对参数只需要这几个：
 * type / description / properties / required / items / enum。
 * 少即是好：schema 也要占 token，而且每多一个字段就多一处模型可能理解错的地方。
 */
export interface JsonSchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  /** 这个字段是干什么用的。**这是写给模型看的**，写清楚能显著减少填错。 */
  readonly description?: string
  /** 仅 type='object' 使用：每个字段名 → 它的 schema。 */
  readonly properties?: Record<string, JsonSchema>
  /** 仅 type='object' 使用：哪些字段必须提供。 */
  readonly required?: readonly string[]
  /** 仅 type='array' 使用：数组元素的结构。 */
  readonly items?: JsonSchema
  /** 限定取值只能是这几个之一。 */
  readonly enum?: readonly (string | number)[]
}

// ============================================================
// 二、工具的返回值：ok / fail 两种，不再有别的
// ============================================================

/** 一次工具执行的结果。 */
export interface ToolResult {
  /** 回灌给模型看的文字。 */
  readonly content: string
  /** 是否是「失败」。注意：失败**不是**异常，它是正常返回值的一种。 */
  readonly isError: boolean
}

/** 造一个成功结果。 */
export function ok(content: string): ToolResult {
  return { content, isError: false }
}

/** 造一个失败结果。 */
export function fail(content: string): ToolResult {
  return { content, isError: true }
}

// ============================================================
// 三、工具的定义与运行环境
// ============================================================

/** 工具运行时拿到的环境信息。 */
export interface ToolContext {
  /** 工作目录。所有相对路径都以它为基准。 */
  readonly workspace: string
}

/**
 * 一个工具 = 名字 + 描述 + 参数说明书 + 副作用等级 + 执行函数。
 */
export interface Tool {
  /** 工具名。模型就是靠这个名字调用的，必须唯一。 */
  readonly name: string
  /** 一句话说清「什么时候该用它」。这行字直接进模型的 prompt。 */
  readonly description: string
  /** 参数说明书。 */
  readonly parameters: JsonSchema
  /**
   * ★ 第 10 步回填 ★ 这个工具的副作用等级。
   *
   * 第 2 步最初没有这个字段。等到第 10 步要做事前拦截时才发现：
   * **不知道哪个工具危险，就没法拦** —— 只能硬编码一串工具名。
   *
   * 这里刻意**不给默认值**：默认可逆会让每个新工具都悄悄获得"能改文件"的许可，
   * 而"该不该给"是一个必须逐工具想清楚的问题。**忘记声明就编译不过**，
   * 这正是我们想要的摩擦。
   */
  readonly sideEffect: SideEffect
  /** 真正干活的函数。收参数、干活、返回 ToolResult。 */
  readonly handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
  /** 单次结果最多保留多少字符，超出截断。默认 {@link DEFAULT_MAX_OUTPUT_CHARS}。 */
  readonly maxOutputChars?: number
}

/** 结果默认的字符上限。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000

// ============================================================
// 四、参数校验：模型给的参数必须先过这一关
// ============================================================

/** 判断一个值是不是「字符串键的对象」。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 给人看的类型名。 */
function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 穷尽检查：如果 switch 漏了某个分支，这一行会直接编译报错。
 * 好处是以后给 JsonSchema 加新类型时，编译器会逼你处理每一处。
 */
function assertNever(value: never): never {
  throw new Error(`未处理的分支：${String(value)}`)
}

/** 值是否符合 schema 声明的类型。 */
function matchesType(schemaType: JsonSchema['type'], value: unknown): boolean {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
  }
  // 走到这里 schemaType 已经是 never —— 说明上面漏了分支
  return assertNever(schemaType)
}

/**
 * 递归校验一个值。
 * @param schema 声明的结构
 * @param value 待检查的值
 * @param path 当前位置，用于错误信息（如 `参数.range.from`）
 * @returns 所有问题；空数组表示通过
 */
export function validateValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const problems: string[] = []

  if (!matchesType(schema.type, value)) {
    problems.push(`${path} 期望 ${schema.type}，实际是 ${typeNameOf(value)}`)
    // 类型都不对，就不要继续往下挑了，否则会报一堆噪音
    return problems
  }

  if (schema.type === 'object' && isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(`${path}.${key} 是必填字段，但没有提供`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue
      problems.push(...validateValue(child, value[key], `${path}.${key}`))
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    const itemSchema = schema.items
    for (const [index, item] of value.entries()) {
      problems.push(...validateValue(itemSchema, item, `${path}[${index}]`))
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
    const allowed = schema.enum.map((item) => JSON.stringify(item)).join(' / ')
    problems.push(`${path} 只能是 ${allowed}，实际是 ${JSON.stringify(value)}`)
  }

  return problems
}

/** 校验一组调用参数。 */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string[] {
  return validateValue(schema, args, '参数')
}

// ============================================================
// 五、工具结果截断
// ============================================================

/**
 * 超长文本截断：保留开头和结尾，砍掉中间。
 * 为什么留尾巴？因为报错信息、失败原因通常**在末尾**，砍掉尾巴等于把最有用的部分扔了。
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.8)
  const tail = limit - head
  const removed = text.length - limit
  return `${text.slice(0, head)}\n\n...（中间省略 ${removed} 个字符）...\n\n${text.slice(text.length - tail)}`
}

// ============================================================
// 六、注册表
// ============================================================

/** 发给模型的工具声明（OpenAI 兼容的线格式）。 */
export interface ToolSchema {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: JsonSchema
  }
}

/**
 * 工具注册表：名字 → 工具。
 *
 * 为什么要有这张表，而不是在 agent 里写 if-else？
 *   1. 工具会越来越多，if-else 会失控；
 *   2. 更重要的是，工具集需要能**按场景裁剪** ——
 *      同一个 agent 在不同任务下应该看到不同的工具（这就是 DeepSeek Harness 里
 *      ctx.tools 的 scoped registry 要解决的问题）。
 */
export class ToolRegistry {
  #tools = new Map<string, Tool>()

  /** 注册一个工具。名字重复直接报错 —— 静默覆盖会让「模型调用了 A，实际跑了 B」。 */
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具名重复："${tool.name}" 已经注册过了`)
    }
    this.#tools.set(tool.name, tool)
  }

  /** 按名字找工具。找不到返回 undefined，由调用方决定怎么处理。 */
  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  /** 全部工具，按注册顺序。 */
  list(): readonly Tool[] {
    return [...this.#tools.values()]
  }

  /** 全部工具名。 */
  names(): string[] {
    return [...this.#tools.keys()]
  }

  /** 转成发给模型的 schema 列表。**模型只能看见这里列出的工具。** */
  schemas(): ToolSchema[] {
    return this.list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }

  /**
   * 执行一次工具调用。**任何失败都变成 fail 结果，绝不抛异常。**
   *
   * 这一点很关键：工具失败是 agent 的日常，不是意外。
   * 抛异常会打断整个循环；返回失败结果则让模型看到「哪里错了」并自己纠正。
   */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name)
    if (tool === undefined) {
      const known = this.names().join(', ')
      return fail(`未知工具 "${name}"。可用工具：${known === '' ? '(无)' : known}`)
    }

    const problems = validateArgs(tool.parameters, args)
    if (problems.length > 0) {
      return fail(`工具 ${name} 的参数不合法：\n- ${problems.join('\n- ')}\n请修正参数后重新调用。`)
    }

    try {
      const result = await tool.handler(args, ctx)
      const limit = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
      return { content: truncate(result.content, limit), isError: result.isError }
    } catch (cause) {
      // 工具自己炸了也不该拖垮 agent：转成失败结果回灌给模型
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      return fail(`工具 ${name} 执行失败：${message}`)
    }
  }
}
