// @author yxpil
import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  label: string
  initial: string
  maxLength?: number
  onCancel: () => void
  onSubmit: (value: string) => void
}

/** 重命名对话框（06 号文档 §3.4）：复用 .dialog 样式，Enter 提交、Esc 取消 */
export function RenameDialog({
  title,
  label,
  initial,
  maxLength = 200,
  onCancel,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.select()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmed = value.trim()
  const commit = (): void => {
    if (trimmed === '' || trimmed === initial) {
      onCancel()
      return
    }
    onSubmit(trimmed)
  }

  return (
    <div className="overlay" onPointerDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        data-testid="rename-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="rename-title">
          {title}
        </div>
        <label className="field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            maxLength={maxLength}
            spellCheck={false}
            aria-label={label}
            data-testid="rename-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
          />
        </label>
        <div className="dialog-actions">
          <button
            className="pill"
            title="取消（Esc）"
            onClick={onCancel}
            data-testid="rename-cancel"
          >
            取消
          </button>
          <button
            className="pill primary"
            title="确定（Enter）"
            disabled={trimmed === ''}
            onClick={commit}
            data-testid="rename-ok"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
