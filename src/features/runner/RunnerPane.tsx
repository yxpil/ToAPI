import { useEffect } from 'react'
import type { RunnerItemView } from '@shared/channels'
import { useEvent } from '../../lib/ipc'
import { useRunner } from '../../stores/runner.store'
import { Icon } from '../../components/Icon'

const statusIcon = (
  status: RunnerItemView['status'],
): { name: 'check' | 'cross' | 'dash'; color: string; label: string } => {
  if (status === 'passed') return { name: 'check', color: 'var(--ok)', label: '通过' }
  if (status === 'skipped') return { name: 'dash', color: 'var(--ink-tertiary)', label: '跳过' }
  return { name: 'cross', color: 'var(--err)', label: '失败' }
}

function ItemRow({ item }: { item: RunnerItemView }) {
  const icon = statusIcon(item.status)
  return (
    <li style={{ borderBottom: '1px solid var(--line)' }}>
      <div className="history-row" title={item.error ?? item.apiName}>
        <Icon
          name={icon.name}
          size={14}
          style={{ color: icon.color }}
          label={`接口${icon.label}`}
        />
        <span className="url" style={{ fontFamily: 'var(--font-ui)' }}>
          {item.apiName}
        </span>
        <span className="meta">{item.timeMs.toFixed(0)}ms</span>
      </div>
      {item.assertions.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 6px 26px' }}>
          {item.assertions.map((a, i) => {
            const mark = statusIcon(a.pass ? 'passed' : 'failed')
            return (
              <li
                key={`${a.name}-${i}`}
                style={{ color: a.pass ? 'var(--ink)' : 'var(--err)', fontSize: 12 }}
              >
                <Icon
                  name={mark.name}
                  size={14}
                  style={{ color: mark.color, verticalAlign: '-2px' }}
                  label={a.pass ? '断言通过' : '断言失败'}
                />{' '}
                {a.name}
                {a.error ? ` — ${a.error}` : ''}
              </li>
            )
          })}
        </ul>
      )}
      {item.error && item.assertions.length === 0 && (
        <div style={{ padding: '0 0 6px 26px', color: 'var(--err)', fontSize: 12 }}>
          {item.error}
        </div>
      )}
    </li>
  )
}

export function RunnerPane() {
  const { runs, current, running, loadRuns, selectRun, cancel } = useRunner()

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  useEvent('event:runner-progress', (payload) => {
    useRunner.getState().applyProgress(payload)
  })

  const passed = current?.items.filter((i) => i.status === 'passed').length ?? 0
  const failed =
    current?.items.filter((i) => i.status === 'failed' || i.status === 'error').length ?? 0
  const rate =
    current && current.items.length > 0 ? Math.round((passed / current.items.length) * 100) : null

  return (
    <div className="pane-body">
      <aside style={{ width: 190, borderRight: '1px solid var(--line)', overflow: 'auto' }}>
        <div className="tree-group">运行记录</div>
        {runs.length === 0 && <div className="empty">还没有运行记录</div>}
        {runs.map((run) => (
          <div
            key={run.id}
            className={`tree-row${current?.id === run.id ? ' selected' : ''}`}
            onClick={() => void selectRun(run.id)}
            title={`${run.scopeName} · ${new Date(run.startedAt).toLocaleString()}`}
          >
            <Icon
              name={run.finishedAt === null ? 'clock' : run.failed > 0 ? 'cross' : 'check'}
              size={14}
            />
            <span className="label">{run.scopeName}</span>
            <span className="meta">
              {run.finishedAt === null ? '运行中' : `${run.passed}/${run.total}`}
            </span>
          </div>
        ))}
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="response-head">
          <span className="meta">
            {current
              ? `${current.scopeName} · ${current.items.length}/${current.total} 项${rate === null ? '' : ` · 通过率 ${rate}%`}`
              : '选择一次运行查看结果'}
          </span>
          {running && (
            <button
              className="pill danger"
              style={{ marginLeft: 'auto' }}
              title="取消运行"
              onClick={() => void cancel()}
            >
              <Icon name="cross" size={14} /> 取消
            </button>
          )}
        </div>
        {current && current.items.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflow: 'auto' }}>
            {current.items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        ) : (
          <div className="empty">
            在左侧集合行点「运行集合」即可批量执行；接口内的断言结果会显示在这里。
            {failed > 0 ? `（本次 ${failed} 项失败）` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
