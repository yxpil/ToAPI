// @author yxpil
interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  expiresAt: number | null
  httpOnly: boolean
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const pathOf = (url: string): string => {
  try {
    const p = new URL(url).pathname
    return p === '/' ? '/' : p.replace(/\/[^/]*$/, '')
  } catch {
    return '/'
  }
}

const domainMatch = (cookieDomain: string, host: string): boolean =>
  host === cookieDomain || host.endsWith(`.${cookieDomain}`)

const pathMatch = (cookiePath: string, requestPath: string): boolean =>
  cookiePath === '/' ||
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'))

/** 极简 RFC-6265 子集：够用即止，安全语义（SameSite/Secure）在 M1 不实现 */
export class CookieJar {
  private readonly store = new Map<string, CookieRecord[]>()

  private bucket(domain: string): CookieRecord[] {
    const existing = this.store.get(domain)
    if (existing) return existing
    const created: CookieRecord[] = []
    this.store.set(domain, created)
    return created
  }

  ingest(setCookieHeaders: [string, string][], requestUrl: string): void {
    const host = hostOf(requestUrl)
    if (!host) return
    for (const [, raw] of setCookieHeaders) {
      const [pair, ...attrs] = raw.split(';')
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue

      const get = (key: string): string | undefined =>
        attrs
          .map((a) => a.trim())
          .find((a) => a.toLowerCase().startsWith(`${key.toLowerCase()}=`))
          ?.slice(key.length + 1)
          ?.trim()

      const domainRaw = get('domain')
      const domain = (domainRaw ? domainRaw.replace(/^\./, '') : host).toLowerCase()
      const pathRaw = get('path')
      const maxAge = get('max-age')
      const expires = get('expires')
      let expiresAt: number | null = null
      if (maxAge !== undefined) {
        const secs = Number(maxAge)
        expiresAt = Number.isFinite(secs) ? Date.now() + secs * 1000 : null
        if (secs <= 0) {
          this.drop(domain, name)
          continue
        }
      } else if (expires !== undefined) {
        const ts = Date.parse(expires)
        if (Number.isFinite(ts)) expiresAt = ts
      }

      const bucket = this.bucket(domain)
      const record: CookieRecord = {
        name,
        value,
        domain,
        path: pathRaw || pathOf(requestUrl),
        expiresAt,
        httpOnly: attrs.some((a) => a.trim().toLowerCase() === 'httponly'),
      }
      const at = bucket.findIndex((c) => c.name === name && c.path === record.path)
      if (at >= 0) bucket[at] = record
      else bucket.push(record)
    }
  }

  private drop(domain: string, name: string): void {
    const bucket = this.store.get(domain)
    if (!bucket) return
    const at = bucket.findIndex((c) => c.name === name)
    if (at >= 0) bucket.splice(at, 1)
  }

  headerFor(requestUrl: string): string | undefined {
    const records = this.list(requestUrl)
    return records.length > 0 ? records.map((c) => `${c.name}=${c.value}`).join('; ') : undefined
  }

  /** pm.cookies 的只读视图：同域同路径下按名称去重，具体路径优先 */
  list(requestUrl: string): { name: string; value: string }[] {
    const host = hostOf(requestUrl)
    if (!host) return []
    const now = Date.now()
    const byName = new Map<string, CookieRecord>()
    for (const [domain, records] of this.store) {
      if (!domainMatch(domain, host)) continue
      for (const record of records) {
        if (record.expiresAt !== null && record.expiresAt < now) continue
        if (!pathMatch(record.path, pathOf(requestUrl))) continue
        const existing = byName.get(record.name)
        if (!existing || record.path.length > existing.path.length) byName.set(record.name, record)
      }
    }
    return [...byName.values()].map((c) => ({ name: c.name, value: c.value }))
  }

  /** pm.cookies.set：为当前 URL 的域写一个会话 Cookie */
  set(name: string, value: string, requestUrl: string): void {
    const host = hostOf(requestUrl)
    if (!host || !name) return
    const bucket = this.bucket(host)
    const record: CookieRecord = {
      name,
      value,
      domain: host,
      path: pathOf(requestUrl),
      expiresAt: null,
      httpOnly: false,
    }
    const at = bucket.findIndex((c) => c.name === name && c.path === record.path)
    if (at >= 0) bucket[at] = record
    else bucket.push(record)
  }

  /** pm.cookies.unset：删除当前 URL 域下同名 Cookie */
  unset(name: string, requestUrl: string): void {
    const host = hostOf(requestUrl)
    if (!host) return
    for (const [domain, records] of this.store) {
      if (!domainMatch(domain, host)) continue
      const kept = records.filter((c) => c.name !== name)
      if (kept.length === 0) this.store.delete(domain)
      else this.store.set(domain, kept)
    }
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    let n = 0
    for (const records of this.store.values()) n += records.length
    return n
  }
}
