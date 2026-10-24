// @author yxpil
import { useEffect, useMemo, useState } from 'react'
import type {
  NewScheduleTask,
  OverlapPolicy,
  ReportFormat,
  ScheduleSpec,
  ScheduleTaskView,
  ScheduleTargetType,
  TaskNotifyOptions,
} from '@shared/channels'
import type { Environment } from '@shared/types'
import { relTime } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { useApp } from '../../stores/app.store'
import { useTasks } from '../../stores/task.store'
import { Icon } from '../../components/Icon'

/** 任务面板（12 号文档 §1）：定时回归列表 + cron 编辑器（实时显示未来 5 次触发） */

const TARGET_LABEL: Record<ScheduleTargetType, string> = {
  collection: '集合',
  project: '项目',
  api: '接口',
}

const humanMs = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`
  return `${Math.round(ms / 1000)} 秒`
}

const specText = (spec: ScheduleSpec): string => {
  if (spec.kind === 'cron') return spec.expr
  if (spec.kind === 'interval') return `每 ${humanMs(spec.everyMs)}`
  return `单次 ${new Date(spec.at).toLocaleString()}`
}

interface TargetOption {
  type: ScheduleTargetType
  id: string
  label: string
  projectId: string
}

const collectTargets = (tree: ReturnType<typeof useApp.getState>['tree']): TargetOption[] => {
  const options: TargetOption[] = []
  for (const node of tree) {
    options.push({
      type: 'project',
      id: node.project.id,
      label: `项目 · ${node.project.name}`,
      projectId: node.project.id,
    })
    const walk = (collections: typeof node.collections, prefix: string): void => {
      for (const collection of collections) {
        options.push({
          type: 'collection',
          id: collection.id,
          label: `集合 · ${prefix}${collection.name}`,
          projectId: node.project.id,
        })
        for (const api of collection.apis) {
          options.push({
            type: 'api',
            id: api.id,
            label: `接口 · ${prefix}${api.name}`,
            projectId: node.project.id,
          })
        }
        walk(collection.children, `${prefix}${collection.name}/`)
      }
    }
    walk(node.collections, '')
  }
  return options
}

export function TaskPane({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const { tasks, load, toggle, remove, runNow, setEditor } = useTasks()
  const tree = useApp((s) => s.tree)

  useEffect(() => {
    void load()
  }, [load])

  const targets = useMemo(() => collectTargets(tree), [tree])
  const targetName = (task: ScheduleTaskView): string =>
    targets.find((t) => t.id === task.targetId)?.label ?? `${task.targetName}（目标已删除）`

  return (
    <div className="pane-body task-pane" data-testid="task-pane">
      <div className="task-toolbar">
        <button
          className="pill primary"
          title="新建定时任务"
          data-testid="task-new"
          onClick={() => setEditor(true)}
        >
          <Icon name="plus" size={14} /> 新建任务
        </button>
        <span className="meta">定时回归锁环境、锁集合，结果进通知中心</span>
      </div>

      {tasks.length === 0 && <div className="empty">还没有定时任务</div>}

      <ul className="task-list">
        {tasks.map((task) => {
          const lastRunId = task.lastRunId
          return (
            <li
              key={task.id}
              className={`task-row${task.enabled ? '' : ' off'}`}
              data-testid="task-row"
            >
              <label className="task-switch" title={task.enabled ? '停用' : '启用'}>
                <input
                  type="checkbox"
                  checked={task.enabled}
                  aria-label={`启用任务 ${task.name}`}
                  onChange={(e) => void toggle(task.id, e.target.checked)}
                />
              </label>
              <div className="task-main">
                <div className="task-name" title={targetName(task)}>
                  {task.name}
                  {task.running && <span className="task-running">运行中</span>}
                </div>
                <div className="meta">
                  {TARGET_LABEL[task.targetType]} {task.targetName} · {task.envName} ·{' '}
                  <code>{specText(task.spec)}</code>
                </div>
                <div className="meta">
                  下次 {task.nextRunAt === null ? '—' : relTime(task.nextRunAt)}
                  {task.lastRunAt !== null && ` · 上次 ${relTime(task.lastRunAt)}`}
                  {task.lastFailed !== null && ` · 失败 ${task.lastFailed}`}
                  {task.overlap !== 'skip' && ` · ${task.overlap === 'queue' ? '排队' : '并行'}`}
                </div>
              </div>
              <div className="row-actions">
                {lastRunId !== null && (
                  <button
                    className="pill ghost"
                    title="查看上次结果"
                    aria-label="查看上次结果"
                    onClick={() => onOpenRun(lastRunId)}
                  >
                    <Icon name="doc" size={14} />
                  </button>
                )}
                <button
                  className="pill ghost"
                  title="立即运行一次"
                  aria-label="立即运行一次"
                  data-testid="task-run-now"
                  onClick={() => void runNow(task.id)}
                >
                  <Icon name="play" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="编辑"
                  aria-label="编辑任务"
                  onClick={() => setEditor(true, task)}
                >
                  <Icon name="gear" size={14} />
                </button>
                <button
                  className="pill ghost danger"
                  title="删除任务"
                  aria-label="删除任务"
                  onClick={() => void remove(task.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <TaskEditor />
    </div>
  )
}

const DEFAULT_NOTIFY: TaskNotifyOptions = { onSuccess: true, onFail: true, report: 'none' }

function TaskEditor() {
  const { editorOpen, editing, setEditor, create, update, preview, previewSpec } = useTasks()
  const tree = useApp((s) => s.tree)
  const options = useMemo(() => collectTargets(tree), [tree])

  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'cron' | 'interval' | 'once'>('cron')
  const [expr, setExpr] = useState('0 */30 * * *')
  const [everyMinutes, setEveryMinutes] = useState('30')
  const [atText, setAtText] = useState('')
  const [envId, setEnvId] = useState('')
  const [envs, setEnvs] = useState<Environment[]>([])
  const [overlap, setOverlap] = useState<OverlapPolicy>('skip')
  const [misfire, setMisfire] = useState<'run-on-launch' | 'skip'>('run-on-launch')
  const [notify, setNotify] = useState<TaskNotifyOptions>(DEFAULT_NOTIFY)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editorOpen) return
    const first = editing?.targetId ?? options[0]?.id ?? ''
    setTarget(editing?.targetId ?? first)
    setName(editing?.name ?? '')
    setEnvId(editing?.envId ?? '')
    setOverlap(editing?.overlap ?? 'skip')
    setMisfire(editing?.misfire ?? 'run-on-launch')
    setNotify(editing?.notify ?? DEFAULT_NOTIFY)
    setError(null)
    if (editing) {
      setKind(editing.spec.kind)
      setExpr(editing.spec.kind === 'cron' ? editing.spec.expr : '0 */30 * * *')
      setEveryMinutes(
        editing.spec.kind === 'interval' ? String(editing.spec.everyMs / 60_000) : '30',
      )
      setAtText(editing.spec.kind === 'once' ? toLocalInput(editing.spec.at) : '')
    } else {
      setKind('cron')
      setExpr('0 */30 * * *')
      setEveryMinutes('30')
      setAtText('')
    }
  }, [editorOpen, editing, options])

  // 目标所在项目的环境列表：跨项目建任务时不能沿用当前激活项目的环境
  useEffect(() => {
    if (!editorOpen) return
    const option = options.find((o) => o.id === target)
    if (!option) return
    let ignore = false
    void invoke('env:list', { projectId: option.projectId })
      .then((res) => {
        if (ignore) return
        setEnvs(res.envs)
        const active = res.envs.find((e) => e.isActive)
        setEnvId((current) =>
          current !== '' && res.envs.some((e) => e.id === current) ? current : (active?.id ?? ''),
        )
      })
      .catch(() => undefined)
    return () => {
      ignore = true
    }
  }, [editorOpen, target, options])

  const spec = useMemo<ScheduleSpec | null>(() => {
    if (kind === 'cron') return { kind: 'cron', expr }
    if (kind === 'interval') {
      const minutes = Number.parseFloat(everyMinutes)
      if (!Number.isFinite(minutes) || minutes <= 0) return null
      return { kind: 'interval', everyMs: Math.round(minutes * 60_000) }
    }
    const at = Date.parse(atText)
    return Number.isNaN(at) ? null : { kind: 'once', at }
  }, [kind, expr, everyMinutes, atText])

  useEffect(() => {
    if (!editorOpen || !spec) return
    void previewSpec(spec)
  }, [editorOpen, spec, previewSpec])

  if (!editorOpen) return null

  const createEnv = async (): Promise<void> => {
    const option = options.find((o) => o.id === target)
    if (!option) return setError('请先选择运行目标')
    try {
      const env = await invoke('env:create', { projectId: option.projectId, name: '定时环境' })
      setEnvs(await invoke('env:list', { projectId: option.projectId }).then((r) => r.envs))
      setEnvId(env.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (name.trim() === '') return setError('请填写任务名')
    if (!spec) return setError('触发规则还没填完整')
    if (target === '') return setError('请选择运行目标')
    const input: NewScheduleTask = {
      name: name.trim(),
      targetType: options.find((o) => o.id === target)?.type ?? 'collection',
      targetId: target,
      spec,
      envId: envId === '' ? null : envId,
      overlap,
      misfire,
      notify,
      enabled: editing?.enabled ?? true,
    }
    const saved = editing ? await update({ id: editing.id, ...input }) : await create(input)
    if (!saved) setError('保存失败：请检查环境是否已锁定、目标是否存在')
  }

  return (
    <div className="overlay" onPointerDown={() => setEditor(false)}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-editor-title"
        data-testid="task-editor"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="task-editor-title">
          {editing ? '编辑定时任务' : '新建定时任务'}
        </div>

        <label className="field">
          <span>任务名</span>
          <input
            value={name}
            placeholder="订单冒烟回归"
            aria-label="任务名"
            data-testid="task-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>运行目标</span>
          <select
            value={target}
            aria-label="运行目标"
            data-testid="task-target"
            onChange={(e) => setTarget(e.target.value)}
          >
            {options.length === 0 && <option value="">请先创建项目与集合</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>锁定环境</span>
          <select
            value={envId}
            aria-label="锁定环境"
            data-testid="task-env"
            onChange={(e) => setEnvId(e.target.value)}
          >
            <option value="">选择环境（必须）</option>
            {envs.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          {/* 定时任务必须锁环境，所以这里要能就地建一个，而不是把用户赶去导入 Postman 环境 */}
          <button
            className="pill ghost"
            title="在目标项目下新建环境并选中"
            data-testid="task-env-new"
            onClick={() => void createEnv()}
          >
            <Icon name="plus" size={14} /> 新建环境
          </button>
        </div>

        <div className="field">
          <span>触发方式</span>
          <div className="segmented" role="tablist" aria-label="触发方式">
            {(['cron', 'interval', 'once'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-selected={kind === k}
                title={k === 'cron' ? 'cron 表达式' : k === 'interval' ? '固定间隔' : '单次定时'}
                onClick={() => setKind(k)}
              >
                {k === 'cron' ? 'cron' : k === 'interval' ? '间隔' : '单次'}
              </button>
            ))}
          </div>
        </div>

        {kind === 'cron' && (
          <label className="field">
            <span>cron 表达式</span>
            <input
              value={expr}
              spellCheck={false}
              placeholder="0 */30 * * *"
              aria-label="cron 表达式"
              data-testid="task-expr"
              onChange={(e) => setExpr(e.target.value)}
            />
          </label>
        )}
        {kind === 'interval' && (
          <label className="field">
            <span>间隔（分钟）</span>
            <input
              type="number"
              min={1}
              step={1}
              value={everyMinutes}
              aria-label="间隔分钟"
              data-testid="task-every"
              onChange={(e) => setEveryMinutes(e.target.value)}
            />
          </label>
        )}
        {kind === 'once' && (
          <label className="field">
            <span>触发时刻</span>
            <input
              type="datetime-local"
              value={atText}
              aria-label="触发时刻"
              data-testid="task-at"
              onChange={(e) => setAtText(e.target.value)}
            />
          </label>
        )}

        <div className="task-preview" data-testid="task-preview">
          {preview?.error && <span className="tapi-error">{preview.error}</span>}
          {!preview?.error && preview?.times.length === 0 && (
            <span className="meta">该规则在未来 4 年内不会触发</span>
          )}
          {!preview?.error &&
            (preview?.times ?? []).map((t) => (
              <span key={t} className="pill ghost">
                {new Date(t).toLocaleString()}
              </span>
            ))}
        </div>

        <div className="postman-modes">
          <label>
            <span>重叠策略</span>
            <select
              value={overlap}
              aria-label="重叠策略"
              onChange={(e) => setOverlap(e.target.value as OverlapPolicy)}
            >
              <option value="skip">上次未完则跳过</option>
              <option value="queue">排队（上限 3）</option>
              <option value="parallel">并行</option>
            </select>
          </label>
          <label>
            <span>错过补跑</span>
            <select
              value={misfire}
              aria-label="错过补跑策略"
              onChange={(e) => setMisfire(e.target.value as 'run-on-launch' | 'skip')}
            >
              <option value="run-on-launch">启动时补跑最近一次</option>
              <option value="skip">直接跳过</option>
            </select>
          </label>
        </div>

        <div className="postman-modes task-notify">
          <label>
            <span>成功也通知</span>
            <input
              type="checkbox"
              checked={notify.onSuccess}
              aria-label="成功也通知"
              onChange={(e) => setNotify({ ...notify, onSuccess: e.target.checked })}
            />
          </label>
          <label>
            <span>失败必通知</span>
            <input
              type="checkbox"
              checked={notify.onFail}
              aria-label="失败必通知"
              onChange={(e) => setNotify({ ...notify, onFail: e.target.checked })}
            />
          </label>
          <label>
            <span>每次落报告</span>
            <select
              value={notify.report}
              aria-label="报告格式"
              onChange={(e) =>
                setNotify({ ...notify, report: e.target.value as ReportFormat | 'none' })
              }
            >
              <option value="none">不落盘</option>
              <option value="json">JSON</option>
              <option value="junit">JUnit</option>
              <option value="html">HTML</option>
            </select>
          </label>
        </div>

        {error && <div className="tapi-error">{error}</div>}

        <div className="dialog-actions">
          <button className="pill ghost" title="取消" onClick={() => setEditor(false)}>
            取消
          </button>
          <button
            className="pill primary"
            title="保存任务"
            data-testid="task-save"
            onClick={() => void submit()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** datetime-local 需要本机时区的 YYYY-MM-DDTHH:mm 字符串 */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}
