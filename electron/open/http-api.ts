// @author yxpil
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IpcErrorRaised } from '@shared/types'
import type { CallMeta, OpenService } from './service'

/** Local HTTP API（11 号文档 §1）：与 IPC 同构的 IpcResult 载荷，Bearer 调用密码鉴权 */

const MAX_BODY_BYTES = 4 * 1024 * 1024

interface Route {
  method: 'GET' | 'POST'
  /** 匹配前缀；带路径参数的用 fromPath 从 pathname 里取 */
  path: string
  tool: string
  /** 请求体或 query → 工具入参 */
  pick: (input: Record<string, unknown>) => Record<string, unknown>
  fromPath?: (pathname: string) => Record<string, unknown>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const ROUTES: Route[] = [
  { method: 'GET', path: '/v1/projects', tool: 'toapi_list_projects', pick: () => ({}) },
  {
    method: 'GET',
    path: '/v1/project',
    tool: 'toapi_get_project',
    pick: (q) => ({ projectId: q['projectId'] }),
  },
  {
    method: 'GET',
    path: '/v1/apis',
    tool: 'toapi_list_apis',
    pick: (q) => ({
      projectId: q['projectId'],
      ...(typeof q['collectionId'] === 'string' ? { collectionId: q['collectionId'] } : {}),
    }),
  },
  { method: 'GET', path: '/v1/api', tool: 'toapi_get_api', pick: (q) => ({ apiId: q['apiId'] }) },
  {
    method: 'GET',
    path: '/v1/envs',
    tool: 'toapi_list_envs',
    pick: (q) => ({ projectId: q['projectId'] }),
  },
  {
    method: 'GET',
    path: '/v1/env',
    tool: 'toapi_get_env',
    pick: (q) => ({
      projectId: q['projectId'],
      ...(typeof q['environmentId'] === 'string' ? { environmentId: q['environmentId'] } : {}),
    }),
  },
  { method: 'POST', path: '/v1/send', tool: 'toapi_send_request', pick: asRecord },
  { method: 'POST', path: '/v1/run', tool: 'toapi_run_collection', pick: asRecord },
  {
    method: 'GET',
    path: '/v1/run/',
    tool: 'toapi_get_run',
    pick: () => ({}),
    fromPath: (pathname) => ({ runId: pathname.slice('/v1/run/'.length) }),
  },
  {
    method: 'GET',
    path: '/v1/runs',
    tool: 'toapi_list_runs',
    pick: (q) => (q['limit'] !== undefined ? { limit: Number(q['limit']) } : {}),
  },
  {
    method: 'GET',
    path: '/v1/history',
    tool: 'toapi_get_history',
    pick: (q) => ({
      ...(typeof q['projectId'] === 'string' ? { projectId: q['projectId'] } : {}),
      ...(typeof q['apiId'] === 'string' ? { apiId: q['apiId'] } : {}),
      ...(q['limit'] !== undefined ? { limit: Number(q['limit']) } : {}),
    }),
  },
  {
    method: 'GET',
    path: '/v1/skill',
    tool: 'toapi_get_skill',
    pick: (q) => ({
      projectId: q['projectId'],
      ...(typeof q['environmentName'] === 'string'
        ? { environmentName: q['environmentName'] }
        : {}),
    }),
  },
  {
    method: 'GET',
    path: '/v1/tapi',
    tool: 'toapi_export_tapi',
    pick: (q) => ({ projectId: q['projectId'] }),
  },
]

const STATUS_OF: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  RATE_LIMIT: 429,
  CANCELLED: 499,
}

const statusOf = (code: string | undefined): number => STATUS_OF[code ?? 'INTERNAL'] ?? 500

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        reject(new IpcErrorRaised({ code: 'VALIDATION', message: '请求体超过 4MB' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const json = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  cors: Record<string, string>,
): void => {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...cors,
  })
  res.end(text)
}

