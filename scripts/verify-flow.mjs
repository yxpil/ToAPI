// @author yxpil
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
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
/** 自绘标题栏与 Win32 窗口态只属于 Windows；托盘驻留语义 Windows/macOS 默认开、Linux 默认关 */
const IS_WINDOWS = process.platform === 'win32'
const TRAY_BY_DEFAULT = process.platform === 'win32' || process.platform === 'darwin'

rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** .tapi 夹具：与 08 号文档 §6 同一规范化算法，tamper=true 时故意让校验和失效 */
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

const tapiFixture = (tamper = false) => {
  const payload = {
    project: {
      name: '互传验收',
      description: 'verify:flow 生成',
      settings: {},
      auth: { type: 'none' },
      variables: [],
      pre_script: '',
      post_script: '',
      collections: [
        {
          key: 'col-1',
          name: '验收集合',
          description: '',
          auth: { type: 'bearer', token: '{{token}}' },
          variables: [{ key: 'colKey', value: '', secret: true, enabled: true, redacted: true }],
          pre_script: '',
          post_script: '',
          children: [],
          apis: [
            {
              key: 'api-1',
              name: '验收接口',
              description: '',
              method: 'GET',
              url: '{{baseUrl}}/verify',
              params: [],
              headers: [],
              body_type: 'none',
              body: '',
              auth: { type: 'inherit' },
              fake: {},
              pre_script: '',
              post_script: '',
              extractors: [],
            },
          ],
        },
      ],
    },
    environments: [],
    globals: [],
    cases: [],
  }
  const checksum = `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`
  if (tamper) payload.project.name = '互传验收（被改过）'
  return JSON.stringify(
    {
      format: 'tapi',
      format_version: '1.0',
      meta: { exported_at: Date.now(), app_version: APP_VERSION, name: '互传验收', checksum },
      payload,
    },
    null,
    2,
  )
}

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
/** CI 上定位卡点用：记录最后一步等待的语义标签，并对 CDP 请求加硬超时 */
let lastStep = '启动应用'
let jsCalls = 0
const markStep = (label) => {
  lastStep = label
  process.stderr.write(`[verify-flow] 等待：${label}\n`)
}
const launch = async () => {
  child = spawn(
    electronBin,
    [
      '.',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // CI 的 Linux runner 以容器/root 跑，Chromium sandbox 不可用
      '--no-sandbox',
    ],
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
      // 渲染进程或主进程卡死时 CDP 永远不返回；没有这个超时就只能等 CI 把 job 跑到 40 分钟
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        j(new Error(`CDP ${method} 30s 未返回（最后一步：${lastStep}）`))
      }, 30_000).unref()
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
    jsCalls += 1
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(expression + ' -> ' + JSON.stringify(exceptionDetails))
    return result.value
  }
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    markStep(label)
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

