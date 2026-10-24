// @author yxpil
import type { NotifyLevel, WebhookTemplate } from '@shared/channels'

/** Webhook 投递与 IM 机器人模板（15 号文档 §3.3）：secret 值永不出现在载荷里 */

export interface WebhookPayloadSource {
  type: string
  level: NotifyLevel
  title: string
  body: string
  sourceType: string | null
  sourceId: string | null
  count: number
  ts: number
}

const text = (s: WebhookPayloadSource): string =>
  `[ToAPI] ${s.title}${s.count > 1 ? `（含 ${s.count} 条同类事件）` : ''}\n${s.body}`

export const buildWebhookBody = (
  template: WebhookTemplate,
  s: WebhookPayloadSource,
): Record<string, unknown> => {
  switch (template) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: `**${s.title}**\n${s.body}` } }
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text(s) } }
    case 'feishu':
      return { msg_type: 'text', content: { text: text(s) } }
    case 'raw':
      return {
        app: 'ToAPI',
        type: s.type,
        level: s.level,
        title: s.title,
        body: s.body,
        run_id: s.sourceType === 'runner_run' ? s.sourceId : null,
        count: s.count,
        ts: s.ts,
      }
  }
}

export interface WebhookResult {
  ok: boolean
  status: number
  error: string | null
}

/** URL 必须是 http(s)，且只允许一次跳转（避免被引到内网其他机器） */
export const assertWebhookUrl = (url: string): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Webhook 地址不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook 只支持 http/https')
  }
}

const TIMEOUT_MS = 5000

export async function postWebhook(
  url: string,
  template: WebhookTemplate,
  source: WebhookPayloadSource,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  try {
    assertWebhookUrl(url)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(template, source)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = res.ok ? '' : ` · ${(await res.text().catch(() => '')).slice(0, 200)}`
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}${body}`,
    }
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  }
}
