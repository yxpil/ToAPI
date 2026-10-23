import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = 9334
const profile = resolve(root, '.tmp/e2e-flow-profile')

rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 靶场：回显收到的请求，用于断言线上真实行为
const echo = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, headers: req.rawHeaders }))
  })
})
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port

let child = null
const launch = async () => {
  child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  const stderr = []
  child.stderr.on('data', (d) => stderr.push(String(d)))

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 端口未就绪 */
    }
  }
  if (!target) throw new Error('Electron 未就绪: ' + stderr.join(''))

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  let seq = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.rej(new Error(JSON.stringify(msg.error)))
      else entry.res(msg.result)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception')
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(String(msg.params.entry.text).slice(0, 300))
    }
  })
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const id = ++seq
      pending.set(id, { res: r, rej: j })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Runtime.evaluate', {
    expression: `window.__h = {
      byTitle: (t) => [...document.querySelectorAll('[title]')].find((e) => e.title === t),
      set: (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      click: (t) => {
        const node = window.__h.byTitle(t)
        if (!node) throw new Error('找不到控件: ' + t)
        node.click()
        return true
      },
      text: (sel) => document.querySelector(sel)?.innerText ?? null,
      val: (label) => document.querySelector('[aria-label="' + label + '"]')?.value ?? null,
    }`,
  })

  const js = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(expression + ' -> ' + JSON.stringify(exceptionDetails))
    return result.value
  }
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
      if (await js(`!!(${expression})`)) return true
      await wait(250)
    }
    throw new Error(`超时等待: ${label} (${expression})`)
  }
  return { ws, send, js, waitFor, errors }
}

const report = {}
const closeApp = async () => {
  child?.kill()
  await wait(1200)
}

