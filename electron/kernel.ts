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
import { channelsHashOf, type HandlerMap } from './ipc/router'
import { buildHandlers } from './ipc/handlers'
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

  const handlers = buildHandlers({ repos, flow, runner, cancel, hello, dbSize })

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
    hello,
    handlers,
    invoke,
    dispose: () => {
      engine.close()
      db.close()
    },
  }
}

export const userDataPaths = (userDataDir: string): { dbPath: string; filesDir: string } => ({
  dbPath: join(userDataDir, 'toapi.db'),
  filesDir: userDataDir,
})
