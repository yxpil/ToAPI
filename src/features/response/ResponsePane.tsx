import { useState } from 'react'
import type { ReactNode } from 'react'
import { useApp } from '../../stores/app.store'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import { EmptyState } from '../../components/EmptyState'
import { HistoryList } from './HistoryList'
import { formatBytes } from '../../lib/format'

type View = 'pretty' | 'raw' | 'headers' | 'history'

const VIEWS: { id: View; label: string }[] = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'headers', label: 'Headers' },
  { id: 'history', label: '历史' },
]

const statusClass = (status: number): string => {
  if (status >= 500) return 's5'
  if (status >= 400) return 's4'
  if (status >= 200 && status < 300) return 's2'
  return ''
}

const pretty = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 克制用色的 JSON 高亮（06 号文档 §3.6）：key 黑、string 蓝、number/bool 橙 */
const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function JsonText({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let last = 0
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const isKey = m[1] !== undefined && m[2] !== undefined
    nodes.push(
      <span
        key={`${m.index}-${isKey ? 'k' : 'v'}`}
        className={m[1] !== undefined ? (isKey ? 'json-key' : 'json-str') : 'json-num'}
      >
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  TOKEN.lastIndex = 0
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

export function ResponsePane() {
  const { response, responseError, sendPending, send } = useApp()
  const [view, setView] = useState<View>('pretty')

  const bodyText = response?.response.bodyText
  const externalBody = response?.response.bodyPath
  const status = response?.response.status ?? 0

  const sendAction = (
    <button
      className="pill ghost"
      title="发送 (Ctrl+Enter)"
      onClick={() => void send()}
      disabled={sendPending}
    >
      <Icon name="send" size={14} /> 发送
    </button>
  )

  return (
    <section className="response" data-testid="response">
      <div className="response-head">
        <div className="segmented text-tabs" role="tablist" aria-label="响应视图">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              title={v.label}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {response && view !== 'history' && (
          <div className="meta status-line">
            <span className={`status ${statusClass(status)}`}>{status}</span>{' '}
            {response.response.statusText} · {response.response.timeMs.toFixed(0)}ms ·{' '}
            {formatBytes(response.response.bodySizeBytes)}
          </div>
        )}
        {sendPending && (
          <span className="response-pending">
            <Spinner label="发送中" />
          </span>
        )}
      </div>

      {view === 'history' ? (
        <HistoryList />
      ) : responseError ? (
        <EmptyState
          text={`${responseError.code} · ${responseError.message}`}
          action={
            <button
              className="pill ghost"
              title="重试 (Ctrl+Enter)"
              onClick={() => void send()}
              disabled={sendPending}
            >
              <Icon name="refresh" size={14} /> 重试
            </button>
          }
        />
      ) : !response ? (
        <EmptyState text="还没有响应数据" action={sendAction} />
      ) : (
        <>
          {response.script.assertions.length > 0 && (
            <ul className="assertions" aria-label="脚本断言结果">
              {response.script.assertions.map((a, i) => (
                <li key={`${a.name}-${i}`}>
                  <Icon
                    name={a.skipped ? 'minus' : a.pass ? 'check' : 'cross'}
                    size={14}
                    style={{
                      color: a.skipped
                        ? 'var(--ink-tertiary)'
                        : a.pass
                          ? 'var(--ok)'
                          : 'var(--err)',
                    }}
                    label={a.skipped ? '断言跳过' : a.pass ? '断言通过' : '断言失败'}
                  />
                  <span>{a.name}</span>
                  {a.error && <span className="assertion-error">— {a.error}</span>}
                </li>
              ))}
            </ul>
          )}
          {response.extracted.length > 0 && (
            <div className="extracted-row">
              {response.extracted.map((e) => (
                <span key={e.name} className="badge" title={`${e.scope} · ${e.valuePreview}`}>
                  {e.name}={e.valuePreview}
                </span>
              ))}
            </div>
          )}
          {view === 'headers' ? (
            <table className="kv-table">
              <tbody>
                {response.response.headers.map(([k, v], i) => (
                  <tr key={`${k}-${i}`}>
                    <td style={{ width: '36%' }} className="muted">
                      {k}
                    </td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="response-body" data-testid="response-body">
              {bodyText === undefined ? (
                externalBody ? (
                  `响应体较大（${formatBytes(response.response.bodySizeBytes)}），已落盘：${externalBody}`
                ) : (
                  ''
                )
              ) : view === 'pretty' ? (
                <JsonText text={pretty(bodyText)} />
              ) : (
                bodyText
              )}
            </pre>
          )}
        </>
      )}
    </section>
  )
}