try {
  // ── 第一轮：建项目 → 建接口 → 发请求 ──
  let app = await launch()
  await app.waitFor(
    'document.querySelector(".statusbar")?.innerText.includes("v0.1.0")',
    '主进程握手',
  )

  await app.js(`window.__h.set(document.querySelector('[aria-label="项目名称"]'), '订单中心')`)
  await app.js(`window.__h.click('创建项目')`)
  await app.waitFor(
    `[...document.querySelectorAll('.tree-row .label')].some(e => e.innerText === '订单中心')`,
    '项目行出现',
  )
  await app.waitFor(
    `[...document.querySelectorAll('.tree-row .label')].some(e => e.innerText === '默认集合')`,
    '默认集合出现',
  )

  await app.js(`window.__h.click('新建接口')`)
  await app.waitFor(`!!document.querySelector('.url-capsule')`, 'URL 大胶囊出现')

  await app.js(
    `window.__h.set(document.querySelector('[aria-label="请求 URL"]'), 'http://127.0.0.1:${echoPort}/orders?page=2')`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="接口名称"]'), '查订单')`)
  await app.js(`window.__h.click('保存 (Ctrl+S)')`)
  await app.waitFor(`document.querySelector('.toast')?.innerText.includes('已保存')`, '保存 Toast')

  await app.js(`window.__h.click('发送 (Ctrl+Enter)')`)
  await app.waitFor(
    `document.querySelector('.response-body')?.innerText.includes('"method": "GET"')`,
    '响应体渲染',
    25000,
  )

  report.statusBadge = await app.js(`document.querySelector('.status.s2')?.innerText ?? null`)
  report.metaLine = await app.js(`document.querySelector('.meta')?.innerText ?? null`)
  report.responseSnippet = (
    await app.js(`document.querySelector('.response-body')?.innerText ?? ''`)
  ).slice(0, 220)
  report.requestUrl = await app.js(`window.__h.val('请求 URL')`)
  report.treeRows = await app.js(`document.querySelectorAll('.tree-row').length`)
  report.svgIcons = await app.js(`document.querySelectorAll('svg.icon').length`)
  report.emojiInDom = await app.js(
    `(document.body.innerText.match(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu) || []).length`,
  )
  report.pillRadius = await app.js(`getComputedStyle(document.querySelector('.pill')).borderRadius`)
  report.saveButtonInViewport = await app.js(`(() => {
    const b = [...document.querySelectorAll('[title]')].find((e) => e.title === '保存 (Ctrl+S)')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { right: Math.round(r.right), left: Math.round(r.left), vw: window.innerWidth, ok: r.right <= window.innerWidth && r.left >= 0 }
  })()`)

  // ── 脚本断言：在「脚本」Tab 写后置断言并保存重发 ──
  await app.js(`window.__h.click('脚本')`)
  await app.waitFor(`!!document.querySelector('[aria-label="后置脚本"]')`, '脚本编辑区出现')
  await app.js(`window.__h.set(
    document.querySelector('[aria-label="后置脚本"]'),
    "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))\\ntoapi.test('回显 method', () => toapi.expect(toapi.response.json().method).toBe('GET'))"
  )`)
  await app.js(`window.__h.click('保存 (Ctrl+S)')`)
  await app.waitFor(
    `document.querySelector('.toast')?.innerText.includes('已保存')`,
    '脚本保存 Toast',
  )
  await app.js(`window.__h.click('发送 (Ctrl+Enter)')`)
  await app.waitFor(
    `document.querySelectorAll('[aria-label="断言通过"]').length >= 2`,
    '两条断言显示为通过',
    25000,
  )
  report.assertionsRendered = await app.js(
    `document.querySelectorAll('[aria-label="断言通过"]').length`,
  )

  // ── 集合 Runner：先切到 Runner 面板（订阅进度事件），再点集合行的「运行集合」 ──
  await app.js(`window.__h.click('集合 Runner 结果')`)
  await app.waitFor(`!!document.querySelector('.pane-body')`, 'Runner 面板挂载')
  await app.js(`window.__h.click('运行集合')`)
  await app.waitFor(
    `document.querySelectorAll('.pane-body [aria-label="断言通过"]').length > 0`,
    'Runner 结果出现',
    25000,
  )
  await app.waitFor(
    `document.querySelector('.pane-body')?.innerText.includes('通过率')`,
    '通过率出现',
    20000,
  )
  report.runnerSummary = await app.js(
    `document.querySelector('.response-head .meta')?.innerText ?? null`,
  )
  report.runnerItems = await app.js(`document.querySelectorAll('.pane-body .history-row').length`)
  report.runnerAssertionIcons = await app.js(
    `document.querySelectorAll('.pane-body [aria-label="断言通过"]').length`,
  )

  const shot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-flow-1.png'), Buffer.from(shot.data, 'base64'))
  report.runtimeErrorsRound1 = app.errors
  app.ws.close()
  await closeApp()

  // ── 第二轮：重启验证持久化（01 号文档 M1 验收：数据重启不丢）──
  app = await launch()
  await app.waitFor(
    `[...document.querySelectorAll('.tree-row .label')].some(e => e.innerText === '查订单')`,
    '重启后接口仍在树中',
  )
  await app.js(
    `[...document.querySelectorAll('.tree-row')].find(r => r.innerText.includes('查订单')).click()`,
  )
  await app.waitFor(`!!document.querySelector('.url-capsule')`, '重启后编辑器打开')
  report.savedUrlAfterRestart = await app.js(`window.__h.val('请求 URL')`)

  await app.js(`window.__h.click('发送 (Ctrl+Enter)')`)
  await app.waitFor(
    `document.querySelector('.status.s2')?.innerText === '200'`,
    '重启后仍能发送成功',
    25000,
  )

  await app.js(`window.__h.click('历史')`)
  await app.waitFor(`document.querySelectorAll('.history-row').length > 0`, '历史行出现', 20000)
  report.persistedTreeRows = await app.js(`document.querySelectorAll('.tree-row').length`)
  report.apiNameAfterRestart = await app.js(
    `[...document.querySelectorAll('.tree-row .label')].map(e => e.innerText).filter(t => t === '订单中心' || t === '查订单')`,
  )
  report.historyRowCount = await app.js(`document.querySelectorAll('.history-row').length`)
  const shot2 = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-flow-2.png'), Buffer.from(shot2.data, 'base64'))
  report.runtimeErrorsRound2 = app.errors
  app.ws.close()
} finally {
  await closeApp()
  echo.close()
}

report.screenshots = ['.tmp/toapi-flow-1.png', '.tmp/toapi-flow-2.png']
console.log(JSON.stringify(report, null, 2))
