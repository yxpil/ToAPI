import { useEffect, useRef, useState } from 'react'

interface Props {
  /** vertical = 左右分栏的竖线；horizontal = 上下分屏的横线 */
  orientation: 'vertical' | 'horizontal'
  label: string
  testId: string
  onDrag: (clientPos: number) => void
  onNudge: (delta: number) => void
  onEnd: () => void
}

/** 可拖拽分栏（06 号文档 §4）：无视觉轨道，hover/focus 才显出 1px 墨线 */
export function Splitter({ orientation, label, testId, onDrag, onNudge, onEnd }: Props) {
  const dragging = useRef(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragging.current) return
      onDrag(orientation === 'vertical' ? e.clientX : e.clientY)
    }
    const up = (): void => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      onEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [orientation, onDrag, onEnd])

  return (
    <div
      className={`splitter ${orientation}${active ? ' active' : ''}`}
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label}（拖拽或方向键）`}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        setActive(true)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16
        if (orientation === 'vertical' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault()
          onNudge(e.key === 'ArrowLeft' ? -step : step)
        } else if (orientation === 'horizontal' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          onNudge(e.key === 'ArrowUp' ? -step : step)
        }
      }}
    />
  )
}
