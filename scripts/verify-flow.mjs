import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_VERSION = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
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
      byTest: (id) => document.querySelector('[data-testid="' + id + '"]'),
      key: (key, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, opts))),
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
const closeApp = async (app) => {
  if (!child) return
  try {
    // Browser.close 关闭连接时不回包，限时等待进程自行退出
    await Promise.race([app?.send('Browser.close').catch(() => {}), wait(2500)])
  } catch {
    /* 连接可能已断开 */
  }
  for (let i = 0; i < 40 && child && child.exitCode === null; i++) await wait(150)
  if (child && child.exitCode === null) child.kill()
  child = null
  await wait(300)
}

try {
  // ── 第一轮：建项目 → 建接口 → 发请求 ──
  let app = await launch()
  await app.waitFor(
    `document.querySelector(".statusbar")?.innerText.includes("v${APP_VERSION}")`,
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
  report.toast = await app.js(`(() => {
    const t = document.querySelector('.toast')
    const r = t.getBoundingClientRect()
    const cs = getComputedStyle(t)
    return { top: Math.round(r.top), radius: cs.borderRadius, bg: cs.backgroundColor }
  })()`)
  if (report.toast.top > 120) throw new Error(`Toast 未在顶部居中：top=${report.toast.top}px`)
  if (report.toast.radius !== '999px') throw new Error(`Toast 非药丸：${report.toast.radius}`)

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
  report.urlInputWidth = await app.js(
    `Math.round(document.querySelector('[aria-label="请求 URL"]').getBoundingClientRect().width)`,
  )
  if (report.urlInputWidth < 200) {
    throw new Error(`URL 输入框被挤压：宽度 ${report.urlInputWidth}px（应 ≥ 200px）`)
  }
  report.saveButtonInViewport = await app.js(`(() => {
    const b = [...document.querySelectorAll('[title]')].find((e) => e.title === '保存 (Ctrl+S)')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { right: Math.round(r.right), left: Math.round(r.left), vw: window.innerWidth, ok: r.right <= window.innerWidth && r.left >= 0 }
  })()`)

  // ── 06 号文档硬指标：字号 / 焦点环 / JSON 用色 / 状态行 / 无渐变无投影 ──
  report.statusLine = await app.js(`document.querySelector('.status-line')?.innerText ?? null`)
  if (!/^\d{3} .+ · \d+ms · [\d.]+ (B|KB|MB)$/.test(report.statusLine ?? '')) {
    throw new Error(`状态行格式不符：${report.statusLine}`)
  }
  report.dbSizeText = await app.js(
    `document.querySelector('[data-testid="db-size"]')?.innerText ?? null`,
  )
  if (!/^DB [\d.]+ (B|KB|MB)$/.test(report.dbSizeText ?? '')) {
    throw new Error(`底栏 DB 大小缺失：${report.dbSizeText}`)
  }
  report.fontSizes = await app.js(`(() => ({
    badge: getComputedStyle(document.querySelector('.badge')).fontSize,
    pill: getComputedStyle(document.querySelector('.pill')).fontSize,
    name: getComputedStyle(document.querySelector('[data-testid="api-name"]')).fontSize
  }))()`)
  for (const [key, size] of Object.entries(report.fontSizes)) {
    if (!['12px', '13px', '14px', '20px'].includes(size)) {
      throw new Error(`字号越档（${key}）：${size}，仅允许 12/13/14/20`)
    }
  }
  report.focusRing = await app.js(`(() => {
    const b = document.querySelector('[data-testid="save"]')
    b.focus({ focusVisible: true })
    const cs = getComputedStyle(b)
    return { visible: b.matches(':focus-visible'), width: cs.outlineWidth, style: cs.outlineStyle }
  })()`)
  if (!report.focusRing.visible || report.focusRing.width !== '2px') {
    throw new Error(`按钮聚焦环缺失：${JSON.stringify(report.focusRing)}`)
  }
  report.jsonColors = await app.js(`(() => {
    const color = (sel) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).color : null
    }
    return { key: color('.json-key'), str: color('.json-str'), num: color('.json-num') }
  })()`)
  if (
    report.jsonColors.key === report.jsonColors.str ||
    report.jsonColors.str === report.jsonColors.num
  ) {
    throw new Error(`JSON 高亮用色未区分：${JSON.stringify(report.jsonColors)}`)
  }
  report.forbiddenStyles = await app.js(`(() => {
    const all = [...document.querySelectorAll('body *')]
    return {
      gradients: all.filter((e) => getComputedStyle(e).backgroundImage.includes('gradient')).length,
      shadows: all.filter((e) => getComputedStyle(e).boxShadow !== 'none').length
    }
  })()`)
  if (report.forbiddenStyles.gradients > 0 || report.forbiddenStyles.shadows > 0) {
    throw new Error(`出现禁用样式：${JSON.stringify(report.forbiddenStyles)}`)
  }
  report.badButtonRadius = await app.js(`[...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && getComputedStyle(b).borderRadius !== '999px')
    .map((b) => b.innerText.trim() || b.getAttribute('aria-label'))`)
  if (report.badButtonRadius.length > 0) {
    throw new Error(`交互控件非药丸：${report.badButtonRadius.join(', ')}`)
  }
  report.buttonsWithoutTitle = await app.js(`[...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && !b.getAttribute('title'))
    .map((b) => b.innerText.trim() || b.getAttribute('aria-label'))`)
  if (report.buttonsWithoutTitle.length > 0) {
    throw new Error(`按钮缺少快捷键提示：${report.buttonsWithoutTitle.join(', ')}`)
  }

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

  // ── 右键菜单 / 危险操作确认（06 号文档 §3.4、§5）──
  await app.js(`window.__h.click('响应与历史')`)
  await app.waitFor(`!!document.querySelector('.json-key')`, '响应面板恢复')

  await app.js(`(() => {
    const row = document.querySelector('[data-testid^="api-"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 260 }))
    return true
  })()`)
  await app.waitFor(`!!document.querySelector('[data-testid="context-menu"]')`, '右键菜单出现')
  report.contextMenu = await app.js(`(() => {
    const menu = document.querySelector('[data-testid="context-menu"]')
    const cs = getComputedStyle(menu)
    const danger = [...menu.querySelectorAll('button')].find((b) => b.innerText === '删除接口')
    return {
      radius: cs.borderRadius,
      shadow: cs.boxShadow,
      dangerColor: danger ? getComputedStyle(danger).color : null,
      items: [...menu.querySelectorAll('button')].map((b) => b.innerText)
    }
  })()`)
  if (report.contextMenu.radius !== '10px' || report.contextMenu.shadow !== 'none') {
    throw new Error(`右键菜单规格不符：${JSON.stringify(report.contextMenu)}`)
  }
  if (report.contextMenu.dangerColor !== 'rgb(200, 30, 30)') {
    throw new Error(`危险项未用 --err 红字：${report.contextMenu.dangerColor}`)
  }

  await app.js(`[...document.querySelectorAll('[data-testid="context-menu"] button')]
    .find((b) => b.innerText === '删除接口').click()`)
  await app.waitFor(`!!document.querySelector('[data-testid="confirm-dialog"]')`, '删除确认框出现')
  report.confirmText = await app.js(
    `document.querySelector('[data-testid="confirm-dialog"]')?.innerText ?? null`,
  )
  if (!String(report.confirmText).includes('删除接口「查订单」？')) {
    throw new Error(`确认文案不符：${report.confirmText}`)
  }
  await app.js(`document.querySelector('[data-testid="confirm-cancel"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`, '取消删除')

  // ── 树拖拽排序并持久化（07 号文档 §3）──
  await app.js(`window.__h.click('新建接口')`)
  await app.waitFor(`window.__h.val('接口名称') === '新接口'`, '第二个接口草稿', 20000)
  await app.js(`window.__h.set(document.querySelector('[aria-label="接口名称"]'), '第二接口')`)
  await app.waitFor(`window.__h.val('接口名称') === '第二接口'`, '第二个接口改名')
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="请求 URL"]'), 'http://127.0.0.1:${echoPort}/orders?page=2')`,
  )
  await app.js(`window.__h.click('保存 (Ctrl+S)')`)
  try {
    await app.waitFor(
      `[...document.querySelectorAll('.tree-row .label')].some((e) => e.innerText === '第二接口')`,
      '第二个接口入树',
    )
  } catch (e) {
    report.debugSecondApi = await app.js(`({
      name: window.__h.val('接口名称'),
      toast: document.querySelector('.toast-pill')?.innerText ?? document.querySelector('[data-testid="toast"]')?.innerText ?? null,
      body: document.body.innerText.slice(0, 1200),
      apiRows: [...document.querySelectorAll('[data-testid^="api-"]')].map((e) => e.innerText)
    })`)
    throw new Error(e.message + ' ' + JSON.stringify(report.debugSecondApi), { cause: e })
  }
  report.treeOrderBefore = await app.js(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].map((e) => e.innerText)`,
  )
  await app.js(`(() => {
    const rows = [...document.querySelectorAll('[data-testid^="api-"]')]
    const src = rows[0]
    const dst = rows[1]
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const r = dst.getBoundingClientRect()
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r.left + 40, clientY: r.bottom - 2 }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: r.left + 40, clientY: r.bottom - 2 }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return true
  })()`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].map((e) => e.innerText).join('|') === '第二接口|查订单'`,
    '拖拽排序生效',
  )
  report.treeOrderAfter = await app.js(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].map((e) => e.innerText)`,
  )
  await app.js(
    `[...document.querySelectorAll('.tree-row')].find((r) => r.innerText.includes('查订单')).click()`,
  )
  await app.waitFor(`window.__h.val('接口名称') === '查订单'`, '重新选中查订单')

  // ── 三栏拖宽 + 分屏方向 + 命令面板（06 号文档 §4、§5）──
  await app.js(`(() => {
    const s = document.querySelector('[data-testid="splitter-tree"]')
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse', buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse' }))
    return true
  })()`)
  await wait(300)
  report.treeWidthAfterDrag = await app.js(
    `Math.round(document.querySelector('.tree').getBoundingClientRect().width)`,
  )
  report.treeWidthPref = await app.js(`localStorage.getItem('toapi.ui.treeWidth')`)
  if (report.treeWidthAfterDrag < 290 || report.treeWidthAfterDrag > 310) {
    throw new Error(`树拖拽未生效：${report.treeWidthAfterDrag}px`)
  }
  if (report.treeWidthPref !== '300') throw new Error(`栏宽未持久化：${report.treeWidthPref}`)
  report.urlWidthAfterDrag = await app.js(
    `Math.round(document.querySelector('[data-testid="url-input"]').getBoundingClientRect().width)`,
  )
  if (report.urlWidthAfterDrag < 200)
    throw new Error(`拖宽后 URL 被挤压：${report.urlWidthAfterDrag}px`)
  // 拖回 240，保持截图与第二轮布局稳定
  await app.js(`(() => {
    const s = document.querySelector('[data-testid="splitter-tree"]')
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 40, pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 240, clientY: r.top + 40, pointerId: 2, pointerType: 'mouse', buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 240, clientY: r.top + 40, pointerId: 2, pointerType: 'mouse' }))
    return true
  })()`)
  await wait(200)
  report.treeWidthRestored = await app.js(`localStorage.getItem('toapi.ui.treeWidth')`)
  if (report.treeWidthRestored !== '240') {
    throw new Error(`栏宽复位失败：${report.treeWidthRestored}`)
  }

  await app.js(`window.__h.key(String.fromCharCode(96), { ctrlKey: true })`)
  await app.waitFor(
    `document.querySelector('[data-testid="main-col"]').dataset.orientation === 'bottom'`,
    '切到下方分屏',
  )
  report.bottomLayout = await app.js(`(() => {
    const w = document.querySelector('.workspace').getBoundingClientRect()
    const r = document.querySelector('.response-col').getBoundingClientRect()
    return {
      stacked: r.top >= w.bottom - 1,
      responseHeight: Math.round(r.height),
      urlWidth: Math.round(document.querySelector('[data-testid="url-input"]').getBoundingClientRect().width)
    }
  })()`)
  if (!report.bottomLayout.stacked || report.bottomLayout.responseHeight < 180) {
    throw new Error(`下方分屏异常：${JSON.stringify(report.bottomLayout)}`)
  }
  if (report.bottomLayout.urlWidth < 200) {
    throw new Error(`下行分屏 URL 被挤压：${report.bottomLayout.urlWidth}px`)
  }
  await app.js(`window.__h.key(String.fromCharCode(96), { ctrlKey: true })`)
  await app.waitFor(
    `document.querySelector('[data-testid="main-col"]').dataset.orientation === 'right'`,
    '切回右侧分屏',
  )
  report.orientationPref = await app.js(`localStorage.getItem('toapi.ui.orientation')`)
  if (report.orientationPref !== '"right"') {
    throw new Error(`分屏方向未持久化：${report.orientationPref}`)
  }

  await app.js(`window.__h.key('k', { ctrlKey: true })`)
  await app.waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, '命令面板打开')
  report.palette = await app.js(`(() => {
    const p = document.querySelector('[data-testid="command-palette"]')
    const cs = getComputedStyle(p)
    return {
      radius: cs.borderRadius,
      shadow: cs.boxShadow,
      count: document.querySelectorAll('[data-testid="palette-item"]').length
    }
  })()`)
  if (
    report.palette.radius !== '12px' ||
    report.palette.shadow !== 'none' ||
    report.palette.count < 1
  ) {
    throw new Error(`命令面板规格不符：${JSON.stringify(report.palette)}`)
  }
  await app.js(`window.__h.set(document.querySelector('[aria-label="命令"]'), '查订单')`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((e) => e.innerText.includes('查订单'))`,
    '命令面板过滤',
  )
  await app.js(
    `document.querySelector('[aria-label="命令"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  )
  await app.waitFor(`!document.querySelector('[data-testid="command-palette"]')`, '命令面板关闭')
  await app.waitFor(`window.__h.val('接口名称') === '查订单'`, '命令面板跳转接口')

  await app.js(`window.__h.key('R', { ctrlKey: true, shiftKey: true })`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="runner"]')`,
    'Ctrl+Shift+R 打开 Runner',
    15000,
  )
  await app.waitFor(
    `document.querySelector('[data-testid="runner"] .response-head .meta')?.innerText.includes('2/2 项')`,
    'Ctrl+Shift+R 运行集合',
    30000,
  )
  report.shortcutRun = await app.js(
    `document.querySelector('[data-testid="runner"] .response-head .meta')?.innerText ?? null`,
  )
  if (
    !String(report.shortcutRun).includes('2/2 项') ||
    !String(report.shortcutRun).includes('通过率 100%')
  ) {
    throw new Error(`Ctrl+Shift+R 集合结果不符：${report.shortcutRun}`)
  }

  await app.js(`window.__h.click('响应与历史')`)
  await app.js(`window.__h.click('发送 (Ctrl+Enter)')`)
  await app.waitFor(`!!document.querySelector('.json-key')`, '截图前响应', 25000)

  const shot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-flow-1.png'), Buffer.from(shot.data, 'base64'))

  // ── 1024×640 最小窗口：三栏不重叠、URL 仍可用（07 号文档 §3）──
  await app.send('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(400)
  report.layout1024 = await app.js(`(() => {
    const t = document.querySelector('.tree').getBoundingClientRect()
    const w = document.querySelector('.workspace').getBoundingClientRect()
    const r = document.querySelector('.response-col').getBoundingClientRect()
    return {
      vw: window.innerWidth,
      treeRight: Math.round(t.right),
      workspaceLeft: Math.round(w.left),
      workspaceRight: Math.round(w.right),
      responseLeft: Math.round(r.left),
      urlWidth: Math.round(document.querySelector('[data-testid="url-input"]').getBoundingClientRect().width)
    }
  })()`)
  if (report.layout1024.vw !== 1024) {
    throw new Error(`1024 视口未生效：${report.layout1024.vw}`)
  }
  if (report.layout1024.treeRight > report.layout1024.workspaceLeft + 1) {
    throw new Error(`1024 下树与编辑器重叠：${JSON.stringify(report.layout1024)}`)
  }
  if (report.layout1024.workspaceRight > report.layout1024.responseLeft + 1) {
    throw new Error(`1024 下编辑器与响应重叠：${JSON.stringify(report.layout1024)}`)
  }
  if (report.layout1024.urlWidth < 200) {
    throw new Error(`1024 下 URL 被挤压：${report.layout1024.urlWidth}px`)
  }
  await app.send('Emulation.clearDeviceMetricsOverride')
  await wait(300)

  report.runtimeErrorsRound1 = app.errors
  await closeApp(app)
  app.ws.close()

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
  report.persistedApiOrder = await app.js(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].map((e) => e.innerText)`,
  )
  report.persistedPrefs = await app.js(`({
    treeWidth: localStorage.getItem('toapi.ui.treeWidth'),
    orientation: localStorage.getItem('toapi.ui.orientation')
  })`)
  if (report.persistedApiOrder.join('|') !== '第二接口|查订单') {
    throw new Error(`重启后排序丢失：${report.persistedApiOrder.join('|')}`)
  }
  if (
    report.persistedPrefs.treeWidth !== '240' ||
    report.persistedPrefs.orientation !== '"right"'
  ) {
    throw new Error(`重启后 UI 偏好丢失：${JSON.stringify(report.persistedPrefs)}`)
  }

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
