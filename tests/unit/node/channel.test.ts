// @author yxpil
import { describe, expect, it } from 'vitest'
import {
  NODE_PROTOCOL,
  ReplayGuard,
  deriveChannelKey,
  fingerprintOf,
  passwordStrengthWarning,
  seal,
  unseal,
} from '@main/node/channel'

/** 节点信道（24 号文档 §2）：口令派生、方向/路径绑定的 AES-256-GCM 与防重放 */

const SALT = 'a1b2c3d4e5f60718'
const PASSWORD = 'f3a9c1e7b2084d5a6cf19e3b7d2a04c8'

const key = (password = PASSWORD, salt = SALT): Buffer => deriveChannelKey(password, salt)

describe('信道密钥与指纹', () => {
  it('口令与盐相同才算得出同一把钥匙', () => {
    expect(key().equals(key())).toBe(true)
    expect(key(`${PASSWORD}x`).equals(key())).toBe(false)
    expect(key(PASSWORD, `${SALT}ff`).equals(key())).toBe(false)
  })

  it('口令两端有空白也不影响派生，界面上不必要求精确复制', () => {
    expect(key(`  ${PASSWORD}  `).equals(key())).toBe(true)
  })

  it('指纹是 8 组两位十六进制，同一把钥匙恒定', () => {
    const fp = fingerprintOf(key())
    expect(fp).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/)
    expect(fingerprintOf(key())).toBe(fp)
    expect(fingerprintOf(key(`${PASSWORD}x`))).not.toBe(fp)
  })

  it('协议版本固定为 1，跨版本由上层显式拒绝', () => {
    expect(NODE_PROTOCOL).toBe(1)
  })
})

describe('AES-256-GCM 帧', () => {
  it('同方向同序号能解开，内容原样往返', () => {
    const frame = seal(key(), 'req', 1, '/v1/node/state', { from: 'dev-a', projectId: '01ABC' })
    const opened = unseal<{ from: string; projectId: string }>(
      key(),
      'req',
      frame,
      '/v1/node/state',
    )
    expect(opened).toEqual({ from: 'dev-a', projectId: '01ABC' })
  })

  it('换口令、换方向、换路径都解不开', () => {
    const frame = seal(key(), 'req', 4, '/v1/node/pull', { ok: true })
    expect(() => unseal(key('other-password-12'), 'req', frame, '/v1/node/pull')).toThrow()
    expect(() => unseal(key(), 'res', frame, '/v1/node/pull')).toThrow()
    expect(() => unseal(key(), 'req', frame, '/v1/node/push')).toThrow()
  })

  it('密文被篡改会被 GCM 标签拦住', () => {
    const frame = seal(key(), 'req', 2, '/v1/node/state', { hi: 1 })
    const bytes = Buffer.from(frame.ct, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    expect(() =>
      unseal(key(), 'req', { ...frame, ct: bytes.toString('base64') }, '/v1/node/state'),
    ).toThrow()
  })

  it('帧里不含明文路径或业务字段', () => {
    const frame = seal(key(), 'req', 3, '/v1/node/pull', { projectId: 'SECRET-PROJECT' })
    const text = JSON.stringify(frame)
    expect(text).not.toContain('SECRET-PROJECT')
    expect(text).not.toContain('pull')
  })
})

describe('防重放（24 号文档 §2.2）', () => {
  it('序号必须严格递增，重复与回退都拒', () => {
    const guard = new ReplayGuard()
    expect(guard.check('dev-a|req', 1)).toBe(true)
    expect(guard.check('dev-a|req', 2)).toBe(true)
    expect(guard.check('dev-a|req', 2)).toBe(false)
    expect(guard.check('dev-a|req', 1)).toBe(false)
  })

  it('不同设备各算一条序号链，互不影响', () => {
    const guard = new ReplayGuard()
    expect(guard.check('dev-a|req', 9)).toBe(true)
    expect(guard.check('dev-b|req', 1)).toBe(true)
    expect(guard.check('dev-a|req', 1)).toBe(false)
  })

  it('非整数与负数一律拒', () => {
    const guard = new ReplayGuard()
    expect(guard.check('dev-a|req', -3)).toBe(false)
    expect(guard.check('dev-a|req', 1.5)).toBe(false)
    expect(guard.check('dev-a|req', Number.NaN)).toBe(false)
  })

  it('reset 后允许重新计数（口令变更后不残留旧序号）', () => {
    const guard = new ReplayGuard()
    guard.check('dev-a|req', 5)
    guard.reset('dev-a|req')
    expect(guard.check('dev-a|req', 1)).toBe(true)
  })
})

describe('弱口令提示（24 号文档 §2.2）', () => {
  it('短口令与纯字母都点名风险', () => {
    expect(passwordStrengthWarning('abc123')).toContain('少于 12 位')
    expect(passwordStrengthWarning('passwordisweak')).toContain('纯字母')
  })

  it('随机十六进制口令不给警告', () => {
    expect(passwordStrengthWarning(PASSWORD)).toBeNull()
  })
})
