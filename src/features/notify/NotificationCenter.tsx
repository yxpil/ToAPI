// @author yxpil
import { useEffect, useMemo } from 'react'
import type { NotificationView, NotifyEventType } from '@shared/channels'
import { NOTIFY_EVENT_TYPES } from '@shared/channels'
import { dayLabel, relTime } from '../../lib/format'
import { useNotify } from '../../stores/notify.store'
import { useRunner } from '../../stores/runner.store'
import { Icon, type IconName } from '../../components/Icon'

/** 通知中心（15 号文档 §5）：底栏铃铛 + 右侧 320px 抽屉 + 应用内 Toast */

const TYPE_LABEL: Record<NotifyEventType, string> = {
  'runner.finished': '运行完成',
  'runner.failed': '运行失败',
  'task.finished': '定时任务',
  'task.misfire': '补跑',
  'node.finished': '节点',
  'open.denied': '外部调用',
  'db.failed': '数据库',
}

const levelIcon = (level: NotificationView['level']): IconName =>
  level === 'error' ? 'alert' : level === 'warn' ? 'alert' : 'info'

export function NotificationBell() {
  const { unread, open, drawerOpen } = useNotify()
  return (
    <button
      className="pill ghost bell-btn"
      title="通知中心"
      aria-label={`通知中心，${unread} 条未读`}
      data-testid="notify-bell"
      aria-expanded={drawerOpen}
      onClick={() => (drawerOpen ? useNotify.getState().close() : void open())}
    >
      <Icon name="bell" size={14} />
      {unread > 0 && (
        <span className="bell-badge" data-testid="notify-unread">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

/** 点击通知跳到来源：运行记录进 Runner 面板，任务进任务面板 */
function jumpTo(item: NotificationView, onJump: (pane: 'runner' | 'task') => void): void {
  void useNotify.getState().markRead(item.id)
  if (item.sourceType === 'runner_run' && item.sourceId) {
    onJump('runner')
    void useRunner.getState().selectRun(item.sourceId)
    return
  }
  if (item.sourceType === 'schedule_task') onJump('task')
}

export function NotificationCenter({ onJump }: { onJump: (pane: 'runner' | 'task') => void }) {
  const {
    drawerOpen,
    items,
    unread,
    nextCursor,
    typeFilter,
    close,
    setFilter,
    markAllRead,
    more,
    markRead,
  } = useNotify()

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, close])

  const groups = useMemo(() => {
    const map = new Map<string, NotificationView[]>()
    for (const item of items) {
      const key = dayLabel(item.createdAt)
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()]
  }, [items])

  if (!drawerOpen) return null

  return (
    <aside className="notify-drawer" data-testid="notify-drawer" aria-label="通知中心">
      <header className="notify-head">
        <span className="dialog-title">通知中心</span>
        <button
          className="pill ghost"
          title="全部标记已读"
          onClick={() => void markAllRead()}
          data-testid="notify-read-all"
        >
          全部已读
        </button>
        <button
          className="pill ghost"
          title="关闭（Esc）"
          onClick={close}
          aria-label="关闭通知中心"
        >
          <Icon name="cross" size={14} />
        </button>
      </header>

      <div className="notify-tabs" role="tablist" aria-label="按类型筛选">
        <button
          type="button"
          role="tab"
          aria-selected={typeFilter === null}
          title="显示全部通知"
          onClick={() => void setFilter(null)}
        >
          全部
        </button>
        {NOTIFY_EVENT_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            role="tab"
            aria-selected={typeFilter === type}
            title={type}
            onClick={() => void setFilter(type)}
          >
            {TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <div className="notify-list">
        {items.length === 0 && <div className="empty">还没有通知</div>}
        {groups.map(([day, list]) => (
          <section key={day} className="notify-group">
            <div className="tree-group">{day}</div>
            {list.map((item) => (
              <article
                key={item.id}
                className={`notify-item ${item.level}${item.read ? ' read' : ''}`}
                data-testid="notify-item"
                onClick={() => jumpTo(item, onJump)}
              >
                <span className="notify-icon">
                  <Icon name={levelIcon(item.level)} size={14} />
                </span>
                <div className="notify-main">
                  <div className="notify-title">
                    {item.title}
                    {item.count > 1 && <span className="notify-merge">×{item.count}</span>}
                  </div>
                  {item.body !== '' && <div className="notify-body">{item.body}</div>}
                  <div className="meta">
                    {relTime(item.createdAt)} · {TYPE_LABEL[item.type]}
                  </div>
                </div>
                {!item.read && (
                  <button
                    className="pill ghost notify-mark"
                    title="标记已读"
                    aria-label="标记已读"
                    onClick={(e) => {
                      e.stopPropagation()
                      void markRead(item.id)
                    }}
                  >
                    <Icon name="check" size={14} />
                  </button>
                )}
              </article>
            ))}
          </section>
        ))}
      </div>

      <footer className="notify-footbar">
        <span className="meta">{unread > 0 ? `${unread} 条未读` : '全部已读'}</span>
        {nextCursor !== null && (
          <button className="pill ghost" title="加载更早的通知" onClick={() => void more()}>
            加载更多
          </button>
        )}
        <button
          className="pill ghost"
          title="通知设置：订阅矩阵、托盘与 Webhook"
          data-testid="notify-settings-open"
          onClick={() => void useNotify.getState().setSettingsOpen(true)}
        >
          <Icon name="gear" size={14} /> 通知设置
        </button>
      </footer>
    </aside>
  )
}

/** 应用内 Toast：2s 自动消失，error 级保留关闭按钮需手动关（15 号文档 §3） */
export function NotifyToast() {
  const toast = useNotify((s) => s.toast)
  const dismiss = useNotify((s) => s.dismissToast)

  useEffect(() => {
    if (!toast || toast.level === 'error') return
    const timer = setTimeout(dismiss, 2000)
    return () => clearTimeout(timer)
  }, [toast, dismiss])

  if (!toast) return null
  return (
    <div
      className={`toast notify-toast${toast.level === 'error' ? ' error' : ''}`}
      role="status"
      data-testid="notify-toast"
    >
      <Icon name={toast.level === 'error' ? 'cross' : 'check'} size={14} />
      <span className="notify-toast-text">{toast.title}</span>
      {toast.level === 'error' && (
        <button className="pill ghost" title="关闭" aria-label="关闭通知" onClick={dismiss}>
          <Icon name="cross" size={14} />
        </button>
      )}
    </div>
  )
}
