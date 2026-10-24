// @author yxpil
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HttpCancelError,
  HttpEngine,
  HttpTimeoutError,
  type EngineRequest,
} from '@main/http/engine'
import { startRange, type Range } from '../../fixtures/range'
import { UA_PRESETS } from '@main/http/ua-presets'

let range: Range
let engine: HttpEngine

const req = (patch: Partial<EngineRequest>): EngineRequest => ({
  method: 'GET',
  url: patch.url ?? range.url('/echo'),
  headers: patch.headers ?? [],
  transport: {
    followRedirects: true,
    maxRedirects: 5,
    timeoutMs: 5000,
    ignoreTlsErrors: false,
    ...(patch.transport ?? {}),
  },
  bodyBase64: patch.bodyBase64,
})

beforeAll(async () => {
  range = await startRange()
  engine = new HttpEngine()
})

afterAll(() => {
  engine.close()
  void range.close()
})

describe('HttpEngine 真实线上行为', () => {
  it('发送 GET 并解析状态码与 JSON 体', async () => {
    const res = await engine.execute(req({}), new AbortController().signal)
    expect(res.status).toBe(200)
    const json = JSON.parse(Buffer.from(res.body).toString('utf8')) as { method: string }
    expect(json.method).toBe('GET')
  })

  it('伪装 UA 真实落线', async () => {
    await engine.execute(
      req({ headers: [['User-Agent', UA_PRESETS['chrome-win']]] }),
      new AbortController().signal,
    )
    const raw = range.last()?.rawHeaders ?? []
    const at = raw.findIndex((h) => h.toLowerCase() === 'user-agent')
    expect(raw[at + 1]).toContain('Windows NT 10.0')
  })

  it('保持自定义 Header 的发送顺序与重复头', async () => {
    await engine.execute(
      req({
        headers: [
          ['X-Second', 'b'],
          ['X-First', 'a'],
          ['X-Dup', '1'],
          ['X-Dup', '2'],
        ],
      }),
      new AbortController().signal,
    )
    const raw = range.last()?.rawHeaders ?? []
    const custom = raw.filter((_, i) => i % 2 === 0 && raw[i]!.toLowerCase().startsWith('x-'))
    expect(custom).toEqual(['X-Second', 'X-First', 'X-Dup', 'X-Dup'])
    const values = raw.reduce<string[]>(
      (acc, h, i) =>
        i % 2 === 1 && raw[i - 1]?.toLowerCase().startsWith('x-') ? [...acc, h] : acc,
      [],
    )
    expect(values).toEqual(['b', 'a', '1', '2'])
  })

  it('请求体按原样送达', async () => {
    const body = JSON.stringify({ a: 1 })
    await engine.execute(
      req({
        method: 'POST',
        url: range.url('/echo'),
        headers: [['content-type', 'application/json']],
        bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
      }),
      new AbortController().signal,
    )
    expect(range.last()?.body).toBe(body)
  })

  it('跟随重定向并记录完整链路', async () => {
    const res = await engine.execute(
      req({
        url: range.url('/redirect?hops=2'),
        transport: {
          followRedirects: true,
          maxRedirects: 5,
          timeoutMs: 5000,
          ignoreTlsErrors: false,
        },
      }),
      new AbortController().signal,
    )
    expect(res.status).toBe(200)
    expect(res.redirects.map((r) => r.status)).toEqual([302, 302])
  })

  it('关闭重定向时把 302 原样返回', async () => {
    const res = await engine.execute(
      req({
        url: range.url('/redirect?hops=1'),
        transport: {
          followRedirects: false,
          maxRedirects: 0,
          timeoutMs: 5000,
          ignoreTlsErrors: false,
        },
      }),
      new AbortController().signal,
    )
    expect(res.status).toBe(302)
    expect(res.redirects).toHaveLength(0)
  })

  it('超过 maxRedirects 停止跳转', async () => {
    const res = await engine.execute(
      req({
        url: range.url('/redirect?hops=5'),
        transport: {
          followRedirects: true,
          maxRedirects: 2,
          timeoutMs: 5000,
          ignoreTlsErrors: false,
        },
      }),
      new AbortController().signal,
    )
    expect(res.status).toBe(302)
    expect(res.redirects).toHaveLength(2)
  })

  it('超时抛 HttpTimeoutError', async () => {
    await expect(
      engine.execute(
        req({
          url: range.url('/slow?ms=1200'),
          transport: {
            followRedirects: true,
            maxRedirects: 5,
            timeoutMs: 200,
            ignoreTlsErrors: false,
          },
        }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HttpTimeoutError)
  })

  it('外部取消抛 HttpCancelError', async () => {
    const controller = new AbortController()
    const pending = engine.execute(req({ url: range.url('/slow?ms=2000') }), controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(HttpCancelError)
  })

  it('错误状态码不被当作异常', async () => {
    const res = await engine.execute(
      req({ url: range.url('/status/500') }),
      new AbortController().signal,
    )
    expect(res.status).toBe(500)
    expect(res.statusText).toBe('Internal Server Error')
  })

  it('大响应体完整接收', async () => {
    const res = await engine.execute(
      req({ url: range.url('/big?kb=600') }),
      new AbortController().signal,
    )
    expect(res.body.byteLength).toBe(600 * 1024)
  })

  it('Set-Cookie 多头都能取到', async () => {
    const res = await engine.execute(
      req({ url: range.url('/cookie') }),
      new AbortController().signal,
    )
    expect(res.setCookies).toHaveLength(2)
    expect(res.setCookies[0]).toContain('sid=abc123')
  })

  it('目标不可达时抛网络错误而非静默', async () => {
    await expect(
      engine.execute(req({ url: 'http://127.0.0.1:1/unreachable' }), new AbortController().signal),
    ).rejects.toThrow()
  })
})
