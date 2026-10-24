// @author yxpil
import type { Api, Collection, KvRow } from '@shared/types'
import type { Repos } from '../db/repo'

/** AI Skill 说明书生成（11 号文档 §3）：给没有 MCP 的 AI 也能照着调用 */

export interface SkillFile {
  path: string
  content: string
}

export interface SkillOptions {
  /** 附带的接口示例数量上限，避免 SKILL.md 长到不可读 */
  exampleApis?: number
  environmentName?: string
  /** frontmatter description 的补充语境 */
  notes?: string
}

const rows = (list: KvRow[]): KvRow[] => list.filter((r) => r.enabled && r.key)

const slug = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'api'

const quoted = (value: string): string => JSON.stringify(value)

/** 单接口示例代码：只出 cURL / JS fetch / Python requests，与 09 号文档的多语言 codegen 不是一回事 */
const examples = (api: Api, baseUrl: string): SkillFile[] => {
  const headers = rows(api.headers)
  const name = slug(api.name)
  const url = api.url || baseUrl
  const body = api.body && api.bodyType !== 'none' ? api.body : ''

  const curl = [
    `curl -X ${api.method} ${quoted(url)} \\`,
    ...headers.map((h) => `  -H ${quoted(`${h.key}: ${h.value}`)} \\`),
    ...(body ? [`  --data-raw ${quoted(body)}`] : [`  -sS`]),
    '',
  ].join('\n')

  const js = [
    `const res = await fetch(${quoted(url)}, {`,
    `  method: ${quoted(api.method)},`,
    '  headers: {',
    ...headers.map((h) => `    ${quoted(h.key)}: ${quoted(h.value)},`),
    '  },',
    ...(body ? [`  body: ${quoted(body)},`] : []),
    '})',
    'console.log(res.status, await res.text())',
    '',
  ].join('\n')

  const py = [
    'import requests',
    '',
    `res = requests.request(${quoted(api.method)}, ${quoted(url)},`,
    '    headers={',
    ...headers.map((h) => `        ${quoted(h.key)}: ${quoted(h.value)},`),
    '    },',
    ...(body ? [`    data=${quoted(body)},`] : []),
    '    timeout=30)',
    'print(res.status_code, res.text)',
    '',
  ].join('\n')

  return [
    { path: `examples/${name}.sh`, content: `#!/usr/bin/env bash\nset -euo pipefail\n${curl}` },
    { path: `examples/${name}.js`, content: js },
    { path: `examples/${name}.py`, content: py },
  ]
}

const flatten = (collections: Collection[], apis: Map<string, Api[]>) => {
  const out: { collection: Collection; apis: Api[] }[] = []
  for (const c of collections) out.push({ collection: c, apis: apis.get(c.id) ?? [] })
  return out
}

