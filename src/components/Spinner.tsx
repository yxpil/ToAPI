// @author yxpil
/** 加载态（06 号文档 §3.9）：12px SVG 细线圆环，CSS 旋转，不用 GIF/边框模拟 */
export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <svg
      className="spinner"
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="8" strokeDasharray="18 40" />
    </svg>
  )
}
