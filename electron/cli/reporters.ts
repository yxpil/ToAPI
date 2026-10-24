import type { RunnerItem, RunnerRun } from '../db/repo/runner.repo'

/** CLI 与报告渲染（23 号文档 §5.3）：纯函数，便于单测；文本一律 ASCII 标记，不用 emoji */

const STATUS_LABEL: Record<RunnerItem['status'], string> = {
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
  error: '错误',
}

const assertionText = (item: RunnerItem): string => {
  const total = item.assertions.length
  if (total === 0) return '无断言'
  return `断言 ${item.assertions.filter((a) => a.pass).length}/${total}`
}

export const itemLine = (item: RunnerItem, iterationCount: number): string => {
  const round = iterationCount > 1 ? `第 ${item.iteration}/${iterationCount} 轮 · ` : ''
  const time = `${Math.round(item.timeMs)}ms`
  return `${round}${STATUS_LABEL[item.status]} · ${item.apiName} · ${time} · ${assertionText(item)}`
}

export const itemDetail = (item: RunnerItem): string[] => {
  const lines: string[] = []
  for (const a of item.assertions) {
    if (a.pass) continue
    lines.push(`    断言失败：${a.name}${a.error ? ` — ${a.error}` : ''}`)
  }
  if (item.error)
    lines.push(`    ${item.status === 'error' ? '请求错误' : '失败原因'}：${item.error}`)
  return lines
}

const passRate = (run: RunnerRun): string => {
  const judged = run.passed + run.failed
  if (judged === 0) return '—'
  return `${((run.passed / judged) * 100).toFixed(1)}%`
}

export const summaryLines = (run: RunnerRun): string[] => [
  '',
  `范围：${run.scopeName}（${run.scopeType}）`,
  `迭代：${run.iterationCount} 轮 · 计划 ${run.total} 项`,
  `结果：${run.passed} 通过 / ${run.failed} 失败 / ${run.skipped} 跳过 · 通过率 ${passRate(run)}`,
  `耗时：${run.finishedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(2) : '—'}s`,
]

export const renderJson = (run: RunnerRun): string =>
  `${JSON.stringify(
    {
      run: {
        id: run.id,
        scope: { type: run.scopeType, id: run.scopeId, name: run.scopeName },
        environmentId: run.envId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        iterationCount: run.iterationCount,
        stats: {
          total: run.total,
          passed: run.passed,
          failed: run.failed,
          skipped: run.skipped,
          passRate: passRate(run),
        },
        executions: run.items.map((item) => ({
          iteration: item.iteration,
          apiId: item.apiId,
          name: item.apiName,
          status: item.status,
          timeMs: item.timeMs,
          historyId: item.historyId,
          error: item.error,
          assertions: item.assertions,
          logs: item.logs,
        })),
      },
    },
    null,
    2,
  )}\n`

const esc = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const renderJunit = (run: RunnerRun): string => {
  const seconds = (ms: number): string => (ms / 1000).toFixed(3)
  const total = run.items.length
  const failures = run.items.filter((i) => i.status === 'failed').length
  const errors = run.items.filter((i) => i.status === 'error').length
  const skipped = run.items.filter((i) => i.status === 'skipped').length
  const time = run.finishedAt ? seconds(run.finishedAt - run.startedAt) : '0.000'

  const cases = run.items
    .map((item) => {
      const name =
        run.iterationCount > 1
          ? `[${item.iteration}/${run.iterationCount}] ${item.apiName}`
          : item.apiName
      const inner: string[] = []
      for (const a of item.assertions) {
        if (a.pass) continue
        inner.push(
          `      <failure message="${esc(a.name)}" type="AssertionError">${esc(a.error ?? '')}</failure>`,
        )
      }
      if (item.status === 'error')
        inner.push(`      <error message="${esc(item.error ?? '请求错误')}"></error>`)
      else if (item.status === 'skipped') inner.push('      <skipped/>')
      else if (item.status === 'failed' && inner.length === 0 && item.error)
        inner.push(`      <failure message="${esc(item.error)}"></failure>`)
      return `    <testcase name="${esc(name)}" classname="toapi.${esc(run.scopeName)}" time="${seconds(item.timeMs)}">${
        inner.length > 0 ? `\n${inner.join('\n')}\n    ` : ''
      }</testcase>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="ToAPI" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">
  <testsuite name="${esc(run.scopeName)}" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${new Date(run.startedAt).toISOString()}">
${cases}
  </testsuite>
</testsuites>
`
}

const htmlRow = (item: RunnerItem, iterationCount: number): string => {
  const failures = item.assertions.filter((a) => !a.pass)
  const detail = [
    ...failures.map((a) => `断言失败：${a.name}${a.error ? ` — ${a.error}` : ''}`),
    ...(item.error ? [item.error] : []),
  ]
  return `      <tr class="${item.status}">
        <td>${iterationCount > 1 ? item.iteration : '—'}</td>
        <td>${esc(item.apiName)}</td>
        <td>${STATUS_LABEL[item.status]}</td>
        <td class="num">${Math.round(item.timeMs)}</td>
        <td class="num">${item.assertions.filter((a) => a.pass).length}/${item.assertions.length}</td>
        <td class="detail">${esc(detail.join('；'))}</td>
      </tr>`
}

export const renderHtml = (run: RunnerRun): string => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>ToAPI 运行报告 · ${esc(run.scopeName)}</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; padding: 32px; background: #f2f2f4; color: #111; font: 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      main { max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #e3e3e6; border-radius: 14px; padding: 24px; }
      h1 { font-size: 16px; margin: 0 0 4px; }
      .meta { color: #6b6b70; margin-bottom: 20px; }
      .stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
      .stat { border: 1px solid #e3e3e6; border-radius: 999px; padding: 4px 12px; }
      .stat b { font-variant-numeric: tabular-nums; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0f0f2; vertical-align: top; }
      th { color: #6b6b70; font-weight: 500; }
      td.num { font-variant-numeric: tabular-nums; text-align: right; }
      td.detail { color: #6b6b70; max-width: 360px; }
      tr.failed td:nth-child(3), tr.error td:nth-child(3) { color: #b42318; }
      tr.skipped td:nth-child(3) { color: #6b6b70; }
    </style>
  </head>
  <body>
    <main>
      <h1>${esc(run.scopeName)}</h1>
      <div class="meta">${new Date(run.startedAt).toLocaleString('zh-CN')} · ${run.iterationCount} 轮迭代 · 耗时 ${
        run.finishedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(2) : '—'
      }s</div>
      <div class="stats">
        <span class="stat">计划 <b>${run.total}</b></span>
        <span class="stat">通过 <b>${run.passed}</b></span>
        <span class="stat">失败 <b>${run.failed}</b></span>
        <span class="stat">跳过 <b>${run.skipped}</b></span>
        <span class="stat">通过率 <b>${passRate(run)}</b></span>
      </div>
      <table>
        <thead>
          <tr><th>轮次</th><th>接口</th><th>结果</th><th class="num">耗时 ms</th><th class="num">断言</th><th>失败明细</th></tr>
        </thead>
        <tbody>
${run.items.map((item) => htmlRow(item, run.iterationCount)).join('\n')}
        </tbody>
      </table>
    </main>
  </body>
</html>
`
