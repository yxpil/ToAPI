// @author yxpil
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = 9333
const profile = resolve(root, '.tmp/e2e-profile')
mkdirSync(profile, { recursive: true })
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const child = spawn(
  electronBin,
  ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)

const stderr = []
child.stderr.on('data', (d) => stderr.push(String(d)))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 调试端口尚未就绪 */
    }
    await wait(500)
  }
  throw new Error('未找到 Electron 调试目标')
}

const cdp = (ws) => {
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  return {
    events,
    send: (method, params = {}) =>
      new Promise((r, rej) => {
        const mid = ++id
        pending.set(mid, { resolve: r, reject: rej })
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
  }
}

const report = {}
try {
  const target = await findTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  const client = cdp(ws)

  await client.send('Runtime.enable')
  await client.send('Log.enable')
  await client.send('Page.enable')

  // 等待应用完成一次 IPC 往返（app:hello 写入状态栏）
  for (let i = 0; i < 20; i++) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'document.querySelector(".statusbar")?.innerText?.includes("v0.1.0") ?? false',
      returnByValue: true,
    })
    if (result.value === true) break
    await wait(500)
  }

  const evalOf = async (expression) => {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
    return result.value
  }

  report.title = await evalOf('document.title')
  report.rootChildren = await evalOf('document.getElementById("root")?.childElementCount ?? 0')
  report.layoutCells = await evalOf('document.querySelectorAll(".app > *").length')
  report.treeRows = await evalOf('document.querySelectorAll(".tree-row").length')
  report.pillCount = await evalOf('document.querySelectorAll(".pill").length')
  report.urlCapsule = await evalOf('!!document.querySelector(".url-capsule")')
  report.statusBar = await evalOf('document.querySelector(".statusbar")?.innerText ?? ""')
  report.emptyState = await evalOf('document.querySelector(".empty")?.innerText ?? null')
  report.svgIcons = await evalOf('document.querySelectorAll("svg.icon").length')
  report.emojiInDom = await evalOf(
    '(document.body.innerText.match(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu) || []).length',
  )
  report.pillRadius = await evalOf(
    'getComputedStyle(document.querySelector(".pill") || document.body).borderRadius',
  )
  report.bodyBg = await evalOf('getComputedStyle(document.body).backgroundColor')
  report.consoleIssues = client.events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => ({ level: e.params.entry.level, text: String(e.params.entry.text).slice(0, 200) }))
    .filter((i) => i.level === 'error' || i.level === 'warning')

  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(root, '.tmp/toapi-m1.png'), Buffer.from(shot.data, 'base64'))
  report.screenshot = '.tmp/toapi-m1.png'
  ws.close()
} finally {
  child.kill()
}

report.electronStderr = stderr.join('').slice(0, 800)
console.log(JSON.stringify(report, null, 2))
