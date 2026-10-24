// @author yxpil
import { describe, expect, it } from 'vitest'
import { isUlid, ulid } from '@main/infra/id'

describe('ulid', () => {
  it('长度 26 且字符集为 Crockford base32', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
  })

  it('时间前缀随时间递增（可排序）', () => {
    const early = ulid(1_700_000_000_000)
    const late = ulid(1_800_000_000_000)
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true)
    expect(early.localeCompare(late)).toBeLessThan(0)
  })

  it('同一毫秒也几乎不碰撞', () => {
    const set = new Set(Array.from({ length: 200 }, () => ulid(1_700_000_000_000)))
    expect(set.size).toBe(200)
  })

  it('拒绝非法字符与长度', () => {
    expect(isUlid('0000000000000000000000000I')).toBe(false)
    expect(isUlid('short')).toBe(false)
  })

  it('负时间戳被夹为 0 而不抛异常', () => {
    expect(ulid(-5)).toHaveLength(26)
  })
})
