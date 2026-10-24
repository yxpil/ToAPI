// @author yxpil
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/**
 * `toapi-node/1` 信道（24 号文档 §2）：配对口令就是预共享密钥，
 * 用与开放通道完全相同的 scrypt 参数派生 32 字节信道密钥，再用 HKDF 分成
 * 加密子密钥与指纹，消息走 AES-256-GCM 并把方向/序号/两端身份绑进 AAD。
 *
 * 不引入证书与第三方依赖；代价是安全性等同口令强度 —— 界面必须推荐用「生成」的随机口令。
 */

export const NODE_PROTOCOL = 1
const KDF_CONTEXT = 'toapi-node-v1'
/** 与 electron/open/config.ts 的 derive() 保持一致，否则两端算不出同一把密钥 */
const derive = (secret: string, saltHex: string): Buffer =>
  scryptSync(secret, Buffer.from(saltHex, 'hex'), 32)

const hkdf = (key: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(`${KDF_CONTEXT}:${info}`), 32))

/** 口令 + 对端 salt → 信道密钥；口令错就算不出正确密钥，解密自然失败 */
export const deriveChannelKey = (password: string, saltHex: string): Buffer =>
  derive(password.trim(), saltHex)

export const keyToHex = (key: Buffer): string => key.toString('hex')
export const keyFromHex = (hex: string): Buffer => Buffer.from(hex, 'hex')

/** 8 组 2 位十六进制的可读指纹，两屏人工核对（防拿到口令的中间人冒充） */
export const fingerprintOf = (key: Buffer): string => {
  const raw = hkdf(key, 'fingerprint').subarray(0, 8).toString('hex')
  return (raw.match(/.{2}/g) ?? []).join(':')
}

export const sameKey = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b)

export interface Sealed {
  /** base64 的 12 字节 IV */
  iv: string
  /** base64 密文（含 GCM tag） */
  ct: string
  seq: number
}

const aadOf = (dir: 'req' | 'res', seq: number, path: string): Buffer =>
  Buffer.from(`${KDF_CONTEXT}|${dir}|${String(seq)}|${path}`, 'utf8')

/** 发送方身份放在密文里，AAD 只绑方向/序号/路径，避免先解密才知道是谁 */
export function seal(
  key: Buffer,
  dir: 'req' | 'res',
  seq: number,
  path: string,
  payload: unknown,
): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', hkdf(key, dir), iv)
  cipher.setAAD(aadOf(dir, seq, path))
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), seq }
}

export function unseal<T>(key: Buffer, dir: 'req' | 'res', frame: Sealed, path: string): T {
  const raw = Buffer.from(frame.ct, 'base64')
  if (raw.byteLength < 16) throw new Error('节点信道帧长度不合法')
  const tag = raw.subarray(raw.byteLength - 16)
  const body = raw.subarray(0, raw.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', hkdf(key, dir), Buffer.from(frame.iv, 'base64'))
  decipher.setAAD(aadOf(dir, frame.seq, path))
  decipher.setAuthTag(tag)
  const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  return JSON.parse(text) as T
}

/** 序号必须严格递增：抓包重放的帧会被拒（24 号文档 §2.2） */
export class ReplayGuard {
  private readonly last = new Map<string, number>()

  check(peer: string, seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) return false
    const prev = this.last.get(peer)
    if (prev !== undefined && seq <= prev) return false
    this.last.set(peer, seq)
    return true
  }

  reset(peer?: string): void {
    if (peer) this.last.delete(peer)
    else this.last.clear()
  }
}

/** 弱口令提示：信道强度就是口令强度，不能假装没问题 */
export const passwordStrengthWarning = (password: string): string | null => {
  const value = password.trim()
  if (value.length < 12)
    return '口令少于 12 位：信道加密强度等于口令强度，建议改用「生成」的随机口令'
  if (/^[a-z]+$/i.test(value)) return '口令是纯字母：容易被猜出，建议改用「生成」的随机口令'
  return null
}