export const buildSkillFiles = (
  repos: Repos,
  projectId: string,
  opts: SkillOptions = {},
): SkillFile[] => {
  const project = repos.project.get(projectId)
  if (!project) throw new Error('项目不存在')
  const collections = repos.collection.listByProject(projectId)
  const apisByCollection = new Map<string, Api[]>()
  for (const c of collections) apisByCollection.set(c.id, repos.api.listByCollection(c.id))

  const env = opts.environmentName
    ? repos.environment.listByProject(projectId).find((e) => e.name === opts.environmentName)
    : (repos.environment.activeFor(projectId) ?? repos.environment.listByProject(projectId)[0])
  const envVars = env ? repos.variable.listForEnv(env.id) : []
  const baseUrl = envVars.find((v) => v.key === 'baseUrl')?.value ?? '{{baseUrl}}'
  const secretNames = [
    ...project.variables.filter((v) => v.secret),
    ...collections.flatMap((c) => c.variables.filter((v) => v.secret)),
    ...envVars.filter((v) => v.secret),
    ...repos.variable.listGlobals().filter((v) => v.secret),
  ].map((v) => v.key)

  // 提取器链是"调用顺序"的唯一客观依据：被下游 {{var}} 引用的先跑
  const producers: { name: string; api: string }[] = []
  for (const c of collections) {
    for (const api of apisByCollection.get(c.id) ?? []) {
      for (const e of api.extractors) producers.push({ name: e.name, api: api.name })
    }
  }
  const ordered = flatten(collections, apisByCollection).flatMap((x) => x.apis)
  const chain = ordered
    .filter((api) => producers.some((p) => p.api === api.name))
    .map((api) => api.name)

  const description = [
    `${project.name}${env ? ` ${env.name}` : ''} 环境接口调用技能。`,
    opts.notes?.trim() ||
      `当需要查询或回归「${collections.map((c) => c.name).join('、')}」相关接口时使用。`,
  ].join('')

  const lines: string[] = [
    '---',
    `name: ${slug(project.name)}-api`,
    `description: ${description}`,
    '---',
    '',
    `# ${project.name} API 技能`,
    '',
    '## 何时用',
    '',
    `- 需要${project.description || `调 ${project.name} 的接口`}时。`,
    '- 目标 AI 若接了 ToAPI 的 MCP / Local HTTP API，可直接调用同名工具；没接就照本文档手工发请求。',
    '',
    '## 环境',
    '',
    env ? `- baseUrl: ${baseUrl}` : '- baseUrl: 由接口提供方给出（文件里未含活动环境）',
    ...(envVars.length > 0
      ? [
          `- 变量: ${envVars.map((v) => `${v.key}${v.secret ? '（需索取）' : `=${v.value}`}`).join('  ')}`,
        ]
      : []),
    ...(secretNames.length > 0
      ? [
          `- 敏感变量只列名字、绝不带值：${[...new Set(secretNames)].join('、')} —— 向接口提供方索取`,
        ]
      : []),
    '',
    '## 调用顺序（链式约束）',
    '',
    ...(chain.length > 0
      ? chain.map((name, i) => `${String(i + 1)}. 先调「${name}」，它写出的变量是后续请求的前提`)
      : ['（本项目未声明提取器链，接口可独立调用）']),
    '',
    '## 接口清单',
    '',
  ]

  for (const { collection, apis } of flatten(collections, apisByCollection)) {
    if (apis.length === 0) continue
    lines.push(`### 集合：${collection.name}`)
    if (collection.preScript.trim() !== '' || collection.postScript.trim() !== '')
      lines.push('- 集合级脚本会在接口前后执行（前置可改请求头，后置可写变量）。')
    if (rows(collection.variables as KvRow[]).length > 0)
      lines.push(
        `- 集合变量: ${collection.variables
          .filter((v) => v.enabled)
          .map((v) => v.key)
          .join('  ')}`,
      )
    for (const api of apis) {
      lines.push(
        '',
        `#### ${api.name} — ${api.method} ${api.url}`,
        api.description ? api.description : '',
        rows(api.headers).length > 0
          ? `- Header: ${rows(api.headers)
              .map((h) => `${h.key}: ${h.value}`)
              .join(' ｜ ')}`
          : '- Header: 无自定义',
        api.body && api.bodyType !== 'none'
          ? `- 请求体 (${api.bodyType}): ${api.body}`
          : '- 请求体: 无',
        api.auth.type !== 'inherit' && api.auth.type !== 'none'
          ? `- 鉴权: ${api.auth.type}（凭据由环境变量提供，不在文档里）`
          : '- 鉴权: 沿用集合/项目配置',
        api.extractors.length > 0
          ? `- 提取: ${api.extractors.map((e) => `${e.name} ← ${e.expr}`).join('；')}`
          : '',
        api.postScript.trim() !== '' ? '- 该接口带断言脚本，手工调用时请对照下方「验证方式」' : '',
      )
    }
    lines.push('')
  }

  const sampleApis = ordered.slice(0, Math.max(1, opts.exampleApis ?? 3))
  const skillExamples = sampleApis.flatMap((api) => examples(api, baseUrl))

  lines.push('## 验证方式', '')
  for (const api of sampleApis) {
    lines.push(
      `- 「${api.name}」：期望 2xx；${api.extractors.length > 0 ? `回读 ${api.extractors.map((e) => e.name).join('、')}` : '响应体结构与请求体字段一致'}。`,
    )
  }
  lines.push(
    '',
    '## 可跑示例',
    '',
    ...skillExamples.map((f) => '- `' + f.path + '`'),
    '',
    '> 示例里的 URL/Header 直接来自接口定义；把 baseUrl 换成你自己的环境后即可运行。示例不含任何密钥。',
    '',
  )

  return [
    { path: 'SKILL.md', content: lines.filter((l) => l !== undefined).join('\n') },
    ...skillExamples,
  ]
}
