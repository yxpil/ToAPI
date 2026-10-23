import { useEffect, useRef } from 'react'

interface Props {
  title: string
  text: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

/** 危险操作二次确认（06 号文档 §5）：白底 1px 边框，取消黑字 / 删除红字 */
export function ConfirmDialog({ title, text, confirmLabel = '删除', onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="overlay" onPointerDown={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-text"
        data-testid="confirm-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="confirm-title">
          {title}
        </div>
        <p className="dialog-text" id="confirm-text">
          {text}
        </p>
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            className="pill"
            title="取消（Esc）"
            onClick={onCancel}
            data-testid="confirm-cancel"
          >
            取消
          </button>
          <button
            className="pill danger"
            title={confirmLabel}
            onClick={onConfirm}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
