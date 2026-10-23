import type { CSSProperties } from 'react'

/** 内联 SVG 图标注册表（06 号文档 §3.8）：viewBox 24、stroke 1.5、currentColor，禁 emoji */
const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  send: <path d="M4 12l16-8-6 16-2.5-6L4 12z" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  dash: <path d="M6 12h12" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  folder: <path d="M3 7h6l2 2h10v10H3z" />,
  doc: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
    </>
  ),
  duplicate: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
  maximize: <rect x="5" y="5" width="14" height="14" rx="2" />,
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12M7 11l5 5 5-5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  restore: (
    <>
      <rect x="4" y="9" width="11" height="11" rx="2" />
      <path d="M8 9V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3" />
    </>
  ),
} as const

export type IconName = keyof typeof PATHS
export type IconSize = 14 | 16 | 20

interface IconProps {
  name: IconName
  size?: IconSize
  className?: string
  style?: CSSProperties
  label?: string
}

export function Icon({ name, size = 16, className, style, label }: IconProps) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={style}
    >
      {PATHS[name]}
    </svg>
  )
}
