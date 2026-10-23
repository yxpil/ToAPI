import { useState } from 'react'
import type { ReactNode } from 'react'
import type { HistorySummary } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { Icon } from '../../components/Icon'

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

const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const pretty = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 克制用色的 JSON 高亮（06 号文档 §3.6）：key 黑、string 蓝、数字/布尔橙 */
const TOKEN =
  /("(?:\\.|[^"\\])*"(?:\s*:)?)|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function JsonText({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let last = 0
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const isKey = m[1] !== undefined
    nodes.push(
      <span
        key={`${m.index}-${isKey ? 'k' : 'v'}`}
        className={isKey ? 'json-key' : m[2] ? 'json-num' : 'json-str'}
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
  const { response, responseError, sendPending, history, refreshHistory, selectApi } = useApp()
  const [view, setView] = useState<View>('pretty')

  const bodyText = response?.response.bodyText
  const externalBody = response?.response.bodyPath
  const status = response?.response.status ?? 0

  return (
    <section className="response">
      <div className="response-head">
        <div className="segmented" role="tablist" aria-label="响应视图">
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
        {response && (
          <div className="meta" style={{ marginLeft: 'auto' }}>
            <span className={`status ${statusClass(status)}`}>{status}</span>{' '}
            {response.response.statusText} · {response.response.timeMs.toFixed(0)}ms ·{' '}
            {bytes(response.response.bodySizeBytes)}
          </div>
        )}
        {sendPending && <span className="spinner" style={{ marginLeft: 'auto' }} />}
      </div>

      {view === 'history' ? (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div className="tree-row" style={{ justifyContent: 'flex-end' }}>
            <button className="pill ghost" title="刷新历史" onClick={() => void refreshHistory()}>
              <Icon name="refresh" size={14} /> 刷新
            </button>
          </div>
          {history.length === 0 && <div className="empty">暂无历史，先发一个请求</div>}
          {history.map((h: HistorySummary) => (
            <div
              key={h.id}
              className="history-row"
              title={`${h.url} · ${new Date(h.createdAt).toLocaleString()}`}
              onClick={() => h.apiId && void selectApi(h.apiId)}
            >
              <span
                className={`badge ${['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(h.method) ? h.method : 'OTHER'}`}
              >
                {h.method}
              </span>
              <span className={`status ${statusClass(h.status)}`}>{h.status}</span>
              <span className="url">{h.url}</span>
              <span className="meta">{h.timeMs.toFixed(0)}ms</span>
            </div>
          ))}
        </div>
      ) : responseError ? (
        <div className="empty">
          <div style={{ marginBottom: 8 }}>
            <Icon name="alert" size={20} className="" />
          </div>
          <div>{responseError.code}</div>
          <div style={{ marginTop: 4 }}>{responseError.message}</div>
        </div>
      ) : !response ? (
        <div className="empty">还没有响应数据</div>
      ) : (
        <>
          {response.script.assertions.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: '8px 12px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              {response.script.assertions.map((a, i) => (
                <li
                  key={`${a.name}-${i}`}
                  style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}
                >
                  <Icon
                    name={a.pass ? 'check' : 'cross'}
                    size={14}
                    style={{ color: a.pass ? 'var(--ok)' : 'var(--err)' }}
                    label={a.pass ? '断言通过' : '断言失败'}
                  />
                  <span>{a.name}</span>
                  {a.error && <span style={{ color: 'var(--err)' }}>— {a.error}</span>}
                </li>
              ))}
            </ul>
          )}
          {response.extracted.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 12px' }}>
              {response.extracted.map((e) => (
                <span key={e.name} className="badge" title={`${e.scope} · ${e.valuePreview}`}>
                  {e.name}={e.valuePreview}
                </span>
              ))}
            </div>
          )}
          {view === 'headers' ? (
            <table className="kv-table" style={{ marginTop: 0 }}>
              <tbody>
                {response.response.headers.map(([k, v], i) => (
                  <tr key={`${k}-${i}`}>
                    <td style={{ width: '36%', color: 'var(--ink-secondary)' }}>{k}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="response-body">
              {bodyText === undefined ? (
                externalBody ? (
                  `响应体较大（${bytes(response.response.bodySizeBytes)}），已落盘：${externalBody}`
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
