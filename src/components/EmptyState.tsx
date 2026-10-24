// @author yxpil
import type { ReactNode } from 'react'

/** 空态（06 号文档 §3.9）：一行 tertiary 小字 + 一个 Ghost 按钮，不画插画 */
export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <div>{text}</div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}
