// @author yxpil
/** 纯 UI 偏好（栏宽、分屏方向）只影响渲染进程，落在 localStorage，不进 SQLite 契约 */
const PREFIX = 'toapi.ui.'

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* 隐私模式或配额满：偏好丢失不影响功能 */
  }
}
