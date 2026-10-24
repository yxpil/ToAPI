// @author yxpil
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKernel, userDataPaths, type Kernel } from './kernel'
import { registerAll } from './ipc/router'
import { createDesktop, type Desktop } from './desktop/tray'
import { closeToTraySupported } from './notify/service'
import { createLogger } from './infra/logger'

const log = createLogger('main')
const devUrl = process.env.VITE_DEV_SERVER_URL
/** Windows 用无边框窗口 + 自绘标题栏（06 号文档 §4）；其他平台保留系统原生装饰 */
const FRAMELESS = process.platform === 'win32'

let win: BrowserWindow | null = null
let kernel: Kernel | null = null
let desktop: Desktop | null = null
/** 只有托盘菜单与 app.quit 才是真退出，关窗按设置收进托盘（15 号文档 §4） */
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function createWindow(): void {
  win = new BrowserWindow({
    title: 'ToAPI',
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#FFFFFF',
    icon: join(__dirname, '../electron/assets/icon.png'),
    frame: !FRAMELESS,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 拖拽区双击与 Win+↑ 等系统路径也会改变最大化状态，统一回推给标题栏
  const emitWindowState = (): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('event:window-state', { maximized: win.isMaximized() })
    }
  }
  win.on('maximize', emitWindowState)
  win.on('unmaximize', emitWindowState)
  win.on('closed', () => {
    win = null
  })

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }
}

void app.whenReady().then(() => {
  const userDataDir = app.getPath('userData')
  const { dbPath, filesDir } = userDataPaths(userDataDir)
  kernel = createKernel({
    dbPath,
    filesDir,
    appVersion: app.getVersion(),
    scriptWorkerPath: join(__dirname, 'script-worker.cjs'),
    emit: (channel, payload) => win?.webContents.send(channel, payload),
    window: {
      minimize: () => win?.minimize(),
      toggleMaximize: () => {
        if (!win) return false
        const next = !win.isMaximized()
        if (next) win.maximize()
        else win.unmaximize()
        return next
      },
      close: () => win?.close(),
      isMaximized: () => win?.isMaximized() ?? false,
    },
    dialogs: {
      saveText: async (defaultName, content, filters) => {
        const result = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('documents'), defaultName),
          filters: [{ name: 'ToAPI', extensions: filters ?? ['json'] }],
        })
        if (result.canceled || !result.filePath) return null
        writeFileSync(result.filePath, content, 'utf8')
        return result.filePath
      },
    },
    // 托盘在窗口建好后才创建，这里先挂转发器，避免内核与桌面层互相依赖
    desktop: {
      show: (title, body, silent) => desktop?.showNotification(title, body, silent),
      isFront: () => desktop?.hooks.isFront() ?? false,
    },
    onNotification: () => desktop?.refresh(),
    closeToTrayByDefault: closeToTraySupported(process.platform),
  })
  registerAll(ipcMain, { hello: kernel.hello, handlers: kernel.handlers })
  log.info('kernel ready', kernel.hello)

  // 开放通道：配置里开着就随应用启动监听（11 号文档 §1）；MCP stdio 走 `toapi mcp`（无头 CLI）
  void kernel
    .syncOpenEndpoint()
    .then((state) => {
      if (state.running) log.info(`开放通道已监听 ${kernel?.http.address ?? state.port}`)
    })
    .catch((e: Error) => log.error(`开放通道启动失败：${e.message}`))
  createWindow()
  if (kernel) {
    desktop = createDesktop({
      getWindow: () => win,
      kernel,
      isQuitting: () => quitting,
      quit: () => {
        quitting = true
        app.quit()
      },
    })
    // 定时任务调度随应用启动；无头 CLI 不启动，避免与 GUI 抢同一套 DB
    kernel.schedule.start()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  desktop?.dispose()
  desktop = null
  kernel?.dispose()
  kernel = null
})
