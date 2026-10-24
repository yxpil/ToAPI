// @author yxpil
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { SettingsRepo } from '../db/repo/settings.repo'
import type { OpenAccessMode, OpenClientView, OpenConfigView } from '@shared/channels'

/** 开放通道配置与「调用密码」闸门（11 号文档 §0/§1.1/§2.3） */

const KEY = 'open.config'
export const DEFAULT_PORT = 4730
export const DEFAULT_RATE_PER_MIN = 60
/** 自动生成密码的字节数（hex 后 64 字符） */
const SECRET_BYTES = 32

export interface AuthorizedClient {
  id: string
  name: string
  kind: 'http' | 'mcp'
  authorizedAt: number
  lastSeenAt: number
}

interface StoredConfig {
  enabled: boolean
  port: number
  access: OpenAccessMode
  ratePerMin: number
  salt: string | null
  hash: string | null
  passwordSetAt: number | null
  clients: AuthorizedClient[]
}

const DEFAULTS: StoredConfig = {
  enabled: false,
  port: DEFAULT_PORT,
  access: 'loopback',
  ratePerMin: DEFAULT_RATE_PER_MIN,
  salt: null,
  hash: null,
  passwordSetAt: null,
  clients: [],
}

const derive = (secret: string, salt: string): string =>
  scryptSync(secret, Buffer.from(salt, 'hex'), 32).toString('hex')

export class OpenConfig {
  private cached: StoredConfig | null = null

  constructor(private readonly settings: SettingsRepo) {}

  private load(): StoredConfig {
    if (this.cached) return this.cached
    const stored = this.settings.get<Partial<StoredConfig>>(KEY, {})
    this.cached = {
      ...DEFAULTS,
      ...stored,
      clients: Array.isArray(stored.clients) ? (stored.clients as AuthorizedClient[]) : [],
    }
    return this.cached
  }

  private save(next: StoredConfig): void {
    this.cached = next
    this.settings.set(KEY, next)
  }

  /** 视图：永不返回 salt/hash，只返回「是否已设密码」 */
  view(): OpenConfigView {
    const c = this.load()
    return {
      enabled: c.enabled,
      running: false,
      port: c.port,
      access: c.access,
      ratePerMin: c.ratePerMin,
      hasPassword: c.hash !== null,
      passwordSetAt: c.passwordSetAt,
      baseUrl: `http://${c.access === 'lan' ? '0.0.0.0' : '127.0.0.1'}:${c.port}`,
    }
  }

  isEnabled(): boolean {
    const c = this.load()
    return c.enabled && c.hash !== null
  }

  port(): number {
    return this.load().port
  }

  access(): OpenAccessMode {
    return this.load().access
  }

  ratePerMin(): number {
    return this.load().ratePerMin
  }

  /**
   * 设置用户自定义调用密码（落库的是 salt + scrypt 派生值，明文不留痕）。
   * 传空串表示清除密码并关闭通道。
   */
  setPassword(secret: string): void {
    const c = this.load()
    const trimmed = secret.trim()
    if (trimmed === '') {
      this.save({ ...c, salt: null, hash: null, passwordSetAt: null, enabled: false })
      return
    }
    if (trimmed.length < 8) throw new Error('调用密码至少 8 位，对外暴露的通道不能用弱口令')
    const salt = randomBytes(16).toString('hex')
    this.save({ ...c, salt, hash: derive(trimmed, salt), passwordSetAt: Date.now() })
  }

  /** 随机生成调用密码，只在返回时出现一次（11 号文档 §1.1） */
  generatePassword(): string {
    const secret = randomBytes(SECRET_BYTES).toString('hex')
    const c = this.load()
    const salt = randomBytes(16).toString('hex')
    this.save({ ...c, salt, hash: derive(secret, salt), passwordSetAt: Date.now() })
    return secret
  }

  /** 密码校验走常量时间比较；未设置密码时一律拒绝 */
  verify(secret: string | null | undefined): boolean {
    const c = this.load()
    if (!c.hash || !c.salt || !secret) return false
    const expected = Buffer.from(c.hash, 'hex')
    const actual = Buffer.from(derive(secret, c.salt), 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /** 节点信道握手要下发的盐（不是秘密，只是 KDF 上下文，24 号文档 §2.1） */
  saltHex(): string | null {
    return this.load().salt
  }

  /**
   * 节点信道的预共享密钥 = 口令的 scrypt 派生值本身。
   * 对端用「口令 + 同一个盐」算出同一把钥匙，因此服务端不需要知道口令明文。
   */
  nodeKey(): Buffer | null {
    const hash = this.load().hash
    return hash === null ? null : Buffer.from(hash, 'hex')
  }

  setEnabled(enabled: boolean): void {
    const c = this.load()
    if (enabled && c.hash === null) return
    this.save({ ...c, enabled })
  }

  setPort(port: number): void {
    this.save({
      ...this.load(),
      port: Math.min(Math.max(Math.round(port) || DEFAULT_PORT, 1024), 65535),
    })
  }

  /** 局域网暴露必须显式二次确认；任何降级都回落到 loopback */
  setAccess(access: OpenAccessMode): void {
    this.save({ ...this.load(), access: access === 'lan' ? 'lan' : 'loopback' })
  }

  setRatePerMin(rate: number): void {
    this.save({ ...this.load(), ratePerMin: Math.min(Math.max(Math.round(rate) || 1, 1), 10000) })
  }

  clients(): OpenClientView[] {
    return this.load().clients.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      authorizedAt: c.authorizedAt,
      lastSeenAt: c.lastSeenAt,
    }))
  }

  /** 首次连接的客户端：未授权返回 null，由上层弹授权条（11 号文档 §2.3） */
  findClient(id: string): AuthorizedClient | null {
    return this.load().clients.find((c) => c.id === id) ?? null
  }

  authorizeClient(input: { id: string; name: string; kind: 'http' | 'mcp' }): AuthorizedClient {
    const c = this.load()
    const now = Date.now()
    const existing = c.clients.find((x) => x.id === input.id)
    const client: AuthorizedClient = existing
      ? {
          ...existing,
          name: input.name || existing.name,
          authorizedAt: existing.authorizedAt,
          lastSeenAt: now,
        }
      : {
          id: input.id,
          name: input.name || input.kind,
          kind: input.kind,
          authorizedAt: now,
          lastSeenAt: now,
        }
    const others = c.clients.filter((x) => x.id !== input.id)
    this.save({ ...c, clients: [client, ...others].slice(0, 50) })
    return client
  }

  touchClient(id: string): void {
    const c = this.load()
    let changed = false
    const clients = c.clients.map((x) => {
      if (x.id !== id) return x
      changed = true
      return { ...x, lastSeenAt: Date.now() }
    })
    if (changed) this.save({ ...c, clients })
  }

  revokeClient(id: string): void {
    const c = this.load()
    this.save({ ...c, clients: c.clients.filter((x) => x.id !== id) })
  }

  /** 测试与开发复位用：清掉整个配置 */
  reset(): void {
    this.cached = { ...DEFAULTS, clients: [] }
    this.settings.set(KEY, this.cached)
  }
}
