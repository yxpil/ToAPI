// @author yxpil
import { createInterface } from 'node:readline'
import type { OpenService } from './service'
import type { FieldSpec } from './tools'

/**
 * 内嵌 MCP Server（11 号文档 §2）：stdio 与 Streamable HTTP 双传输共用同一条会话逻辑。
 * 只实现 MCP 的 tools 面（initialize / ping / tools/list / tools/call）—— ToAPI 的能力都在工具里。
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05'

interface RpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

interface RpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonSchemaOf = (params: Record<string, FieldSpec>): Record<string, unknown> => {
  const properties: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(params)) {
    const base =
      spec.type === 'number'
        ? { type: 'number' }
        : spec.type === 'boolean'
          ? { type: 'boolean' }
          : spec.type === 'stringArray'
            ? { type: 'array', items: { type: 'string' } }
            : spec.type === 'recordArray'
              ? {
                  type: 'array',
                  items: { type: 'object', additionalProperties: { type: 'string' } },
                }
              : spec.type === 'object' || spec.type === 'draft'
                ? { type: 'object' }
                : { type: 'string', ...(spec.enum ? { enum: [...spec.enum] } : {}) }
    properties[key] = { ...base, ...(spec.description ? { description: spec.description } : {}) }
  }
  return {
    type: 'object',
    properties,
    required: Object.entries(params)
      .filter(([, spec]) => spec.required)
      .map(([key]) => key),
    additionalProperties: false,
  }
}

export interface McpSessionOptions {
  service: OpenService
  appVersion: string
  /** 本次连接的调用密码：stdio 来自环境变量，HTTP 来自 Bearer */
  secret: string | null
  /** 客户端自报名（stdio 走 initialize 的 clientInfo；HTTP 可在 header 里给） */
  clientName?: string
}

/**
 * 一条 MCP 会话。客户端名在 initialize 时确定，之后所有 tools/call 都记在该客户端名下，
 * 供授权闸门与审计使用（11 号文档 §2.3）。
 */
export class McpSession {
  private clientName: string

  constructor(private readonly opts: McpSessionOptions) {
    this.clientName = opts.clientName?.trim() || 'unknown'
  }

  get client(): string {
    return this.clientName
  }

  /** 返回 null 表示这是通知（无需回包） */
  async handle(raw: RpcRequest): Promise<RpcResponse | null> {
    const id = raw.id ?? null
    const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string): RpcResponse => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })
    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string')
      return fail(-32600, '不是合法 JSON-RPC 请求')
    if (raw.id === undefined || raw.id === null) return null

    switch (raw.method) {
      case 'initialize': {
        const params = isRecord(raw.params) ? raw.params : {}
        const info = isRecord(params['clientInfo']) ? params['clientInfo'] : {}
        if (
          this.clientName === 'unknown' &&
          typeof info['name'] === 'string' &&
          info['name'] !== ''
        )
          this.clientName = info['name']
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ToAPI', version: this.opts.appVersion },
          instructions: `共 ${String(this.opts.service.tools().length)} 个工具；要拿到可读的能力说明书就调 toapi_get_skill。`,
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: this.opts.service.tools().map((t) => ({
            name: t.name,
            title: t.title,
            description: `[${t.kind === 'read' ? '读' : '执行'}] ${t.description}`,
            inputSchema: jsonSchemaOf(t.params),
          })),
        })
      case 'tools/call': {
        const params = isRecord(raw.params) ? raw.params : {}
        const name = typeof params['name'] === 'string' ? params['name'] : ''
        if (!name) return fail(-32602, 'tools/call 需要 name')
        const args = isRecord(params['arguments']) ? params.arguments : {}
        const result = await this.opts.service.invoke(
          name,
          args,
          { channel: 'mcp', client: `mcp:${this.clientName}`, clientName: this.clientName },
          this.opts.secret,
        )
        return reply({
          isError: !result.ok,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                result.ok
                  ? (result.data ?? null)
                  : (result.error ?? { code: 'INTERNAL', message: '调用失败' }),
              ),
            },
          ],
          structuredContent: result.ok ? (result.data ?? null) : undefined,
        })
      }
      default:
        return fail(-32601, `不支持的方法 ${raw.method}`)
    }
  }
}

/** 一次 HTTP 请求 = 一条 JSON-RPC 消息（Streamable HTTP 的最简形态） */
export const mcpOverHttp = async (
  body: string,
  opts: McpSessionOptions,
): Promise<RpcResponse | RpcResponse[] | null> => {
  const parsed = JSON.parse(body) as RpcRequest | RpcRequest[]
  const session = new McpSession(opts)
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const responses: RpcResponse[] = []
  for (const message of messages) {
    const response = await session.handle(message)
    if (response) responses.push(response)
  }
  if (responses.length === 0) return null
  return Array.isArray(parsed) ? responses : responses[0]!
}

/** stdio 传输：逐行 JSON-RPC，供 AI 客户端把 ToAPI 当子进程拉起（§2.1） */
export const serveMcpStdio = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: McpSessionOptions,
): (() => void) => {
  const session = new McpSession(opts)
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let parsed: RpcRequest
    try {
      parsed = JSON.parse(text) as RpcRequest
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`,
      )
      return
    }
    void session.handle(parsed).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`)
    })
  })
  return () => lines.close()
}
