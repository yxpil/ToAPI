import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID：26 位 Crockford base32，48bit 毫秒时间 + 80bit 随机（04 号文档 §6） */
export function ulid(nowMs: number = Date.now()): string {
  let ms = BigInt(Math.max(0, Math.floor(nowMs)))
  const time: string[] = new Array<string>(10)
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[Number(ms & 31n)] as string
    ms >>= 5n
  }

  let rand = 0n
  for (const byte of randomBytes(10)) rand = (rand << 8n) | BigInt(byte)
  const suffix: string[] = new Array<string>(16)
  for (let i = 15; i >= 0; i--) {
    suffix[i] = ALPHABET[Number(rand & 31n)] as string
    rand >>= 5n
  }

  return time.join('') + suffix.join('')
}

export const isUlid = (s: string): boolean => /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(s)
