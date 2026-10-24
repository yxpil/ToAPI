// @author yxpil
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DYNAMIC_VAR_NAMES, dynamicVar } from '@main/postman/dynamic-vars'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const docPath = resolve(repoRoot, 'docs/23-Postman兼容规范.md')

const documented = (): string[] => {
  const text = readFileSync(docPath, 'utf8')
  const start = text.indexOf('### 4.5 动态变量')
  const end = text.indexOf('\n## 5.', start)
  const section = text.slice(start, end)
  const names = new Set<string>()
  for (const m of section.matchAll(/\$[A-Za-z0-9]+/g)) {
    const name = m[0]
    // 文档用 {{$name}} 作为语法占位示例，不是变量键
    if (name !== '$name') names.add(name)
  }
  return [...names].sort()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('动态变量注册表（23 号文档 §4.5）', () => {
  it('文档清单与实现键集合完全一致', () => {
    expect(documented()).toEqual([...DYNAMIC_VAR_NAMES])
  })

  it('每个键都能生成非空字符串，且不残留占位语法', () => {
    for (const name of DYNAMIC_VAR_NAMES) {
      const value = dynamicVar(name)
      expect(typeof value, name).toBe('string')
      expect(value, name).not.toBe('')
      expect(value, name).not.toContain('{{')
    }
  })

  it('未知键返回 undefined，保留原文由求值器负责', () => {
    expect(dynamicVar('$notARealVariable')).toBeUndefined()
    expect(dynamicVar('plainName')).toBeUndefined()
  })

  it('标识与时间类符合官方语义', () => {
    expect(dynamicVar('$guid')).toMatch(UUID)
    expect(dynamicVar('$randomUUID')).toMatch(UUID)
    expect(dynamicVar('$timestamp')).toMatch(/^\d{10}$/)
    expect(Math.abs(Number(dynamicVar('$timestamp')) - Date.now() / 1000)).toBeLessThan(5)
    expect(Number.isNaN(Date.parse(String(dynamicVar('$isoTimestamp'))))).toBe(false)
    expect(dynamicVar('$randomBoolean')).toMatch(/^(true|false)$/)
    const n = Number(dynamicVar('$randomInt'))
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThanOrEqual(1000)
    expect(dynamicVar('$randomSemver')).toMatch(/^\d+\.\d+\.\d+$/)
    expect(dynamicVar('$randomAlphaNumeric')).toMatch(/^[a-z0-9]$/)
  })

  it('网络、地址与金融类保持格式', () => {
    expect(dynamicVar('$randomIP')).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/)
    expect(dynamicVar('$randomIPV6')).toMatch(/^([0-9A-F]{4}:){7}[0-9A-F]{4}$/)
    expect(dynamicVar('$randomMACAddress')).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/)
    expect(dynamicVar('$randomProtocol')).toMatch(/^https?$/)
    expect(dynamicVar('$randomEmail')).toMatch(/^[^@\s]+@[^@\s]+$/)
    expect(dynamicVar('$randomUrl')).toMatch(/^https:\/\//)
    expect(dynamicVar('$randomAvatarImage')).toMatch(/^https:\/\//)
    expect(dynamicVar('$randomHexColor')).toMatch(/^#[0-9a-f]{6}$/)
    expect(dynamicVar('$randomCreditCardMask')).toMatch(/^\*{4}\d{4}$/)
    expect(dynamicVar('$randomBankAccountIban')).toMatch(/^IBAN\d{16}$/)
    expect(Number(dynamicVar('$randomLatitude'))).toBeGreaterThanOrEqual(-90)
    expect(Number(dynamicVar('$randomLatitude'))).toBeLessThanOrEqual(90)
    expect(Number(dynamicVar('$randomLongitude'))).toBeGreaterThanOrEqual(-180)
    expect(Number(dynamicVar('$randomLongitude'))).toBeLessThanOrEqual(180)
    expect(Number(dynamicVar('$randomPrice'))).toBeGreaterThanOrEqual(0)
    expect(dynamicVar('$randomMimeType')).toContain('/')
  })

  it('同一键连续取值独立求值（23 号文档 §4.5）', () => {
    const ids = new Set(Array.from({ length: 20 }, () => dynamicVar('$randomUUID')))
    expect(ids.size).toBe(20)
  })
})
