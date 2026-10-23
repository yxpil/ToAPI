/** pm.expect 的 chai 链式子集（23 号文档 §4.3） */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

interface Flags {
  negate: boolean
  deep: boolean
}

export interface Chai {
  to: Chai
  be: Chai
  been: Chai
  is: Chai
  that: Chai
  which: Chai
  and: Chai
  has: Chai
  have: Chai
  with: Chai
  at: Chai
  of: Chai
  same: Chai
  not: Chai
  deep: Chai
  true: void
  false: void
  null: void
  undefined: void
  ok: void
  exist: void
  empty: void
  equal(value: unknown): Chai
  equals(value: unknown): Chai
  eq(value: unknown): Chai
  eql(value: unknown): Chai
  a(type: string | (new (...args: never[]) => unknown)): Chai
  an(type: string | (new (...args: never[]) => unknown)): Chai
  include(value: unknown): Chai
  includes(value: unknown): Chai
  contain(value: unknown): Chai
  contains(value: unknown): Chai
  property(name: string, value?: unknown): Chai
  lengthOf(length: number): Chai
  length(length: number): Chai
  match(pattern: RegExp | string): Chai
  above(limit: number): Chai
  gt(limit: number): Chai
  greaterThan(limit: number): Chai
  below(limit: number): Chai
  lt(limit: number): Chai
  lessThan(limit: number): Chai
  least(limit: number): Chai
  gte(limit: number): Chai
  most(limit: number): Chai
  lte(limit: number): Chai
  oneOf(list: readonly unknown[]): Chai
  instanceOf(ctor: new (...args: never[]) => unknown): Chai
  /** toapi.expect 的 Jest 风格别名，与 pm.expect 共用同一实现 */
  toBe(value: unknown): Chai
  toEqual(value: unknown): Chai
  toContain(value: unknown): Chai
  toMatch(pattern: RegExp | string): Chai
  toBeLessThan(limit: number): Chai
  toBeGreaterThan(limit: number): Chai
  toBeDefined(): Chai
  toBeNull(): Chai
}

const show = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (!isObject(a) || !isObject(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  )
}

const typeOf = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (value instanceof RegExp) return 'regexp'
  return typeof value
}

const includes = (actual: unknown, needle: unknown, deep: boolean): boolean => {
  if (typeof actual === 'string') return actual.includes(String(needle))
  if (Array.isArray(actual))
    return actual.some((v) => (deep ? deepEqual(v, needle) : Object.is(v, needle)))
  if (isObject(actual)) {
    if (typeof needle === 'string') return needle in actual
    if (isObject(needle))
      return Object.keys(needle).every(
        (key) =>
          key in actual &&
          (deep ? deepEqual(actual[key], needle[key]) : Object.is(actual[key], needle[key])),
      )
  }
  return false
}

const isEmpty = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0
  if (value instanceof Map || value instanceof Set) return value.size === 0
  if (isObject(value)) return Object.keys(value).length === 0
  return false
}

