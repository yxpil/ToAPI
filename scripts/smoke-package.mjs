import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 打包产物冒烟（14 号文档 §3.3 发版门禁）：
 * 用独立 user-data-dir 启动已打包的 exe，验证握手、渲染与无脚本错误。
 * 用法：node scripts/smoke-package.mjs <exe 路径>
 */
const exeArg = process.argv[2]
if (!exeArg) {
  console.error('用法: node scripts/smoke-package.mjs <path-to-ToAPI.exe>')
  process.exit(2)
}
const safeRm = (p) => {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* 进程尚未完全退出，临时目录留给下次清理 */
  }
}

const exe = resolve(exeArg)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const port = 9336
const profile = resolve(root, '.tmp/smoke-profile')

safeRm(profile)
mkdirSync(profile, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(
  exe,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-sandbox'],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
const stderr = []
child.stderr.on('data', (d) => stderr.push(String(d)))

const fail = (message) => {
  console.error(`SMOKE FAIL: ${message}`)
  child.kill()
  process.exit(1)
}

let target = null
for (let i = 0; i < 60 && !target; i++) {
  await wait(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = list.find((t) => t.type === 'page')
  } catch {
    /* 未就绪 */
  }
}
if (!target) fail(`调试端口未就绪；stderr: ${stderr.join('').slice(0, 500)}`)

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
    errors.push(String(msg.params.entry.text).slice(0, 200))
  }
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const js = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.value
}

await send('Runtime.enable')
await send('Log.enable')

let handshake = false
for (let i = 0; i < 40 && !handshake; i++) {
  handshake = await js(
    `document.querySelector('.statusbar')?.innerText.includes('v${version}') ?? false`,
  )
  if (!handshake) await wait(500)
}

const report = {
  exe,
  title: await js(`document.title`),
  rootChildren: await js(`document.getElementById('root')?.childElementCount ?? 0`),
  handshake,
  statusBar: await js(
    `document.querySelector('.statusbar')?.innerText.replace(/\\n/g, ' ') ?? null`,
  ),
  pillRadius: await js(
    `document.querySelector('.pill') ? getComputedStyle(document.querySelector('.pill')).borderRadius : null`,
  ),
  titlebar: await js(`(() => {
    const bar = document.querySelector('[data-testid="titlebar"]')
    if (!bar) return null
    return {
      height: Math.round(bar.getBoundingClientRect().height),
      buttons: bar.querySelectorAll('.win-btn').length,
      logo: (() => {
        const img = bar.querySelector('.brand-logo')
        return img ? { complete: img.complete, naturalWidth: img.naturalWidth } : null
      })()
    }
  })()`),
  panels: await js(`(() => {
    const radius = (sel) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).borderRadius : null
    }
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      tree: radius('.tree'),
      editor: radius('.workspace'),
      response: radius('.response-col')
    }
  })()`),
  svgIcons: await js(`document.querySelectorAll('svg.icon').length`),
  emojiInDom: await js(
    `(document.body.innerText.match(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu) || []).length`,
  ),
  pageErrors: errors.slice(0, 5),
}

ws.close()
child.kill()

const ok =
  report.handshake &&
  report.rootChildren > 0 &&
  report.pageErrors.length === 0 &&
  report.emojiInDom === 0 &&
  report.panels?.canvas === 'rgb(242, 242, 244)' &&
  report.panels?.tree === '14px' &&
  report.panels?.editor === '14px' &&
  report.panels?.response === '14px' &&
  report.titlebar?.height === 46 &&
  report.titlebar?.buttons === 3 &&
  report.titlebar?.logo?.complete === true &&
  report.titlebar?.logo?.naturalWidth > 0
console.log(JSON.stringify({ ...report, verdict: ok ? 'PASS' : 'FAIL' }, null, 2))

await wait(1500)
safeRm(profile)
process.exit(ok ? 0 : 1)
