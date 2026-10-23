export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: unknown): void
  info(msg: string, ctx?: unknown): void
  warn(msg: string, ctx?: unknown): void
  error(msg: string, ctx?: unknown): void
}

// secret 值由调用方在写入前替换为 ***（20 号文档 §5），此处兜底扫描常见凭证形态
const REDACT_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer\s+)?([^\s,"']{8,})/gi,
  /(api[_-]?key|token|secret|password)("?\s*[:=]\s*"?)([^\s,"'"]{6,})/gi,
]

export function redact(text: string): string {
  return REDACT_PATTERNS.reduce(
    (acc, re) => acc.replace(re, (_m, p1: string, p2: string) => `${p1}${p2 ?? ''}***`),
    text,
  )
}

export function createLogger(scope: string, minLevel: LogLevel = 'info'): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  const sink: Record<LogLevel, (msg: string) => void> = {
    debug: (m) => console.info(m),
    info: (m) => console.info(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  }
  const emit = (level: LogLevel, msg: string, ctx?: unknown): void => {
    if (order[level] < order[minLevel]) return
    const line = `[${scope}] ${msg}${ctx === undefined ? '' : ` ${redact(JSON.stringify(ctx))}`}`
    sink[level](redact(line))
  }
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  }
}
