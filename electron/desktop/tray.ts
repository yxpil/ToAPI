// @author yxpil
import { Menu, Notification, Tray, nativeImage, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kernel } from '../kernel'
import type { DesktopHooks } from '../notify/service'
import { createLogger } from '../infra/logger'

/**
 * 托盘驻留与 OS 通知（15 号文档 §4）：关窗最小化到托盘，error 未读叠加红点，
 * 菜单给出最近通知摘要与「立即运行任务」。图标位图由应用标识缩放后像素级绘制，不用 emoji。
 */

const log = createLogger('tray')
const TRAY_SIZE = 16
/** BGRA 红点，与界面 --err 同色系 */
const BADGE: [number, number, number, number] = [47, 58, 196, 255]

export interface Desktop {
  hooks: DesktopHooks
  showNotification(title: string, body: string, silent: boolean): void
  refresh(): void
  dispose(): void
}

const iconPath = (): string => join(__dirname, '../electron/assets/icon.png')

const appImage = (): Electron.NativeImage => {
  try {
    return nativeImage.createFromBuffer(readFileSync(iconPath()))
  } catch (e) {
    log.error(`托盘图标读取失败：${(e as Error).message}`)
    return nativeImage.createEmpty()
  }
}

const withBadge = (base: Electron.NativeImage): Electron.NativeImage => {
  const resized = base.resize({ width: TRAY_SIZE, height: TRAY_SIZE })
  const bitmap = resized.toBitmap()
  const radius = Math.max(3, Math.round(TRAY_SIZE * 0.3))
  const cx = TRAY_SIZE - radius - 1
  const cy = TRAY_SIZE - radius - 1
  for (let y = 0; y < TRAY_SIZE; y += 1) {
    for (let x = 0; x < TRAY_SIZE; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
      const offset = (y * TRAY_SIZE + x) * 4
      bitmap.writeUInt32LE(BADGE[0] | (BADGE[1] << 8) | (BADGE[2] << 16) | (BADGE[3] << 24), offset)
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: TRAY_SIZE, height: TRAY_SIZE })
}

interface Options {
  getWindow: () => BrowserWindow | null
  kernel: Kernel
  isQuitting: () => boolean
  quit: () => void
}

export function createDesktop(options: Options): Desktop {
  const base = appImage()
  let tray: Tray | null = null
  try {
    tray = new Tray(base)
  } catch (e) {
    log.error(`托盘创建失败：${(e as Error).message}`)
  }

  const showWindow = (): void => {
    const win = options.getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const menuTemplate = (): Electron.MenuItemConstructorOptions[] => {
    const kernel = options.kernel
    const recent = kernel.notify.recent(3)
    const tasks = kernel.schedule.list().filter((t) => t.enabled)
    return [
      { label: '打开 ToAPI', click: showWindow },
      { type: 'separator' },
      ...(recent.length === 0
        ? [{ label: '最近没有通知', enabled: false }]
        : recent.map((n) => ({
            label: `${n.title}${n.count > 1 ? `（${n.count}）` : ''}`.slice(0, 60),
            click: showWindow,
          }))),
      { type: 'separator' },
      {
        label: '立即运行任务',
        submenu:
          tasks.length === 0
            ? [{ label: '还没有定时任务', enabled: false }]
            : tasks.map((task) => ({
                label: task.name.slice(0, 40),
                click: () => {
                  void kernel.schedule
                    .runNow(task.id)
                    .catch((e: Error) => log.error(`任务立即运行失败：${e.message}`))
                },
              })),
      },
      { type: 'separator' },
      { label: '退出 ToAPI', click: options.quit },
    ]
  }

  const refresh = (): void => {
    if (!tray) return
    tray.setImage(options.kernel.notify.unreadError() ? withBadge(base) : base)
    tray.setToolTip('ToAPI')
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
  }

  const showNotification = (title: string, body: string, silent: boolean): void => {
    try {
      const notification = new Notification({ title, body, silent })
      notification.on('click', showWindow)
      notification.show()
    } catch (e) {
      log.error(`系统通知发送失败：${(e as Error).message}`)
    }
  }

  const hooks: DesktopHooks = {
    show: showNotification,
    isFront: () => {
      const win = options.getWindow()
      return Boolean(win && win.isVisible() && win.isFocused() && !win.isMinimized())
    },
  }

  /** 关闭窗口 → 收进托盘；真正退出由托盘菜单或 app.quit 走 isQuitting 分支 */
  const win = options.getWindow()
  win?.on('close', (event) => {
    if (options.isQuitting()) return
    if (!options.kernel.notify.settings().closeToTray) return
    event.preventDefault()
    win.hide()
    refresh()
  })

  tray?.on('click', () => showWindow())
  refresh()

  return {
    hooks,
    showNotification,
    refresh,
    dispose: () => {
      tray?.destroy()
      tray = null
    },
  }
}
