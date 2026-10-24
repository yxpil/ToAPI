// @author yxpil
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  method: string
  path: string
  /** 完整查询串（含前导 ?），用于验证插值与数据行注入 */
  search: string
  /** 原始顺序的头，用于验证伪装语义（07 号文档 §2.2） */
  rawHeaders: string[]
  body: string
}

export interface Range {
  origin: string
  url: (path: string) => string
  requests: CapturedRequest[]
  last: () => CapturedRequest | null
  close: () => Promise<void>
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

/** 集成测试靶场：真实 HTTP 服务，断言线上真实行为而非 mock（07 号文档 §1 硬规则） */
export async function startRange(): Promise<Range> {
  const requests: CapturedRequest[] = []

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      rawHeaders: req.rawHeaders,
      body,
    })

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      res.end(text)
    }

    if (url.pathname === '/echo') {
      send(200, {
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        headers: req.rawHeaders,
        body,
      })
      return
    }

    if (url.pathname === '/redirect') {
      const hops = Number(url.searchParams.get('hops') ?? '1')
      if (hops <= 0) {
        send(200, { done: true })
        return
      }
      res.writeHead(302, { location: `/redirect?hops=${hops - 1}` })
      res.end()
      return
    }

    if (url.pathname === '/cookie') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['sid=abc123; Path=/', 'theme=dark; Path=/; Max-Age=600'],
      })
      res.end(JSON.stringify({ planted: true }))
      return
    }

    if (url.pathname === '/token') {
      send(201, {
        data: { token: 'TOK-' + (url.searchParams.get('user') ?? 'anon'), expiresIn: 3600 },
      })
      return
    }

    if (url.pathname === '/slow') {
      const ms = Number(url.searchParams.get('ms') ?? '500')
      setTimeout(() => send(200, { slow: ms }), ms)
      return
    }

    if (url.pathname === '/big') {
      const kb = Number(url.searchParams.get('kb') ?? '512')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(kb * 1024))
      return
    }

    if (url.pathname.startsWith('/status/')) {
      send(Number(url.pathname.split('/')[2]) || 500, { statusOnly: true })
      return
    }

    send(404, { error: 'not found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${port}`,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    requests,
    last: () => requests.at(-1) ?? null,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}
