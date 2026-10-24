// @author yxpil
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, userVersion, type Db } from './db/database'
import { createRepos, type Repos } from './db/repo'
import { FileStore } from './infra/filestore'
import { CancelRegistry } from './infra/cancel-registry'
import { HttpEngine } from './http/engine'
import { RequestFlow } from './flow/request'
import { RunnerFlow } from './flow/runner'
import { ScriptVM } from './script/vm'
import { PostmanService, type PostmanDialogs } from './postman/service'
import { TapiService, type TapiDialogs } from './tapi/service'
import { OpenService } from './open/service'
import { LocalHttpApi } from './open/http-api'
import { mcpOverHttp } from './open/mcp'
import { channelsHashOf, type HandlerMap } from './ipc/router'
import { buildHandlers, type WindowControls } from './ipc/handlers'
import { IpcErrorRaised } from '@shared/types'
import type { AppHello, ChannelName, EventName, EventPayload, ReqOf, ResOf } from '@shared/channels'

export interface Kernel {
  db: Db
  repos: Repos
  engine: HttpEngine
  cancel: CancelRegistry
  flow: RequestFlow
  runner: RunnerFlow
  script: ScriptVM | null
  files: FileStore
  postman: PostmanService
  tapi: TapiService
  open: OpenService
  http: LocalHttpApi
  /** 按配置起停 Local HTTP API；返回当前监听状态（11 号文档 §1.1） */
  syncOpenEndpoint: () => Promise<{ running: boolean; port: number }>
  hello: AppHello
  handlers: HandlerMap
  invoke: <K extends ChannelName>(channel: K, req: ReqOf<K>) => Promise<ResOf<K>>
  dispose: () => void
}

export interface KernelOptions {
  /** sqlite 文件路径，传 ':memory:' 得到纯内存库 */
  dbPath: string
  /** 大响应体与报告的落盘根目录 */
  filesDir: string
  appVersion: string
  /** 脚本 worker bundle 路径；缺省则禁用脚本引擎（纯请求链路仍可用） */
  scriptWorkerPath?: string
  /** 无窗口场景（集成测试、无头 CLI）不下发事件 */
  emit?: (channel: string, payload: unknown) => void
  /** 无边框窗口控制；无窗口场景不注入，window:* 通道为空实现 */
  window?: WindowControls
  /** 导出文件保存 / 导入文件选择对话框；无窗口场景不注入，仅支持显式 filePath 与 content */
  dialogs?: PostmanDialogs & TapiDialogs
  /**
   * 无 GUI 模式（`toapi mcp`）：调用密码即授权，不弹授权条；host 越界一律拒绝。
   * GUI 与集成测试保持 false（默认），走用户确认。
   */
  headless?: boolean
}

/** 主进程能力内核：与 BrowserWindow / electron API 解耦，集成测试可直接驱动（17 号文档 §1） */
export function createKernel(options: KernelOptions): Kernel {
  const db = openDatabase(options.dbPath)
  const files = new FileStore(options.filesDir)
  const engine = new HttpEngine()
  const cancel = new CancelRegistry()
  const repos = createRepos(db)
  const emit = <K extends EventName>(channel: K, payload: EventPayload<K>): void =>
    options.emit?.(channel, payload)

  const script = options.scriptWorkerPath
    ? new ScriptVM({ workerPath: options.scriptWorkerPath })
    : null
  const flow = new RequestFlow({ engine, files, cancel, repos, emit, script: script ?? undefined })
  const runner = new RunnerFlow({ repos, flow, cancel, emit })
  const postman = new PostmanService({ db, repos, dialogs: options.dialogs })
  const tapi = new TapiService({
    db,
    repos,
    appVersion: () => options.appVersion,
    dialogs: options.dialogs,
  })

  let cancelSeq = 0
  const open = new OpenService({
    repos,
    flow,
    runner,
    appVersion: options.appVersion,
    newCancelId: () => `open-${String(++cancelSeq)}-${Date.now().toString(36)}`,
    headless: options.headless,
    emit: (channel, payload) => emit(channel, payload),
  })
  const http = new LocalHttpApi({
    service: open,
    appVersion: options.appVersion,
    onMcp: (body, meta, secret) =>
      mcpOverHttp(body, {
        service: open,
        appVersion: options.appVersion,
        secret,
        clientName: meta.clientName ?? meta.client,
      }),
  })

  const syncOpenEndpoint = async (): Promise<{ running: boolean; port: number }> => {
    const enabled = open.config.isEnabled()
    if (!enabled) {
      await http.stop()
      open.setRunning(false)
      return { running: false, port: 0 }
    }
    const host = open.config.access() === 'lan' ? '0.0.0.0' : '127.0.0.1'
    try {
      const port = await http.start(host, open.config.port())
      open.setRunning(true, port)
      return { running: true, port }
    } catch (e) {
      await http.stop()
      open.setRunning(false)
      throw new IpcErrorRaised({
        code: 'INTERNAL',
        message: `监听 ${host}:${open.config.port()} 失败：${(e as Error).message}`,
      })
    }
  }

  const dbSize = (): number => {
    if (options.dbPath === ':memory:') return 0
    try {
      return statSync(options.dbPath).size
    } catch {
      return 0
    }
  }

  const hello: AppHello = {
    mainVersion: options.appVersion,
    schemaVersion: userVersion(db),
    channelsHash: channelsHashOf(),
    platform: process.platform,
    dbSizeBytes: dbSize(),
  }

  const handlers = buildHandlers({
    repos,
    flow,
    runner,
    cancel,
    hello,
    dbSize,
    postman,
    tapi,
    open,
    syncOpenEndpoint,
    window: options.window,
  })

  const invoke = async <K extends ChannelName>(channel: K, req: ReqOf<K>): Promise<ResOf<K>> =>
    (handlers[channel] as (r: ReqOf<K>) => ResOf<K> | Promise<ResOf<K>>)(req)

  return {
    db,
    repos,
    engine,
    cancel,
    flow,
    runner,
    script,
    files,
    postman,
    tapi,
    open,
    http,
    syncOpenEndpoint,
    hello,
    handlers,
    invoke,
    dispose: () => {
      void http.stop()
      engine.close()
      db.close()
    },
  }
}

export const userDataPaths = (userDataDir: string): { dbPath: string; filesDir: string } => ({
  dbPath: join(userDataDir, 'toapi.db'),
  filesDir: userDataDir,
})