export const makeExpect = (
  actual: unknown,
  flags: Flags = { negate: false, deep: false },
): Chai => {
  const check = (condition: boolean, message: string, negatedMessage: string): void => {
    if (flags.negate ? condition : !condition)
      throw new AssertionError(flags.negate ? negatedMessage : message)
  }

  const same = (expected: unknown): boolean =>
    flags.deep ? deepEqual(actual, expected) : Object.is(actual, expected)

  const api = {
    equal(value: unknown): void {
      check(same(value), `期望 ${show(value)}，实际 ${show(actual)}`, `不应等于 ${show(value)}`)
    },
    eql(value: unknown): void {
      check(
        deepEqual(actual, value),
        `期望 ${show(value)}，实际 ${show(actual)}`,
        `不应深度等于 ${show(value)}`,
      )
    },
    a(type: string | (new (...args: never[]) => unknown)): void {
      const ok =
        typeof type === 'string'
          ? typeOf(actual) === type
          : typeof type === 'function' && actual instanceof type
      check(ok, `期望类型 ${String(type)}，实际 ${typeOf(actual)}`, `不应为类型 ${String(type)}`)
    },
    include(value: unknown): void {
      check(
        includes(actual, value, flags.deep),
        `${show(actual)} 不包含 ${show(value)}`,
        `${show(actual)} 不应包含 ${show(value)}`,
      )
    },
    property(name: string, value?: unknown): void {
      const exists = isObject(actual) && name in actual
      const ok =
        exists &&
        (arguments.length < 2 ||
          (flags.deep
            ? deepEqual((actual as Record<string, unknown>)[name], value)
            : Object.is((actual as Record<string, unknown>)[name], value)))
      check(
        ok,
        `缺少属性 ${name}${arguments.length < 2 ? '' : `=${show(value)}`}`,
        `不应包含属性 ${name}`,
      )
    },
    lengthOf(length: number): void {
      const size =
        typeof actual === 'string' || Array.isArray(actual)
          ? actual.length
          : actual instanceof Map || actual instanceof Set
            ? actual.size
            : undefined
      check(size === length, `期望长度 ${length}，实际 ${String(size)}`, `长度不应为 ${length}`)
    },
    match(pattern: RegExp | string): void {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
      check(
        re.test(String(actual)),
        `${show(actual)} 不匹配 ${re}`,
        `${show(actual)} 不应匹配 ${re}`,
      )
    },
    above(limit: number): void {
      check(
        typeof actual === 'number' && actual > limit,
        `期望 > ${limit}，实际 ${show(actual)}`,
        `不应 > ${limit}`,
      )
    },
    below(limit: number): void {
      check(
        typeof actual === 'number' && actual < limit,
        `期望 < ${limit}，实际 ${show(actual)}`,
        `不应 < ${limit}`,
      )
    },
    least(limit: number): void {
      check(
        typeof actual === 'number' && actual >= limit,
        `期望 >= ${limit}，实际 ${show(actual)}`,
        `不应 >= ${limit}`,
      )
    },
    most(limit: number): void {
      check(
        typeof actual === 'number' && actual <= limit,
        `期望 <= ${limit}，实际 ${show(actual)}`,
        `不应 <= ${limit}`,
      )
    },
    oneOf(list: readonly unknown[]): void {
      check(
        list.some((v) => (flags.deep ? deepEqual(actual, v) : Object.is(actual, v))),
        `${show(actual)} 不在候选列表`,
        `${show(actual)} 不应在候选列表`,
      )
    },
    instanceOf(ctor: new (...args: never[]) => unknown): void {
      check(
        isObject(actual) && actual instanceof ctor,
        `不是 ${ctor.name} 的实例`,
        `不应是 ${ctor.name} 的实例`,
      )
    },
    toBe(value: unknown): void {
      check(
        Object.is(actual, value),
        `期望 ${show(value)}，实际 ${show(actual)}`,
        `不应等于 ${show(value)}`,
      )
    },
    toEqual(value: unknown): void {
      check(
        deepEqual(actual, value),
        `期望 ${show(value)}，实际 ${show(actual)}`,
        `不应深度等于 ${show(value)}`,
      )
    },
    toContain(value: unknown): void {
      check(
        includes(actual, value, false),
        `${show(actual)} 不包含 ${show(value)}`,
        `${show(actual)} 不应包含 ${show(value)}`,
      )
    },
    toMatch(pattern: RegExp | string): void {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
      check(
        re.test(String(actual)),
        `${show(actual)} 不匹配 ${re}`,
        `${show(actual)} 不应匹配 ${re}`,
      )
    },
    toBeLessThan(limit: number): void {
      check(
        typeof actual === 'number' && actual < limit,
        `期望 < ${limit}，实际 ${show(actual)}`,
        `不应 < ${limit}`,
      )
    },
    toBeGreaterThan(limit: number): void {
      check(
        typeof actual === 'number' && actual > limit,
        `期望 > ${limit}，实际 ${show(actual)}`,
        `不应 > ${limit}`,
      )
    },
    toBeDefined(): void {
      check(actual !== undefined, '值未定义', '值不应为已定义')
    },
    toBeNull(): void {
      check(actual === null, `期望 null，实际 ${show(actual)}`, '不应为 null')
    },
  } as Record<string, unknown>

  // 断言方法返回链对象，支持 .to.be.above(4).and.below(6) 这类写法
  for (const name of [
    'equal',
    'eql',
    'a',
    'include',
    'property',
    'lengthOf',
    'match',
    'above',
    'below',
    'least',
    'most',
    'oneOf',
    'instanceOf',
    'toBe',
    'toEqual',
    'toContain',
    'toMatch',
    'toBeLessThan',
    'toBeGreaterThan',
    'toBeDefined',
    'toBeNull',
  ]) {
    const fn = api[name] as (...args: unknown[]) => void
    api[name] = (...args: unknown[]) => {
      fn(...args)
      return api as unknown as Chai
    }
  }

  api['equals'] = api['equal']
  api['eq'] = api['equal']
  api['includes'] = api['include']
  api['contain'] = api['include']
  api['contains'] = api['include']
  api['an'] = api['a']
  api['length'] = api['lengthOf']
  api['gt'] = api['above']
  api['greaterThan'] = api['above']
  api['lt'] = api['below']
  api['lessThan'] = api['below']
  api['gte'] = api['least']
  api['lte'] = api['most']

  const chain = (next: Flags): Chai => makeExpect(actual, next)
  const self = () => chain(flags)
  for (const name of [
    'to',
    'be',
    'been',
    'is',
    'that',
    'which',
    'and',
    'has',
    'have',
    'with',
    'at',
    'of',
    'same',
  ])
    Object.defineProperty(api, name, { get: self })
  Object.defineProperty(api, 'not', { get: () => chain({ ...flags, negate: !flags.negate }) })
  Object.defineProperty(api, 'deep', { get: () => chain({ ...flags, deep: true }) })

  const assertion = (name: string, condition: boolean, message: string, negatedMessage: string) => {
    Object.defineProperty(api, name, {
      get: () => check(condition, message, negatedMessage),
    })
  }
  assertion('true', actual === true, `期望 true，实际 ${show(actual)}`, '不应为 true')
  assertion('false', actual === false, `期望 false，实际 ${show(actual)}`, '不应为 false')
  assertion('null', actual === null, `期望 null，实际 ${show(actual)}`, '不应为 null')
  assertion(
    'undefined',
    actual === undefined,
    `期望 undefined，实际 ${show(actual)}`,
    '不应为 undefined',
  )
  assertion('ok', Boolean(actual), `期望真值，实际 ${show(actual)}`, '期望假值')
  assertion('exist', actual !== null && actual !== undefined, '值不存在', '值应不存在')
  assertion('empty', isEmpty(actual), `期望空值，实际 ${show(actual)}`, '期望非空值')

  return api as unknown as Chai
}

export const expect = (actual: unknown): Chai => makeExpect(actual)
