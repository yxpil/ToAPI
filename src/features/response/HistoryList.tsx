import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistorySummary } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { Icon } from '../../components/Icon'
import { dayLabel } from '../../lib/format'

const ROW = 32
const OVERSCAN = 4

type Row =
  { kind: 'group'; key: string; label: string } | { kind: 'item'; key: string; h: HistorySummary }

const statusClass = (status: number): string => {
  if (status >= 500) return 's5'
  if (status >= 400) return 's4'
  if (status >= 200 && status < 300) return 's2'
  return ''
}

const methodClass = (method: string): string =>
  ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) ? method : 'OTHER'

/** 历史列表（06 号文档 §3.6 / 07 号文档 §3）：按天分组 + 搜索 + 固定行高虚拟滚动 */
export function HistoryList() {
  const {
    history,
    historyLoading,
    historyNextCursor,
    refreshHistory,
    loadMoreHistory,
    selectApi,
    send,
  } = useApp()
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    setViewport(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = 0
    setScrollTop(0)
  }, [query])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? history.filter((h) => `${h.method} ${h.status} ${h.url}`.toLowerCase().includes(q))
      : history
    const next: Row[] = []
    let day = ''
    for (const h of filtered) {
      const label = dayLabel(h.createdAt)
      if (label !== day) {
        day = label
        next.push({ kind: 'group', key: `g-${label}-${h.id}`, label })
      }
      next.push({ kind: 'item', key: h.id, h })
    }
    return next
  }, [history, query])

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN)
  const visible = rows.slice(start, end)

  return (
    <div className="history-panel" data-testid="history-panel">
      <div className="history-toolbar">
        <span className="history-search-wrap">
          <Icon name="search" size={14} />
          <input
            className="history-search"
            value={query}
            placeholder="搜索 URL / 方法 / 状态码"
            aria-label="搜索历史"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <button
          className="pill ghost"
          title="刷新历史"
          onClick={() => void refreshHistory()}
          disabled={historyLoading}
        >
          <Icon name="refresh" size={14} /> 刷新
        </button>
      </div>

      {rows.length === 0 ? (
        historyLoading ? (
          <div className="skeleton-list" aria-label="历史加载中">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton-row" />
            ))}
          </div>
        ) : (
          <EmptyState
            text={query ? '没有匹配的历史记录' : '暂无历史，先发一个请求'}
            action={
              <button className="pill ghost" title="发送 (Ctrl+Enter)" onClick={() => void send()}>
                <Icon name="send" size={14} /> 发送请求
              </button>
            }
          />
        )
      ) : (
        <div
          className="history-viewport"
          ref={boxRef}
          data-testid="history-viewport"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: rows.length * ROW, position: 'relative' }}>
            <div style={{ position: 'absolute', top: start * ROW, left: 0, right: 0 }}>
              {visible.map((row) =>
                row.kind === 'group' ? (
                  <div key={row.key} className="history-group" style={{ height: ROW }}>
                    {row.label}
                  </div>
                ) : (
                  <div
                    key={row.key}
                    className="history-row"
                    style={{ height: ROW }}
                    title={`${row.h.url} · ${new Date(row.h.createdAt).toLocaleString()}`}
                    onClick={() => row.h.apiId && void selectApi(row.h.apiId)}
                  >
                    <span className={`badge ${methodClass(row.h.method)}`}>{row.h.method}</span>
                    <span className={`status ${statusClass(row.h.status)}`}>{row.h.status}</span>
                    <span className="url">{row.h.url}</span>
                    <span className="meta">{row.h.timeMs.toFixed(0)}ms</span>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      )}

      <div className="history-foot">
        {historyLoading && history.length > 0 ? (
          <span className="meta">
            <Spinner label="加载历史" /> 加载中
          </span>
        ) : historyNextCursor ? (
          <button
            className="pill ghost"
            title="加载更多历史"
            onClick={() => void loadMoreHistory()}
          >
            加载更多
          </button>
        ) : (
          <span className="meta">共 {history.length} 条</span>
        )}
      </div>
    </div>
  )
}