export interface LocalHttpApiDeps {
  service: OpenService
  appVersion: string
  /** MCP Streamable HTTP 复用同一端口（11 号文档 §2.1） */
  onMcp?: (body: string, meta: CallMeta, secret: string | null) => Promise<unknown>
}

export class LocalHttpApi {
  private server: Server | null = null

  constructor(private readonly deps: LocalHttpApiDeps) {}

  get address(): string | null {
    const info = this.server?.address() as AddressInfo | null
    return info ? `http://${info.address}:${info.port}` : null
  }

  async start(host: string, port: number): Promise<number> {
    if (this.server) return this.port()
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    return this.port()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0
  }

  private bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header)
    return match?.[1]?.trim() ?? null
  }

  private meta(req: IncomingMessage): CallMeta {
    const nameHeader = req.headers['x-client-name']
    const name = Array.isArray(nameHeader) ? nameHeader[0] : nameHeader
    const peer = `${req.socket.remoteAddress ?? 'unknown'}:${(req.socket.remotePort ?? 0) | 0}`
    return {
      channel: 'http',
      client: name ? `http:${name}` : `http:${peer}`,
      ...(name ? { clientName: name } : {}),
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,x-client-name',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    }
    const url = new URL(req.url ?? '/', 'http://local')
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    if (url.pathname === '/v1/health') {
      json(
        res,
        200,
        {
          ok: true,
          data: {
            app: 'ToAPI',
            version: this.deps.appVersion,
            open: this.deps.service.view(),
            tools: this.deps.service.tools().length,
          },
        },
        cors,
      )
      return
    }

    const secret = this.bearer(req)
    if (url.pathname === '/v1/tools' || url.pathname === '/v1/tools/') {
      const denied = this.checkSecret(secret)
      if (denied)
        return json(res, 401, { ok: false, error: { code: 'FORBIDDEN', message: denied } }, cors)
      json(res, 200, { ok: true, data: this.deps.service.tools() }, cors)
      return
    }

    if (url.pathname === '/mcp' && method === 'POST' && this.deps.onMcp) {
      const denied = this.checkSecret(secret)
      if (denied)
        return json(res, 401, { ok: false, error: { code: 'FORBIDDEN', message: denied } }, cors)
      try {
        const result = await this.deps.onMcp(await readBody(req), this.meta(req), secret)
        json(res, 200, result, cors)
      } catch (e) {
        json(
          res,
          400,
          { ok: false, error: { code: 'VALIDATION', message: (e as Error).message } },
          cors,
        )
      }
      return
    }

    const route = ROUTES.find((r) => method === r.method && url.pathname.startsWith(r.path))
    if (!route) {
      json(
        res,
        404,
        { ok: false, error: { code: 'NOT_FOUND', message: `未知端点 ${method} ${url.pathname}` } },
        cors,
      )
      return
    }
    const denied = this.checkSecret(secret)
    if (denied)
      return json(res, 401, { ok: false, error: { code: 'FORBIDDEN', message: denied } }, cors)

    let params: Record<string, unknown>
    try {
      const query: Record<string, unknown> = {}
      for (const [key, value] of url.searchParams) {
        query[key] = value === 'true' ? true : value === 'false' ? false : value
      }
      const body =
        method === 'POST' ? ((JSON.parse((await readBody(req)) || '{}') as unknown) ?? {}) : query
      params = route.fromPath ? route.fromPath(url.pathname) : route.pick(asRecord(body))
    } catch (e) {
      json(
        res,
        400,
        { ok: false, error: { code: 'VALIDATION', message: (e as Error).message } },
        cors,
      )
      return
    }

    const result = await this.deps.service.invoke(route.tool, params, this.meta(req), secret)
    json(
      res,
      result.ok ? 200 : statusOf(result.error?.code),
      result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error },
      cors,
    )
  }

  private checkSecret(secret: string | null): string | null {
    if (!this.deps.service.config.isEnabled()) return '开放通道未启用或未设置调用密码'
    return this.deps.service.config.verify(secret) ? null : '调用密码缺失或不正确'
  }
}
