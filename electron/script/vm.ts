import { Worker } from 'node:worker_threads'
import type { AssertionResult, FakeConfig, LogEntry } from '@shared/types'
import type {
  HostToWorker,
  ScriptJob,
  ScriptRequest,
  ScriptVarScope,
  SubRequestCall,
  SubRequestResult,
  WorkerToHost,
} from './protocol'

export interface ScriptOutcome {
  /** pre 阶段脚本可改写的请求（沙箱视图） */
  request?: ScriptRequest
  fakePatch: FakeConfig
  assertions: AssertionResult[]
  logs: LogEntry[]
  /** 脚本内 toapi.vars.set 的运行时变量 */
  runtimeWrites: Record<string, string>
  /** 脚本内 pm.variables.set 的请求级 local 变量 */
  localWrites: Record<string, string>
  /** pm.execution.setNextRequest：字符串跳转、null 结束本轮；未调用时缺省 */
  nextRequest?: string | null
  skip?: string
  error?: { code: 'SCRIPT_ERROR' | 'SCRIPT_TIMEOUT'; message: string }
}

export interface RunHooks {
  subRequest: (call: SubRequestCall) => Promise<SubRequestResult>
  varWrite: (scope: ScriptVarScope, key: string, value: string, collectionId?: string) => void
  varUnset: (scope: ScriptVarScope, key: string, collectionId?: string) => void
  cookieWrite: (op: 'set' | 'unset', name: string, value?: string) => void
}

export interface ScriptVMOpts {
  workerPath: string
  timeoutMs?: number
  memoryLimitMb?: number
}

const EMPTY: ScriptOutcome = {
  fakePatch: {},
  assertions: [],
  logs: [],
  runtimeWrites: {},
  localWrites: {},
}

/**
 * 沙箱宿主：用户代码跑在独立 worker 线程内的 vm 上下文中。
 * 双层隔离 —— vm 切断 require/process/fetch 等全局，worker.terminate 兜住异步阶段的死循环。
 * （isolated-vm 缺 Electron 45 / abi150 预编译，见 02 号文档 §1 的选型说明）
 */
export class ScriptVM {
  private readonly timeoutMs: number
  private readonly memoryLimitMb: number

  constructor(private readonly opts: ScriptVMOpts) {
    this.timeoutMs = opts.timeoutMs ?? 5_000
    this.memoryLimitMb = opts.memoryLimitMb ?? 128
  }

  async run(job: ScriptJob, hooks: RunHooks): Promise<ScriptOutcome> {
    if (!job.code.trim()) return EMPTY

    const logs: LogEntry[] = []
    const worker = new Worker(this.opts.workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: this.memoryLimitMb },
      execArgv: [],
    })

    return new Promise<ScriptOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: ScriptOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.removeAllListeners()
        void worker.terminate()
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        finish({
          ...EMPTY,
          logs,
          error: { code: 'SCRIPT_TIMEOUT', message: `脚本超过 ${this.timeoutMs}ms 已熔断` },
        })
      }, this.timeoutMs)

      worker.on('message', (msg: WorkerToHost) => {
        switch (msg.type) {
          case 'log':
            logs.push({ level: msg.level, text: msg.text, ts: Date.now() })
            return
          case 'subRequest':
            hooks
              .subRequest(msg.call)
              .then((result) =>
                worker.postMessage({
                  type: 'subResponse',
                  id: msg.id,
                  ok: true,
                  result,
                } satisfies HostToWorker),
              )
              .catch((e: Error) =>
                worker.postMessage({
                  type: 'subResponse',
                  id: msg.id,
                  ok: false,
                  error: e.message,
                } satisfies HostToWorker),
              )
            return
          case 'varWrite':
          case 'varUnset':
            try {
              if (msg.type === 'varWrite')
                hooks.varWrite(msg.scope, msg.key, msg.value, msg.collectionId)
              else hooks.varUnset(msg.scope, msg.key, msg.collectionId)
              worker.postMessage({ type: 'varWriteAck', id: msg.id } satisfies HostToWorker)
            } catch (e) {
              // 写作用域失败回传为脚本错误，由 pm 侧记成失败断言，不终止整个脚本
              worker.postMessage({
                type: 'varWriteAck',
                id: msg.id,
                ok: false,
                error: (e as Error).message,
              } satisfies HostToWorker)
            }
            return
          case 'cookieWrite':
            try {
              hooks.cookieWrite(msg.op, msg.name, msg.value)
              worker.postMessage({ type: 'varWriteAck', id: msg.id } satisfies HostToWorker)
            } catch (e) {
              worker.postMessage({
                type: 'varWriteAck',
                id: msg.id,
                ok: false,
                error: (e as Error).message,
              } satisfies HostToWorker)
            }
            return
          case 'done':
            finish({
              request: msg.request,
              fakePatch: (msg.fake ?? {}) as FakeConfig,
              assertions: msg.assertions,
              logs,
              runtimeWrites: msg.runtimeWrites ?? {},
              localWrites: msg.localWrites ?? {},
              ...(msg.nextRequest === undefined ? {} : { nextRequest: msg.nextRequest }),
              skip: msg.skip,
            })
            return
          case 'fail':
            finish({ ...EMPTY, logs, error: { code: 'SCRIPT_ERROR', message: msg.message } })
            return
        }
      })

      worker.on('error', (e) => {
        finish({ ...EMPTY, logs, error: { code: 'SCRIPT_ERROR', message: e.message } })
      })

      worker.on('exit', (code) => {
        // 任何退出都视为结束：静默退出（如脚本让线程提前空闲）不能留成 5s 干等
        finish({
          ...EMPTY,
          logs,
          error: { code: 'SCRIPT_ERROR', message: `脚本线程已结束（code ${code}），未返回结果` },
        })
      })

      worker.postMessage({ type: 'job', job } satisfies HostToWorker)
    })
  }
}
