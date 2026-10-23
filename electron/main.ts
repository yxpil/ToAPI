import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { createKernel, userDataPaths, type Kernel } from './kernel'
import { registerAll } from './ipc/router'
import { createLogger } from './infra/logger'

const log = createLogger('main')
const devUrl = process.env.VITE_DEV_SERVER_URL

let win: BrowserWindow | null = null
let kernel: Kernel | null = null

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
    emit: (channel, payload) => win?.webContents.send(channel, payload),
  })
  registerAll(ipcMain, { hello: kernel.hello, handlers: kernel.handlers })
  log.info('kernel ready', kernel.hello)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  kernel?.dispose()
  kernel = null
})
