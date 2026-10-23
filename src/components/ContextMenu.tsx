import { useEffect } from 'react'

export interface MenuItem {
  label: string
  danger?: boolean
  onSelect: () => void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

const MENU_WIDTH = 176
const ITEM_HEIGHT = 28

/** 右键菜单（06 号文档 §3.4）：白底 1px 边框、圆角 10px、无阴影，危险项红字 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (): void => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 16)

  return (
    <div
      className="context-menu"
      role="menu"
      data-testid="context-menu"
      style={{ left, top, width: MENU_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          title={item.label}
          className={`menu-item${item.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