/** 总时长看门狗：卡死时打印最后一步再退出，不让 CI 干等到 job 超时被系统取消 */
const HARD_LIMIT_MS = 12 * 60_000
const watchdog = setTimeout(() => {
  console.error(
    `[verify-flow] 超过 ${HARD_LIMIT_MS / 60000} 分钟未完成：第 ${jsCalls} 次求值，最后一步「${lastStep}」`,
  )
  process.exit(1)
}, HARD_LIMIT_MS)

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
    return {
      bottom: Math.round(window.innerHeight - r.bottom),
      radius: cs.borderRadius,
      bg: cs.backgroundColor
    }
  })()`)
  if (report.toast.bottom < 30 || report.toast.bottom > 80) {
    throw new Error(`Toast 未在底部居中：bottom=${report.toast.bottom}px`)
  }
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
  // ── 06 号文档 §4：画布 + 浮层面板 + 下划线 Tab ──
  report.layout = await app.js(`(() => {
    const panel = (sel) => {
      const cs = getComputedStyle(document.querySelector(sel))
      return { radius: cs.borderRadius, bg: cs.backgroundColor, border: cs.borderTopWidth }
    }
    const shell = getComputedStyle(document.querySelector('.shell'))
    const tab = document.querySelector('.tab-row .text-tabs button[aria-selected="true"]')
    const tabCs = tab ? getComputedStyle(tab) : null
    const ind = tab ? getComputedStyle(tab, '::after') : null
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      gap: shell.gap,
      padLeft: shell.paddingLeft,
      tree: panel('.tree'),
      editor: panel('.workspace'),
      response: panel('.response-col'),
      tab: tab
        ? {
            bg: tabCs.backgroundColor,
            radius: tabCs.borderRadius,
            indicator: ind.height,
            indicatorColor: ind.backgroundColor
          }
        : null
    }
  })()`)
  if (report.layout.canvas !== 'rgb(242, 242, 244)') {
    throw new Error(`画布底色不符：${report.layout.canvas}`)
  }
  if (report.layout.gap !== '10px' || report.layout.padLeft !== '10px') {
    throw new Error(`面板间距不符：${JSON.stringify(report.layout)}`)
  }
  for (const [name, panel] of Object.entries({
    tree: report.layout.tree,
    editor: report.layout.editor,
    response: report.layout.response,
  })) {
    if (panel.radius !== '14px' || panel.bg !== 'rgb(255, 255, 255)' || panel.border !== '1px') {
      throw new Error(`浮层面板规格不符（${name}）：${JSON.stringify(panel)}`)
    }
  }
  if (
    !report.layout.tab ||
    report.layout.tab.bg !== 'rgba(0, 0, 0, 0)' ||
    report.layout.tab.radius !== '0px' ||
    report.layout.tab.indicator !== '2px' ||
    report.layout.tab.indicatorColor !== 'rgb(22, 22, 24)'
  ) {
    throw new Error(`下划线 Tab 规格不符：${JSON.stringify(report.layout.tab)}`)
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
  report.badButtonRadius = await app.js(`(() => {
    const expected = (b) => {
      if (b.closest('.win-btn')) return '8px'
      if (b.closest('.statusbar')) return '6px'
      if (b.closest('.text-tabs')) return '0px'
      if (b.closest('.menu-item')) return '6px'
      if (b.closest('.palette-item')) return '8px'
      return '999px'
    }
    return [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null && getComputedStyle(b).borderRadius !== expected(b))
      .map((b) => (b.innerText.trim() || b.getAttribute('aria-label')) + '=' + getComputedStyle(b).borderRadius)
  })()`)
  if (report.badButtonRadius.length > 0) {
    throw new Error(`交互控件圆角不符：${report.badButtonRadius.join(', ')}`)
  }
  report.buttonsWithoutTitle = await app.js(`[...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null && !b.getAttribute('title'))
    .map((b) => b.innerText.trim() || b.getAttribute('aria-label'))`)
  if (report.buttonsWithoutTitle.length > 0) {
    throw new Error(`按钮缺少快捷键提示：${report.buttonsWithoutTitle.join(', ')}`)
  }

  // ── 下拉列表圆角（06 号文档 §3.3）：弹出层 10px、选项药丸、无阴影 ──
  const methodRect = await app.js(`(() => {
    const r = document.querySelector('[data-testid="method"]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: methodRect.x,
    y: methodRect.y,
    button: 'left',
    clickCount: 1,
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: methodRect.x,
    y: methodRect.y,
    button: 'left',
    clickCount: 1,
  })
  await app.waitFor(
    `document.querySelector('[data-testid="method"]').matches(':open')`,
    '下拉列表展开',
  )
  report.selectPicker = await app.js(`(() => {
    const sel = document.querySelector('[data-testid="method"]')
    const picker = getComputedStyle(sel, '::picker(select)')
    const option = getComputedStyle(document.querySelector('select option'))
    return {
      radius: picker.borderRadius,
      shadow: picker.boxShadow,
      background: picker.backgroundColor,
      optionRadius: option.borderRadius,
      optionHeight: option.minHeight
    }
  })()`)
  if (
    report.selectPicker.radius !== '10px' ||
    report.selectPicker.shadow !== 'none' ||
    report.selectPicker.optionRadius !== '999px'
  ) {
    throw new Error(`下拉列表规格不符：${JSON.stringify(report.selectPicker)}`)
  }
  const selectShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-select.png'), Buffer.from(selectShot.data, 'base64'))
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  await app.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  await app.waitFor(
    `!document.querySelector('[data-testid="method"]').matches(':open')`,
    '下拉列表关闭',
  )

  // ── 脚本断言：在「脚本」Tab 写后置断言并保存重发 ──
  await app.js(`window.__h.click('脚本')`)
  await app.waitFor(`!!document.querySelector('[aria-label="后置脚本"]')`, '脚本编辑区出现')
  await app.js(`window.__h.set(
    document.querySelector('[aria-label="后置脚本"]'),
    "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))\\ntoapi.test('回显 method', () => toapi.expect(toapi.response.json().method).toBe('GET'))\\npm.test.skip('跳过示例')"
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
  await app.waitFor(
    `document.querySelectorAll('[aria-label="断言跳过"]').length === 1`,
    '跳过断言以 dash 标记展示',
    10000,
  )
  report.skippedAssertions = await app.js(
    `document.querySelectorAll('[aria-label="断言跳过"]').length`,
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
  await app.waitFor(
    `document.querySelectorAll('.pane-body [aria-label="断言跳过"]').length > 0`,
    'Runner 跳过断言以 dash 标记展示',
    10000,
  )
  report.runnerSkippedIcons = await app.js(
    `document.querySelectorAll('.pane-body [aria-label="断言跳过"]').length`,
  )

  // ── 数据驱动 Runner（23 号文档 §5.1、06 号文档 §3.6）：粘贴 CSV → 解析 → 两轮迭代 ──
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="Runner 数据行"]'), 'user\\nalice\\nbob')`,
  )
  await app.js(`window.__h.click('解析数据行')`)
  await app.waitFor(
    `document.querySelector('[data-testid="runner-data-summary"]')?.innerText.includes('2 行')`,
    '数据行解析出 2 行',
    10000,
  )
  report.runnerDataSummary = await app.js(
    `document.querySelector('[data-testid="runner-data-summary"]')?.innerText ?? null`,
  )
  await app.js(`window.__h.click('运行集合')`)
  await app.waitFor(
    `document.querySelectorAll('.pane-body [data-testid^="runner-item-iteration-"]').length >= 2`,
    '轮次标记出现在明细行',
    30000,
  )
  report.runnerIterationBadges = await app.js(
    `document.querySelectorAll('.pane-body [data-testid^="runner-item-iteration-"]').length`,
  )
  report.runnerIterationTexts = await app.js(
    `[...document.querySelectorAll('.pane-body [data-testid^="runner-item-iteration-"]')].slice(0, 2).map((e) => e.innerText)`,
  )
  await app.waitFor(
    `document.querySelector('.response-head .meta')?.innerText.includes('2 轮迭代')`,
    '标题行显示迭代轮数',
    15000,
  )
  // 清空数据行，让后续快捷键步骤回到单轮语义
  await app.js(`window.__h.click('清空数据行')`)
  await app.waitFor(
    `document.querySelector('[data-testid="runner-data-summary"]')?.innerText.includes('未使用数据行')`,
    '数据行已清空',
    10000,
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

  await app.js(`(() => {
    const row = document.querySelector('[data-testid^="collection-"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }))
    return true
  })()`)
  await app.waitFor(`!!document.querySelector('[data-testid="context-menu"]')`, '集合右键菜单')
  report.collectionMenu = await app.js(
    `[...document.querySelectorAll('[data-testid="context-menu"] button')].map((b) => b.innerText)`,
  )
  if (!report.collectionMenu.includes('导出为 Postman Collection…')) {
    throw new Error(`集合菜单缺少 Postman 导出：${JSON.stringify(report.collectionMenu)}`)
  }
  await app.js(`window.__h.key('Escape')`)
  await app.waitFor(`!document.querySelector('[data-testid="context-menu"]')`, '集合菜单关闭')

  // ── .tapi 导入（08 号文档 §5、06 号文档 §3.7b）──
  await app.js(`(() => {
    const row = document.querySelector('[data-testid^="project-"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 200 }))
    return true
  })()`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="context-menu"]')`,
    '项目右键菜单（.tapi）',
  )
  report.projectMenu = await app.js(
    `[...document.querySelectorAll('[data-testid="context-menu"] button')].map((b) => b.innerText)`,
  )
  for (const need of ['导入 .tapi…', '导出为 .tapi…']) {
    if (!report.projectMenu.includes(need)) {
      throw new Error(`项目菜单缺少 ${need}：${JSON.stringify(report.projectMenu)}`)
    }
  }
  await app.js(
    `[...document.querySelectorAll('[data-testid="context-menu"] button')]
      .find((b) => b.innerText === '导入 .tapi…').click()`,
  )
  await app.waitFor(
    `!!document.querySelector('[data-testid="tapi-import"]')`,
    '.tapi 导入对话框打开',
  )
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="TAPI 内容"]'), ${JSON.stringify(tapiFixture(false))})`,
  )
  await app.waitFor(`!!document.querySelector('[data-testid="tapi-summary"]')`, '.tapi 预览出现')
  report.tapiSummary = await app.js(
    `document.querySelector('[data-testid="tapi-summary"]')?.innerText ?? null`,
  )
  if (
    !String(report.tapiSummary).includes('1 集合') ||
    !String(report.tapiSummary).includes('已剔除 1 个')
  ) {
    throw new Error(`.tapi 预览内容不符：${report.tapiSummary}`)
  }
  report.tapiImportEnabled = await app.js(
    `!document.querySelector('[data-testid="tapi-import-ok"]')?.disabled`,
  )
  if (report.tapiImportEnabled !== true) throw new Error('合法 .tapi 的导入按钮应可用')
  await app.js(`document.querySelector('[data-testid="tapi-import-ok"]').click()`)
  await app.waitFor(
    `document.querySelector('.toast')?.innerText.includes('导入完成')`,
    '.tapi 导入 Toast',
    15000,
  )
  report.tapiToast = await app.js(`document.querySelector('.toast')?.innerText ?? null`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="project-"] .label')].some((e) => e.innerText === '互传验收')`,
    '导入的项目出现在项目树',
  )

  // 校验和被破坏的文件：红字提示 + 导入按钮禁用，不给强行导入的出口
  await app.js(`(() => {
    const row = document.querySelector('[data-testid^="project-"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 200 }))
    return true
  })()`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="context-menu"]')`,
    '项目右键菜单（篡改）',
  )
  await app.js(
    `[...document.querySelectorAll('[data-testid="context-menu"] button')]
      .find((b) => b.innerText === '导入 .tapi…').click()`,
  )
  await app.waitFor(
    `!!document.querySelector('[data-testid="tapi-import"]')`,
    '.tapi 对话框再次打开',
  )
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="TAPI 内容"]'), ${JSON.stringify(tapiFixture(true))})`,
  )
  await app.waitFor(
    `!!document.querySelector('[data-testid="tapi-blocked"]')`,
    '校验和不匹配提示出现',
  )
  report.tapiBlocked = await app.js(
    `document.querySelector('[data-testid="tapi-blocked"]')?.innerText ?? null`,
  )
  report.tapiTamperDisabled = await app.js(
    `document.querySelector('[data-testid="tapi-import-ok"]')?.disabled ?? null`,
  )
  if (report.tapiTamperDisabled !== true) throw new Error('校验和不匹配时导入按钮必须禁用')
  await app.js(`document.querySelector('[data-testid="tapi-cancel"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="tapi-import"]')`, '.tapi 对话框关闭')

  // 导回原项目，后面的快捷键与截图断言仍针对「订单中心」
  await app.js(`(() => {
    const row = [...document.querySelectorAll('[data-testid^="project-"]')]
      .find((e) => e.innerText.includes('订单中心'))
    row.click()
    return true
  })()`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="project-"]')].some((e) => e.innerText.includes('订单中心') && e.className.includes('selected'))`,
    '切回订单中心项目',
  )
  await app.waitFor(`!!document.querySelector('[data-testid^="api-"]')`, '原项目接口树可见')

  // ── 开放调用设置（11 号文档 §7、06 号文档 §3.9）：密码闸门在 UI 上的表现 ──
  await app.js(`window.__h.key('k', { ctrlKey: true })`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="command-palette"]')`,
    '命令面板（开放调用）',
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="命令"]'), '开放调用设置')`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((e) => e.innerText.includes('开放调用设置'))`,
    '命令面板能找到开放调用设置',
  )
  await app.js(
    `document.querySelector('[aria-label="命令"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  )
  await app.waitFor(
    `!!document.querySelector('[data-testid="open-settings"]')`,
    '开放调用设置面板打开',
  )
  report.openGateBefore = await app.js(`(() => {
    const box = document.querySelector('[data-testid="open-enabled"]')
    return {
      disabled: box?.disabled ?? null,
      hint: document.querySelector('[data-testid="open-settings"]')?.innerText.includes('未设置调用密码') ?? false,
    }
  })()`)
  if (report.openGateBefore.disabled !== true || report.openGateBefore.hint !== true) {
    throw new Error(`未设密码时启用开关应被锁住：${JSON.stringify(report.openGateBefore)}`)
  }
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="新调用密码"]'), 'flow-verify-secret')`,
  )
  await app.js(`window.__h.click('应用调用密码')`)
  await app.waitFor(
    `document.querySelector('[data-testid="open-enabled"]')?.disabled === false`,
    '设置密码后启用开关解锁',
  )
  report.openGateAfter = await app.js(
    `document.querySelector('[data-testid="open-enabled"]')?.disabled ?? null`,
  )
  if (report.openGateAfter !== false) throw new Error('设置密码后应允许启用开放通道')
  await app.js(`document.querySelector('[data-testid="open-enabled"]').click()`)
  await app.waitFor(
    `document.querySelector('[data-testid="open-enabled"]')?.checked === true`,
    '开放通道开关已打开',
  )
  report.openSnippet = await app.js(`document.querySelector('.open-snippet')?.innerText ?? null`)
  await app.js(`document.querySelector('[data-testid="open-close"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="open-settings"]')`, '开放调用设置关闭')

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
  // 布局断言必须在固定视口下做：CI runner 的窗口尺寸与 DPI 跟本机不同，
  // 否则「URL ≥200px」这类阈值会因环境抖动误判（Windows runner 上实测 187px）。
  await app.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(400)
  await app.js(`(() => {
    const s = document.querySelector('[data-testid="splitter-tree"]')
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 310, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse', buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 310, clientY: r.top + 40, pointerId: 1, pointerType: 'mouse' }))
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
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 250, clientY: r.top + 40, pointerId: 2, pointerType: 'mouse', buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 250, clientY: r.top + 40, pointerId: 2, pointerType: 'mouse' }))
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
  await app.send('Emulation.clearDeviceMetricsOverride')
  await wait(300)

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
    report.palette.radius !== '14px' ||
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

  // ── 全局搜索：按 URL 命中接口、按名称命中项目（06 号文档 §5）──
  await app.js(`window.__h.key('k', { ctrlKey: true })`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="command-palette"]')`,
    '命令面板再次打开',
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="命令"]'), '/orders?page=2')`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((e) => e.innerText.includes('查订单') && e.innerText.includes('/orders'))`,
    '按 URL 搜到接口',
  )
  report.searchByUrl = await app.js(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].map((e) => e.innerText)`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="命令"]'), '订单中心')`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].some((e) => e.innerText.includes('打开项目 · 订单中心'))`,
    '按名称搜到项目',
  )
  report.searchProject = await app.js(
    `[...document.querySelectorAll('[data-testid="palette-item"]')].filter((e) => e.innerText.includes('打开项目')).map((e) => e.innerText)`,
  )
  await app.js(
    `document.querySelector('[aria-label="命令"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await app.waitFor(`!document.querySelector('[data-testid="command-palette"]')`, '命令面板关闭')

  // ── 接口单独重命名（06 号文档 §3.4）：名称改、URL 与方法不变 ──
  const openRename = async () => {
    await app.js(`(() => {
      const row = [...document.querySelectorAll('[data-testid^="api-"]')].find((e) => e.innerText.includes('查订单'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
      return true
    })()`)
    await app.waitFor(
      `!!document.querySelector('[data-testid="context-menu"]')`,
      '接口右键菜单出现',
    )
    report.renameMenuItem = await app.js(
      `[...document.querySelectorAll('[data-testid="context-menu"] button')].map((b) => b.innerText)`,
    )
    await app.js(
      `[...document.querySelectorAll('[data-testid="context-menu"] button')].find((b) => b.innerText === '重命名接口').click()`,
    )
    await app.waitFor(
      `!!document.querySelector('[data-testid="rename-dialog"]')`,
      '重命名对话框出现',
    )
  }

  await openRename()
  report.renamePrefill = await app.js(
    `document.querySelector('[data-testid="rename-input"]')?.value ?? null`,
  )
  await app.js(`window.__h.set(document.querySelector('[data-testid="rename-input"]'), '查订单V2')`)
  await app.js(`document.querySelector('[data-testid="rename-ok"]').click()`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].some((e) => e.innerText === '查订单V2')`,
    '树行名称已更新',
  )
  await app.waitFor(`window.__h.val('接口名称') === '查订单V2'`, '编辑器标题同步')
  await app.waitFor(
    `document.querySelector('[aria-label="请求 URL"]')?.value.includes('/orders?page=2')`,
    '重命名后 URL 不变',
  )
  report.renamedTo = await app.js(`window.__h.val('接口名称')`)

  // 改回原名，保持后续断言（截图、重启持久化）的语义不变
  await openRename()
  await app.js(`window.__h.set(document.querySelector('[data-testid="rename-input"]'), '查订单')`)
  await app.js(`document.querySelector('[data-testid="rename-ok"]').click()`)
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="api-"] .label')].some((e) => e.innerText === '查订单')`,
    '名称已还原',
  )

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

  // ── 通知中心（15 号文档 §5）：Runner 结果必须能在界面看到、跳转、清零 ──
  report.notifyBadgeBefore = await app.js(
    `document.querySelector('[data-testid="notify-unread"]')?.innerText ?? null`,
  )
  if (report.notifyBadgeBefore === null) throw new Error('跑过集合后底栏铃铛没有未读角标')
  await app.js(`window.__h.click('通知中心')`)
  await app.waitFor(`!!document.querySelector('[data-testid="notify-drawer"]')`, '通知抽屉打开')
  report.notifyItems = await app.js(
    `[...document.querySelectorAll('[data-testid="notify-item"]')].map((e) => e.textContent)`,
  )
  report.notifyDrawerWidth = await app.js(
    `Math.round(document.querySelector('[data-testid="notify-drawer"]').getBoundingClientRect().width)`,
  )
  if (report.notifyDrawerWidth !== 320)
    throw new Error(`通知抽屉不是 320px：${report.notifyDrawerWidth}`)
  if (!report.notifyItems.some((t) => t.includes('冒烟') || t.includes('/2 通过'))) {
    throw new Error(`通知中心没有 Runner 汇报：${JSON.stringify(report.notifyItems)}`)
  }
  report.notifyLevelColors = await app.js(`(() => {
    const item = document.querySelector('[data-testid="notify-item"]')
    const icon = getComputedStyle(item.querySelector('.notify-icon')).color
    const warn = document.querySelector('.notify-item.warn .notify-icon')
    return { icon, warn: warn ? getComputedStyle(warn).color : null }
  })()`)
  // 点条目跳来源：应把右侧面板切到 Runner 并选中那次运行（抽屉保持开着）
  await app.js(`document.querySelector('[data-testid="notify-item"]').click()`)
  await app.waitFor(`!!document.querySelector('[data-testid="runner"]')`, '通知点击跳到 Runner')
  await app.waitFor(
    `document.querySelector('[data-testid="notify-drawer"]') !== null`,
    '跳转后抽屉不关',
  )
  await app.js(`document.querySelector('[data-testid="notify-read-all"]').click()`)
  await app.waitFor(
    `!document.querySelector('[data-testid="notify-unread"]')`,
    '全部已读后角标消失',
  )
  await app.js(`document.querySelector('[aria-label="关闭通知中心"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="notify-drawer"]')`, '通知抽屉关闭')

  // ── 定时任务（12 号文档 §1）：cron 预览 → 锁环境 → 立即运行 → 汇报与报告进通知 ──
  await app.js(`window.__h.click('定时任务')`)
  await app.waitFor(`!!document.querySelector('[data-testid="task-pane"]')`, '任务面板打开')
  await app.js(`window.__h.click('新建定时任务')`)
  await app.waitFor(`!!document.querySelector('[data-testid="task-editor"]')`, '任务编辑器打开')
  await app.js(`window.__h.set(document.querySelector('[aria-label="任务名"]'), '每小时冒烟')`)
  await app.js(`(() => {
    const sel = document.querySelector('[aria-label="运行目标"]')
    const opt = [...sel.options].find((o) => o.innerText.includes('默认集合'))
    if (!opt) throw new Error('目标下拉里没有默认集合')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return opt.innerText
  })()`)
  report.taskEnvEmpty = await app.js(
    `document.querySelector('[aria-label="锁定环境"]')?.value ?? null`,
  )
  // 就地建环境：定时任务必须锁环境，界面不能逼用户先去导 Postman 环境
  await app.js(`window.__h.click('在目标项目下新建环境并选中')`)
  await app.waitFor(
    `document.querySelector('[aria-label="锁定环境"]')?.value !== ''`,
    '新建环境后自动选中',
  )
  report.taskEnvAfter = await app.js(
    `document.querySelector('[aria-label="锁定环境"]')?.value ?? null`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="cron 表达式"]'), '0 * * * *')`)
  await app.waitFor(
    `document.querySelectorAll('[data-testid="task-preview"] .pill').length === 5`,
    '未来 5 次触发预览',
  )
  report.taskPreview = await app.js(
    `[...document.querySelectorAll('[data-testid="task-preview"] .pill')].map((e) => e.innerText)`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="cron 表达式"]'), '* *')`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="task-preview"] .tapi-error')`,
    '非法表达式即时报错',
  )
  report.taskPreviewError = await app.js(
    `document.querySelector('[data-testid="task-preview"] .tapi-error')?.innerText ?? null`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="cron 表达式"]'), '0 * * * *')`)
  await app.waitFor(
    `document.querySelectorAll('[data-testid="task-preview"] .pill').length === 5`,
    '改回合法表达式后预览恢复',
  )
  // 每次落 JSON 报告，路径要出现在通知正文里（用户要的"报告返回系统通知"）
  await app.js(`(() => {
    const sel = document.querySelector('[aria-label="报告格式"]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'json')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return sel.value
  })()`)
  await app.js(`document.querySelector('[data-testid="task-save"]').click()`)
  await app.waitFor(
    `document.querySelectorAll('[data-testid="task-row"]').length === 1`,
    '任务进入列表',
  )
  report.taskRow = await app.js(
    `document.querySelector('[data-testid="task-row"]')?.textContent ?? null`,
  )
  if (!report.taskRow.includes('每小时冒烟') || !report.taskRow.includes('下次')) {
    throw new Error(`任务行缺少名称与下次触发：${report.taskRow}`)
  }
  await app.js(`window.__h.click('立即运行一次')`)
  await app.waitFor(
    `document.querySelector('[data-testid="notify-toast"]')?.textContent.includes('每小时冒烟') ?? false`,
    '任务结果 Toast 弹出',
    15000,
  )
  report.notifyToast = await app.js(
    `document.querySelector('[data-testid="notify-toast"]')?.textContent ?? null`,
  )
  await app.waitFor(
    `document.querySelector('[data-testid="task-row"]')?.innerText.includes('上次') ?? false`,
    '任务行记录上次运行',
  )
  report.taskRowAfterRun = await app.js(
    `document.querySelector('[data-testid="task-row"]')?.textContent ?? null`,
  )
  await app.js(`window.__h.click('通知中心')`)
  await app.waitFor(
    `document.querySelector('[data-testid="notify-drawer"]') !== null`,
    '通知抽屉（任务结果）打开',
  )
  report.taskNotifyItem = await app.js(
    `[...document.querySelectorAll('[data-testid="notify-item"]')].map((e) => e.textContent).find((t) => t.includes('每小时冒烟')) ?? null`,
  )
  if (!report.taskNotifyItem) throw new Error('定时任务结果没进通知中心')
  if (!report.taskNotifyItem.includes('2/2 通过') || !report.taskNotifyItem.includes('.json')) {
    throw new Error(`任务通知缺少通过率或报告路径：${report.taskNotifyItem}`)
  }
  const notifyShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-notify.png'), Buffer.from(notifyShot.data, 'base64'))
  await app.js(`document.querySelector('[aria-label="关闭通知中心"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="notify-drawer"]')`, '通知抽屉再次关闭')

  // ── 局域网节点（24 号文档 §7）：与本机自己的开放通道做真实加密配对 ──
  const openPort = Number(/:(\d+)/.exec(String(report.openSnippet ?? ''))?.[1] ?? 0) || 4730
  await app.js(`window.__h.click('局域网节点')`)
  await app.waitFor(`!!document.querySelector('[data-testid="node-pane"]')`, '节点面板打开')
  report.nodeSelf = await app.js(`(() => {
    const el = document.querySelector('[data-testid="node-self"]')
    return { text: el?.innerText ?? '', fp: el?.querySelector('.node-fp')?.innerText ?? '' }
  })()`)
  if (!report.nodeSelf.text.includes('本机可被配对')) {
    throw new Error(`开放通道已启用，本机视图却未显示可配对：${JSON.stringify(report.nodeSelf)}`)
  }
  if (!/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/.test(report.nodeSelf.fp)) {
    throw new Error(`本机指纹格式不对：${report.nodeSelf.fp}`)
  }
  await app.js(`window.__h.click('配对局域网里的另一台 ToAPI')`)
  await app.waitFor(`!!document.querySelector('[data-testid="node-editor"]')`, '节点配对对话框打开')
  report.nodeEditor = await app.js(`(() => {
    const host = document.querySelector('[aria-label="对端 IP 或主机名"]').getBoundingClientRect()
    return {
      pwType: document.querySelector('[aria-label="调用口令"]').type,
      hostWidth: Math.round(host.width),
      port: document.querySelector('[aria-label="对端端口"]').value
    }
  })()`)
  if (report.nodeEditor.pwType !== 'password') throw new Error('口令输入框没有掩码')
  if (report.nodeEditor.hostWidth < 120)
    throw new Error(`对端地址输入框只有 ${report.nodeEditor.hostWidth}px`)
  if (report.nodeEditor.port !== '4730')
    throw new Error(`端口默认值不是 4730：${report.nodeEditor.port}`)
  await app.js(`window.__h.set(document.querySelector('[aria-label="调用口令"]'), 'abc123')`)
  await app.waitFor(`!!document.querySelector('[data-testid="node-weak"]')`, '弱口令当场警告')
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="调用口令"]'), 'flow-verify-secret')`,
  )
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="对端 IP 或主机名"]'), '127.0.0.1')`,
  )
  await app.js(
    `window.__h.set(document.querySelector('[aria-label="对端端口"]'), '${String(openPort)}')`,
  )
  await app.js(`window.__h.set(document.querySelector('[aria-label="节点别名"]'), '自环节点')`)
  await app.js(`document.querySelector('[data-testid="node-save"]').click()`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="node-row"]')`,
    '加密握手后节点行出现',
    25000,
  )
  report.nodeRow = await app.js(
    `document.querySelector('[data-testid="node-row"]')?.innerText ?? ''`,
  )
  if (!report.nodeRow.includes('自环节点') || !report.nodeRow.includes('未确认')) {
    throw new Error(`节点行缺少别名或指纹状态：${report.nodeRow}`)
  }
  report.nodeActionsOpacity = await app.js(
    `getComputedStyle(document.querySelector('[data-testid="node-row"] .row-actions')).opacity`,
  )
  if (report.nodeActionsOpacity !== '1')
    throw new Error(`节点行内操作不可见：opacity=${report.nodeActionsOpacity}`)
  await app.js(`window.__h.click('两屏核对指纹一致后锁定')`)
  await app.waitFor(
    `document.querySelector('[data-testid="node-row"]')?.innerText.includes('已确认') ?? false`,
    '指纹确认后解锁写操作',
  )
  await app.js(`window.__h.click('拉取远端项目到本机')`)
  await app.waitFor(`!!document.querySelector('[data-testid="node-pull"]')`, '拉取向导打开')
  report.nodePull = await app.js(`(() => {
    const projects = [...document.querySelectorAll('[aria-label="远端项目"] option')].map((o) => o.innerText)
    return {
      projects,
      summary: document.querySelector('[data-testid="node-pull-summary"]')?.innerText ?? ''
    }
  })()`)
  if (report.nodePull.projects.length < 2)
    throw new Error(`远端项目清单为空：${JSON.stringify(report.nodePull)}`)
  if (!report.nodePull.summary.includes('密钥'))
    throw new Error(`拉取预览没提示密钥处理：${report.nodePull.summary}`)
  await app.js(
    `document.querySelector('[data-testid="node-pull"] .dialog-actions .pill.ghost').click()`,
  )
  await app.waitFor(`!document.querySelector('[data-testid="node-pull"]')`, '拉取向导关闭')
  await app.js(`window.__h.click('在该机器上代为运行')`)
  await app.waitFor(`!!document.querySelector('[data-testid="node-run"]')`, '代为测试向导打开')
  report.nodeRun = await app.js(`(() => ({
    scopes: [...document.querySelectorAll('[aria-label="运行范围"] option')].map((o) => o.innerText),
    envs: [...document.querySelectorAll('[aria-label="远端环境"] option')].map((o) => o.innerText),
    startDisabled: document.querySelector('[data-testid="node-run-go"]')?.disabled ?? null
  }))()`)
  if (report.nodeRun.scopes.length < 2)
    throw new Error(`远端集合结构没取到：${JSON.stringify(report.nodeRun.scopes)}`)
  if (report.nodeRun.envs.length < 2)
    throw new Error(`远端环境为空，代为测试无法锁环境：${JSON.stringify(report.nodeRun.envs)}`)
  if (report.nodeRun.startDisabled !== true) throw new Error('未选远端环境时「开始运行」必须禁用')
  const nodeShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-node.png'), Buffer.from(nodeShot.data, 'base64'))
  await app.js(
    `document.querySelector('[data-testid="node-run"] .dialog-actions .pill.ghost').click()`,
  )
  await app.waitFor(`!document.querySelector('[data-testid="node-run"]')`, '代为测试向导关闭')

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

  // ── 无边框窗口 + 自绘标题栏（06 号文档 §4）：仅 Windows ──
  // Linux/macOS/信创按 14 号文档保留系统原生装饰，界面不该出现自绘标题栏
  if (!IS_WINDOWS) {
    report.titlebarOnNonWindows = await app.js(
      `document.querySelector('[data-testid="titlebar"]') === null`,
    )
    if (report.titlebarOnNonWindows !== true) {
      throw new Error(`${process.platform} 下不应渲染自绘标题栏`)
    }
  } else {
    // Electron 未实现 CDP Browser.getWindowForTarget，改问 Win32 GetWindowPlacement
    const windowState = () => {
      try {
        return execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            resolve(root, 'scripts/window-state.ps1'),
            '-ProcessId',
            String(child.pid),
            '-Action',
            'state',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim()
      } catch {
        return 'no-window'
      }
    }
    const waitWindowState = async (expected, label) => {
      let last = ''
      for (let i = 0; i < 40; i++) {
        last = windowState()
        if (last === expected) return true
        await wait(150)
      }
      throw new Error(`窗口状态未变为 ${expected}（实际 ${last}）：${label}`)
    }

    await waitWindowState('normal', '初始窗口')
    report.windowInitial = windowState()
    report.titlebar = await app.js(`(() => {
    const bar = document.querySelector('[data-testid="titlebar"]')
    if (!bar) return null
    const controls = bar.querySelector('.titlebar-controls')
    return {
      height: Math.round(bar.getBoundingClientRect().height),
      drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      controlsDrag: getComputedStyle(controls).getPropertyValue('-webkit-app-region'),
      logo: (() => {
        const img = bar.querySelector('.brand-logo')
        if (!img) return null
        const r = img.getBoundingClientRect()
        return {
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      })(),
      buttons: [...controls.querySelectorAll('button')].map((b) => ({
        title: b.title,
        radius: getComputedStyle(b).borderRadius,
        width: Math.round(b.getBoundingClientRect().width),
        height: Math.round(b.getBoundingClientRect().height)
      }))
    }
  })()`)
    if (!report.titlebar) throw new Error('Windows 下未渲染自绘标题栏')
    if (report.titlebar.height !== 46)
      throw new Error(`标题栏高度不符：${report.titlebar.height}px`)
    if (report.titlebar.drag !== 'drag' || report.titlebar.controlsDrag !== 'no-drag') {
      throw new Error(`标题栏拖拽区不符：${JSON.stringify(report.titlebar)}`)
    }
    if (
      !report.titlebar.logo ||
      !report.titlebar.logo.complete ||
      report.titlebar.logo.naturalWidth < 64 ||
      report.titlebar.logo.width !== 24 ||
      report.titlebar.logo.height !== 24
    ) {
      throw new Error(`品牌 LOGO 未正确加载：${JSON.stringify(report.titlebar.logo)}`)
    }
    if (report.titlebar.buttons.length !== 3) {
      throw new Error(`窗口控件数量不符：${report.titlebar.buttons.length}`)
    }
    if (
      report.titlebar.buttons.some(
        (b) => b.radius !== '8px' || b.width !== 32 || b.height !== 28 || !b.title,
      )
    ) {
      throw new Error(`窗口控件规格不符：${JSON.stringify(report.titlebar.buttons)}`)
    }

    await app.js(`window.__h.click('最大化')`)
    await app.waitFor(`!!document.querySelector('.win-btn[title="还原"]')`, '最大化后图标切到还原')
    await waitWindowState('maximized', '标题栏最大化')
    report.windowMaximized = windowState()
    const maxShot = await app.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(root, '.tmp/toapi-titlebar.png'), Buffer.from(maxShot.data, 'base64'))

    await app.js(`window.__h.click('还原')`)
    await app.waitFor(
      `!!document.querySelector('.win-btn[title="最大化"]')`,
      '还原后图标切回最大化',
    )
    await waitWindowState('normal', '标题栏还原')
    report.windowRestored = windowState()

    await app.js(`window.__h.click('最小化')`)
    await waitWindowState('minimized', '标题栏最小化')
    report.windowMinimized = windowState()
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve(root, 'scripts/window-state.ps1'),
        '-ProcessId',
        String(child.pid),
        '-Action',
        'restore',
      ],
      { encoding: 'utf8' },
    )
    await waitWindowState('normal', 'Win32 恢复窗口')
    await app.waitFor(`!!document.querySelector('.win-btn[title="最大化"]')`, '恢复后标题栏可用')
  }

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

  // ── Postman 资产导入（23 号文档 §8、06 号文档 §3.7）──
  const collectionFixture = {
    info: {
      name: 'Postman 示例',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: [{ key: 'baseUrl', value: 'https://api.example.com', type: 'string' }],
    event: [
      {
        listen: 'prerequest',
        script: { exec: ["toapi.log('root')"], type: 'text/javascript' },
      },
    ],
    item: [
      {
        name: '健康检查',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: '{{baseUrl}}/health',
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: ["toapi.test('200', () => toapi.expect(toapi.response.status).toBe(200))"],
              type: 'text/javascript',
            },
          },
        ],
      },
      {
        name: '用户',
        item: [
          {
            name: '列表',
            request: {
              method: 'GET',
              header: [],
              url: {
                raw: '{{baseUrl}}/users?page=1',
                host: ['{{baseUrl}}'],
                path: ['users'],
                query: [{ key: 'page', value: '1' }],
              },
            },
            event: [],
          },
        ],
      },
    ],
  }
  const setPostmanContent = async (content) => {
    await app.js(
      `window.__h.set(document.querySelector('[data-testid="postman-content"]'), ${JSON.stringify(content)})`,
    )
  }

  await app.js(`window.__h.click('导入 Postman Collection / Environment')`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="postman-import"]')`,
    'Postman 导入框打开',
  )
  {
    const style = await app.js(`(() => {
      const d = document.querySelector('[data-testid="postman-import"]')
      const cs = getComputedStyle(d)
      const ta = getComputedStyle(document.querySelector('[data-testid="postman-content"]'))
      return {
        width: Math.round(d.getBoundingClientRect().width),
        radius: cs.borderRadius,
        shadow: cs.boxShadow,
        textareaRadius: ta.borderRadius,
        textareaBorder: ta.borderTopWidth,
        importDisabled: document.querySelector('[data-testid="postman-import-ok"]').disabled
      }
    })()`)
    report.postmanDialog = style
    if (
      style.width !== 580 ||
      style.radius !== '14px' ||
      style.shadow !== 'none' ||
      style.textareaRadius !== '10px' ||
      style.textareaBorder !== '1px'
    ) {
      throw new Error(`Postman 导入框规格不符：${JSON.stringify(style)}`)
    }
    if (!style.importDisabled) throw new Error('空内容时导入按钮应禁用')
  }

  await setPostmanContent(JSON.stringify(collectionFixture, null, 2))
  await app.waitFor(
    `document.querySelector('.postman-kind')?.innerText === 'Collection'`,
    '自动识别 Collection',
  )
  report.postmanPreview = await app.js(`(() => ({
    kind: document.querySelector('.postman-kind')?.innerText,
    name: document.querySelector('.postman-name')?.innerText,
    counts: document.querySelector('.postman-counts')?.innerText,
    modes: [...document.querySelectorAll('.postman-modes label')].map((e) => e.innerText),
    importDisabled: document.querySelector('[data-testid="postman-import-ok"]').disabled
  }))()`)
  if (
    report.postmanPreview.name !== 'Postman 示例' ||
    !String(report.postmanPreview.counts).includes('1 集合') ||
    !String(report.postmanPreview.counts).includes('2 接口') ||
    !report.postmanPreview.modes.includes('新建项目') ||
    report.postmanPreview.importDisabled
  ) {
    throw new Error(`Postman 预览不符：${JSON.stringify(report.postmanPreview)}`)
  }
  const dialogShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    resolve(root, '.tmp/toapi-postman-dialog.png'),
    Buffer.from(dialogShot.data, 'base64'),
  )
  await app.js(`document.querySelector('[data-testid="postman-import-ok"]').click()`)
  await app.waitFor(`!!document.querySelector('.toast')`, 'Postman Collection 导入返回', 20000)
  report.postmanToast = await app.js(`document.querySelector('.toast')?.innerText ?? null`)
  if (!String(report.postmanToast).includes('导入完成：2 集合 · 2 接口 · 1 变量')) {
    throw new Error(`Collection 导入结果不符：${report.postmanToast}`)
  }
  await app.waitFor(`!document.querySelector('[data-testid="postman-import"]')`, '导入框自动关闭')
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="project-"]')].some((e) => e.innerText.includes('Postman 示例'))`,
    '导入项目入树',
  )
  report.postmanToast = await app.js(`document.querySelector('.toast')?.innerText ?? null`)

  await app.js(`(() => {
    const row = [...document.querySelectorAll('[data-testid^="project-"]')].find((e) => e.innerText.includes('Postman 示例'))
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }))
    return true
  })()`)
  await app.waitFor(`!!document.querySelector('[data-testid="context-menu"]')`, '项目菜单打开')
  report.postmanMenu = await app.js(
    `[...document.querySelectorAll('[data-testid="context-menu"] button')].map((b) => b.innerText)`,
  )
  if (
    !report.postmanMenu.includes('导入 Postman…') ||
    !report.postmanMenu.includes('导出为 Postman Collection…')
  ) {
    throw new Error(`项目菜单缺少 Postman 项：${JSON.stringify(report.postmanMenu)}`)
  }
  await app.js(`window.__h.key('Escape')`)
  await app.waitFor(`!document.querySelector('[data-testid="context-menu"]')`, '项目菜单关闭')

  // 再次导入同名集合：应弹出导入报告（23 号文档 §3.6、§8）
  await app.js(`window.__h.click('导入 Postman Collection / Environment')`)
  await app.waitFor(`!!document.querySelector('[data-testid="postman-import"]')`, '再次打开导入框')
  await setPostmanContent(JSON.stringify(collectionFixture, null, 2))
  await app.waitFor(
    `document.querySelector('.postman-kind')?.innerText === 'Collection'`,
    '再次识别',
  )
  await app.js(`document.querySelector('[data-testid="postman-import-ok"]').click()`)
  await app.waitFor(
    `!!document.querySelector('[data-testid="postman-report"]')`,
    '导入报告弹出',
    20000,
  )
  report.postmanReport = await app.js(`(() => ({
    text: document.querySelector('[data-testid="postman-report"]')?.innerText,
    warnings: document.querySelectorAll('[data-testid="postman-report"] .postman-warnings li').length
  }))()`)
  if (
    !String(report.postmanReport.text).includes('导入报告') ||
    !String(report.postmanReport.text).includes('条提示') ||
    report.postmanReport.warnings < 1
  ) {
    throw new Error(`导入报告不符：${JSON.stringify(report.postmanReport)}`)
  }
  await app.js(`document.querySelector('[data-testid="postman-report-done"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="postman-report"]')`, '导入报告关闭')
  await app.waitFor(
    `[...document.querySelectorAll('[data-testid^="project-"]')].some((e) => e.innerText.includes('Postman 示例 (2)'))`,
    '同名项目去重入树',
  )

  // Environment 导入：底栏按钮 → 自动识别 → 写入当前项目
  const environmentFixture = {
    id: 'env-postman-demo',
    name: 'Postman 演示',
    values: [
      { key: 'baseUrl', value: 'https://demo.example.com', type: 'default', enabled: true },
      { key: 'token', value: 'secret', type: 'secret', enabled: false },
    ],
    _postman_variable_scope: 'environment',
  }
  await app.js(`window.__h.click('导入 Postman Environment…')`)
  await app.waitFor(`!!document.querySelector('[data-testid="postman-import"]')`, '环境导入框打开')
  await setPostmanContent(JSON.stringify(environmentFixture, null, 2))
  await app.waitFor(
    `document.querySelector('.postman-kind')?.innerText === 'Environment'`,
    '自动识别 Environment',
  )
  report.postmanEnvPreview = await app.js(`(() => ({
    counts: document.querySelector('.postman-counts')?.innerText,
    overwrite: document.querySelector('.postman-overwrite')?.innerText,
    modes: document.querySelectorAll('.postman-modes').length
  }))()`)
  if (
    !String(report.postmanEnvPreview.counts).includes('2 变量') ||
    !String(report.postmanEnvPreview.overwrite).includes('同名环境覆盖变量') ||
    report.postmanEnvPreview.modes !== 0
  ) {
    throw new Error(`Environment 预览不符：${JSON.stringify(report.postmanEnvPreview)}`)
  }
  await app.js(`document.querySelector('[data-testid="postman-import-ok"]').click()`)
  await app.waitFor(
    `document.querySelector('.toast')?.innerText.includes('导入完成：0 集合 · 0 接口 · 2 变量')`,
    'Postman Environment 导入完成',
    20000,
  )
  await app.waitFor(
    `[...document.querySelectorAll('.statusbar option')].some((o) => o.innerText === 'Postman 演示')`,
    '环境进入底栏下拉',
  )
  report.postmanEnvOption = await app.js(
    `[...document.querySelectorAll('.statusbar option')].filter((o) => o.innerText === 'Postman 演示').length`,
  )

  const postmanShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-postman.png'), Buffer.from(postmanShot.data, 'base64'))

  report.runtimeErrorsRound2 = app.errors

  // ── 通知设置与关窗语义（15 号文档 §4、14 号文档 §3.1）──
  // 顺序要紧：Linux 关窗即退出，所以设置面板必须在窗口还开着时验完
  const closeWindow = async () => {
    if (IS_WINDOWS) await app.js(`window.__h.click('关闭 (Alt+F4)')`)
    else await app.js(`window.close()`)
  }
  const openNotifySettings = async (label) => {
    await app.js(`window.__h.key('k', { ctrlKey: true })`)
    await app.waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, label)
    await app.js(`window.__h.set(document.querySelector('[aria-label="命令"]'), '通知设置')`)
    await app.waitFor(
      `[...document.querySelectorAll('[data-testid="palette-item"]')].some((e) => e.innerText.includes('通知设置'))`,
      '命令面板能找到通知设置',
    )
    await app.js(
      `document.querySelector('[aria-label="命令"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
    )
    await app.waitFor(`!!document.querySelector('[data-testid="notify-settings"]')`, '通知设置打开')
  }

  await openNotifySettings('命令面板（托盘设置）打开')
  report.traySettingBefore = await app.js(
    `document.querySelector('[data-testid="notify-tray"]')?.checked ?? null`,
  )
  if (report.traySettingBefore !== TRAY_BY_DEFAULT) {
    throw new Error(`托盘驻留默认值在 ${process.platform} 上应为 ${TRAY_BY_DEFAULT}`)
  }
  report.notifyMatrix = await app.js(`(() => {
    const rows = [...document.querySelectorAll('.notify-matrix tbody tr')]
    return {
      rowCount: rows.length,
      cells: rows[0].querySelectorAll('input[type=checkbox]').length
    }
  })()`)
  if (report.notifyMatrix.rowCount !== 7 || report.notifyMatrix.cells !== 4) {
    throw new Error(`订阅矩阵不是 7 事件 × 4 通道：${JSON.stringify(report.notifyMatrix)}`)
  }
  await app.js(`document.querySelector('[data-testid="notify-close"]').click()`)
  await app.waitFor(`!document.querySelector('[data-testid="notify-settings"]')`, '通知设置关闭')

  if (TRAY_BY_DEFAULT) {
    // 默认开：关窗收进托盘，进程必须活着
    await closeWindow()
    await wait(700)
    report.closeToTrayAlive = child?.exitCode === null
    if (!report.closeToTrayAlive) throw new Error('关窗应驻留托盘而不是退出进程')
    if (!IS_WINDOWS) {
      // macOS 隐藏窗口后 CDP 不再可靠（系统会降频窗口进程），且关窗不退进程是 mac 语义，
      // 所以这里只验到"托盘驻留成功"，不再驱动界面；主进程定时任务由
      // prevent-app-suspension 保住准点（electron/desktop/tray.ts）
      report.macResidentOnly = true
    } else {
      report.closeToTrayHidden = await app.js(`document.visibilityState`)
      if (report.closeToTrayHidden !== 'hidden') {
        throw new Error(`关窗后页面未转入后台：visibilityState=${report.closeToTrayHidden}`)
      }
      // Windows 下隐藏窗口的渲染进程仍在跑，可以在后台改设置再验证真退出
      await openNotifySettings('命令面板（隐藏窗口下）打开')
      await app.js(`document.querySelector('[data-testid="notify-tray"]').click()`)
      await app.waitFor(
        `document.querySelector('[data-testid="notify-tray"]')?.checked === false`,
        '托盘设置已关闭',
      )
      await app.js(`document.querySelector('[data-testid="notify-close"]').click()`)
      await closeWindow()
      await wait(1500)
      report.closedExitsProcess = child?.exitCode !== null
      if (!report.closedExitsProcess) throw new Error('关闭托盘驻留后，关窗应直接退出进程')
    }
  } else {
    await closeWindow()
    await wait(1500)
    report.closedExitsProcess = child?.exitCode !== null
    if (!report.closedExitsProcess) throw new Error('Linux 下关窗应直接退出进程')
  }
  app.ws.close()
} finally {
  clearTimeout(watchdog)
  await closeApp()
  echo.close()
}

report.screenshots = [
  '.tmp/toapi-flow-1.png',
  '.tmp/toapi-flow-2.png',
  '.tmp/toapi-select.png',
  '.tmp/toapi-titlebar.png',
  '.tmp/toapi-postman.png',
  '.tmp/toapi-postman-dialog.png',
  '.tmp/toapi-notify.png',
]
console.log(JSON.stringify(report, null, 2))
