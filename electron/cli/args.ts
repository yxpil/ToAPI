// @author yxpil
export type ReporterKind = 'cli' | 'json' | 'junit' | 'html'

export interface CliOptions {
  command: 'run' | 'help' | 'version'
  file?: string
  db?: string
  project?: string
  collection?: string
  folder?: string
  env?: string
  globals?: string
  data?: string
  iterationCount?: number
  delayMs?: number
  timeoutMs?: number
  bail: boolean
  reporters: ReporterKind[]
  jsonExport?: string
  junitExport?: string
  htmlExport?: string
  quiet: boolean
}

/** 用法错误 → 退出码 2（23 号文档 §5.3） */
export class CliUsageError extends Error {}

const REPORTERS: ReporterKind[] = ['cli', 'json', 'junit', 'html']

export const USAGE = `ToAPI CLI — 本地无头运行集合（23 号文档 §5.3）

用法：
  toapi run <postman_collection.json | project.tapi> [选项]
  toapi run --db <toapi.db> --project <名称|ID> [选项]

选项：
  --db <path>                    直接打开已有的 ToAPI 数据库（与位置参数互斥）
  --project <name|id>            限定项目（--db 模式下用于选范围）
  --collection <name|id>         只跑指定集合
  --folder <name>                --collection 的别名，便于照搬 Newman 命令
  --env <file.json|name>         Postman Environment 文件，或库内环境名称
  --globals <file.json>          Postman Globals 导出（{values:[...]}）或普通对象
  --data <file.csv|file.json>    数据文件，每行一次迭代
  --iteration-count <n>          迭代次数；缺省等于数据行数（无数据文件时 1）
  --delay <ms>                   请求间隔
  --timeout <ms>                 覆盖每个请求的超时
  --bail                         首次失败即停止
  --reporters <list>             cli,json,junit,html（逗号分隔，默认 cli）
  --reporter-json-export <path>  JSON 报告输出路径（默认 toapi-report.json）
  --reporter-junit-export <path> JUnit 报告输出路径（默认 toapi-junit.xml）
  --reporter-html-export <path>  HTML 报告输出路径（默认 toapi-report.html）
  --quiet                        只输出汇总与错误
  -h, --help                     显示帮助
  -v, --version                  显示版本

退出码：0 全部通过（允许跳过） / 1 存在失败 / 2 用法或 IO 错误
`

const needValue = (flag: string, argv: string[], i: number): string => {
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--'))
    throw new CliUsageError(`${flag} 需要一个参数值`)
  return value
}

const needInt = (flag: string, raw: string): number => {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0)
    throw new CliUsageError(`${flag} 需要非负整数，收到 ${raw}`)
  return value
}

const needReporters = (raw: string): ReporterKind[] => {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const item of list)
    if (!REPORTERS.includes(item as ReporterKind))
      throw new CliUsageError(`未知 reporter：${item}（可选 ${REPORTERS.join(' / ')}）`)
  if (list.length === 0) throw new CliUsageError('--reporters 不能为空')
  return list as ReporterKind[]
}

export const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = { command: 'run', bail: false, reporters: ['cli'], quiet: false }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    switch (arg) {
      case '-h':
      case '--help':
        opts.command = 'help'
        break
      case '-v':
      case '--version':
        opts.command = 'version'
        break
      case '--bail':
        opts.bail = true
        break
      case '--quiet':
        opts.quiet = true
        break
      case '--db':
        opts.db = needValue(arg, argv, i)
        i += 1
        break
      case '--project':
        opts.project = needValue(arg, argv, i)
        i += 1
        break
      case '--collection':
      case '--folder':
        opts.collection = needValue(arg, argv, i)
        i += 1
        break
      case '--env':
        opts.env = needValue(arg, argv, i)
        i += 1
        break
      case '--globals':
        opts.globals = needValue(arg, argv, i)
        i += 1
        break
      case '--data':
        opts.data = needValue(arg, argv, i)
        i += 1
        break
      case '--iteration-count':
        opts.iterationCount = needInt(arg, needValue(arg, argv, i))
        i += 1
        break
      case '--delay':
        opts.delayMs = needInt(arg, needValue(arg, argv, i))
        i += 1
        break
      case '--timeout':
        opts.timeoutMs = needInt(arg, needValue(arg, argv, i))
        i += 1
        break
      case '--reporters':
        opts.reporters = needReporters(needValue(arg, argv, i))
        i += 1
        break
      case '--reporter-json-export':
        opts.jsonExport = needValue(arg, argv, i)
        i += 1
        break
      case '--reporter-junit-export':
        opts.junitExport = needValue(arg, argv, i)
        i += 1
        break
      case '--reporter-html-export':
        opts.htmlExport = needValue(arg, argv, i)
        i += 1
        break
      default:
        if (arg.startsWith('-')) throw new CliUsageError(`未知选项：${arg}`)
        positional.push(arg)
    }
  }

  if (opts.command !== 'run') return opts

  const [first, second] = positional
  if (first !== undefined && first !== 'run') throw new CliUsageError(`未知命令：${first}`)
  if (second !== undefined) opts.file = second
  if (opts.file && opts.db)
    throw new CliUsageError('位置参数（导入文件）与 --db 互斥：导入只会写入临时库')
  if (!opts.file && !opts.db)
    throw new CliUsageError('需要一个 Postman Collection 文件，或用 --db 打开已有数据库')
  if (opts.iterationCount !== undefined && opts.iterationCount < 1)
    throw new CliUsageError('--iteration-count 至少为 1')
  return opts
}
