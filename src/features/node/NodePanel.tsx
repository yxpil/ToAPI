// @author yxpil
import { useEffect, useState } from 'react'
import type { NodeListItem, NodeRunInput } from '@shared/channels'
import type { ProjectNode, TreeCollectionNode } from '@shared/types'
import { relTime } from '../../lib/format'
import { useApp } from '../../stores/app.store'
import { useNodes } from '../../stores/node.store'
import { Icon } from '../../components/Icon'

/**
 * 节点面板（24 号文档 §7）：配对列表、指纹核对、项目互传与代为测试。
 * 联合测试向导依赖多节点切片与一致性闸门，本轮先把配对 / 互传 / 代跑打通。
 */

const countApis = (collections: TreeCollectionNode[]): number =>
  collections.reduce((sum, c) => sum + c.apis.length + countApis(c.children), 0)

const localApis = (node: ProjectNode | undefined): number =>
  node === undefined ? 0 : countApis(node.collections)

const CONFLICT_LABEL: Record<'skip' | 'overwrite' | 'duplicate', string> = {
  skip: '跳过同名接口',
  overwrite: '覆盖同名接口',
  duplicate: '另存为副本',
}

const STATE_OF = (node: NodeListItem): { kind: string; text: string } => {
  if (!node.enabled) return { kind: 'off', text: '已停用' }
  if (node.probe === null)
    return {
      kind: node.lastError === null ? 'idle' : 'err',
      text: node.lastError === null ? '未探活' : '不可达',
    }
  if (node.probe.busy) return { kind: 'busy', text: '忙' }
  return { kind: 'ready', text: '就绪' }
}

function Dot({ kind }: { kind: string }) {
  return (
    <svg className={`node-dot ${kind}`} width={8} height={8} viewBox="0 0 8 8" aria-hidden="true">
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  )
}

/** 本机作为被配对一方要念给对方的信息：地址、端口、指纹（§2.1 第 1 步） */
function SelfBar() {
  const self = useNodes((s) => s.self)
  if (self === null) return null
  const where =
    self.access === 'lan' ? (self.addresses[0] ?? '未检测到局域网地址') : '仅本机 loopback'
  return (
    <div className="node-self" data-testid="node-self">
      <Dot kind={self.pairable ? 'ready' : 'off'} />
      <span className="node-self-title">{self.pairable ? '本机可被配对' : '本机暂不可被配对'}</span>
      <span className="meta">
        {where}:{self.port} · 设备 …{self.deviceId.slice(-6)}
      </span>
      <code className="node-fp" title="本机指纹，配对时与对方屏幕核对">
        {self.fingerprint ?? '未设置调用口令'}
      </code>
      {!self.pairable && (
        <span className="node-hint">
          需在「设置 → 开放调用」设置口令并启用；跨机联合还要勾「局域网」
        </span>
      )}
    </div>
  )
}

export function NodePane() {
  const {
    items,
    activity,
    busy,
    error,
    message,
    load,
    setEditor,
    openPull,
    openPush,
    remove,
    probe,
    confirm,
  } = useNodes()
  const [pendingRemove, setPendingRemove] = useState<NodeListItem | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(() => useNodes.getState().clearMessage(), 5000)
    return () => clearTimeout(timer)
  }, [message])

  return (
    <div className="pane-body node-pane" data-testid="node-pane">
      <div className="task-toolbar">
        <button
          className="pill primary"
          title="配对局域网里的另一台 ToAPI"
          data-testid="node-new"
          onClick={() => setEditor(true)}
        >
          <Icon name="plus" size={14} /> 新增节点
        </button>
        <button className="pill ghost" title="重新探活全部节点" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
        <span className="meta">同局域网直连，不经服务器</span>
      </div>

      <SelfBar />

      {error !== null && <div className="tapi-error">{error}</div>}
      {message !== null && (
        <div className="node-message" role="status" data-testid="node-message">
          <Icon name="check" size={14} /> {message}
        </div>
      )}

      {items.length === 0 && (
        <div className="empty">
          还没有配对节点。在另一台机器的「设置 → 开放调用」里设好口令并勾选局域网，再来这里配对。
        </div>
      )}

      <ul className="task-list">
        {items.map((node) => {
          const state = STATE_OF(node)
          return (
            <li
              key={node.id}
              className={`task-row node-row${node.enabled ? '' : ' off'}`}
              data-testid="node-row"
            >
              <span className="node-state">
                <Dot kind={state.kind} />
                <span className="meta">{state.text}</span>
              </span>
              <div className="task-main">
                <div className="task-name">
                  {node.name}
                  <span className="node-addr">
                    {node.host}:{node.port}
                  </span>
                  {node.probe && <span className="node-ver">v{node.probe.version}</span>}
                </div>
                <div className="meta">
                  {node.probe
                    ? `${String(node.probe.projects.length)} 个项目 · ${node.probe.platform}`
                    : (node.lastError ?? '尚未探活')}
                  {node.lastSeenAt !== null && ` · 探活 ${relTime(node.lastSeenAt)}`}
                </div>
                <div className="meta node-fp-line">
                  指纹 <code>{node.fingerprint || '—'}</code>
                  {node.trusted ? (
                    <span className="node-trusted">已确认</span>
                  ) : (
                    <span className="node-untrusted">未确认，不能推送或代跑</span>
                  )}
                  {activity[node.id] !== undefined && <span> · {activity[node.id]}</span>}
                </div>
                {!node.trusted && node.fingerprint !== '' && (
                  <button
                    className="pill ghost node-confirm"
                    title="两屏核对指纹一致后锁定"
                    data-testid="node-confirm"
                    onClick={() => void confirm(node.id)}
                  >
                    <Icon name="check" size={14} /> 确认指纹
                  </button>
                )}
              </div>
              <div className="row-actions">
                <button
                  className="pill ghost"
                  title="探活"
                  aria-label={`探活 ${node.name}`}
                  disabled={busy === node.id}
                  onClick={() => void probe(node.id)}
                >
                  <Icon name="refresh" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="拉取远端项目到本机"
                  aria-label={`从 ${node.name} 拉取项目`}
                  disabled={!node.enabled}
                  onClick={() => openPull(node)}
                >
                  <Icon name="download" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="推送本机项目到远端"
                  aria-label={`推送项目到 ${node.name}`}
                  disabled={!node.trusted}
                  onClick={() => openPush(node)}
                >
                  <Icon name="upload" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="在该机器上代为运行"
                  aria-label={`在 ${node.name} 上运行`}
                  disabled={!node.trusted}
                  onClick={() => void startRun(node)}
                >
                  <Icon name="play" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="编辑"
                  aria-label={`编辑 ${node.name}`}
                  onClick={() => setEditor(true, node)}
                >
                  <Icon name="gear" size={14} />
                </button>
                <button
                  className="pill ghost danger"
                  title="解除配对"
                  aria-label={`解除配对 ${node.name}`}
                  onClick={() => setPendingRemove(node)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <NodeEditor />
      <PullDialog />
      <PushDialog />
      <RunDialog />

      {pendingRemove !== null && (
        <div className="overlay" onPointerDown={() => setPendingRemove(null)}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="node-remove-title"
            data-testid="node-remove"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="dialog-title" id="node-remove-title">
              解除与「{pendingRemove.name}」的配对？
            </div>
            <div className="dialog-text">
              只删除本机保存的信道密钥与指纹锁定，不影响对方机器上的任何数据；恢复需重新输入口令配对。
            </div>
            <div className="dialog-actions">
              <button className="pill ghost" title="取消" onClick={() => setPendingRemove(null)}>
                取消
              </button>
              <button
                className="pill danger"
                title="确认解除配对"
                onClick={() => {
                  void remove(pendingRemove.id)
                  setPendingRemove(null)
                }}
              >
                解除配对
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 代为测试要先有远端项目：默认拿第一个，向导里可换 */
const startRun = async (node: NodeListItem): Promise<void> => {
  const projectId = node.probe?.projects[0]?.id ?? ''
  if (projectId === '') {
    useNodes.setState({ error: `节点「${node.name}」上没有可运行的项目` })
    return
  }
  await useNodes.getState().prepareRun(node.id, projectId)
}

function NodeEditor() {
  const { editorOpen, editing, setEditor, add, update, self } = useNodes()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('4730')
  const [password, setPassword] = useState('')
  const [labels, setLabels] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!editorOpen) return
    setName(editing?.name ?? '')
    setHost(editing?.host ?? '')
    setPort(String(editing?.port ?? 4730))
    setPassword('')
    setLabels((editing?.labels ?? []).join(', '))
    setLocalError(null)
  }, [editorOpen, editing])

  if (!editorOpen) return null

  const weak = password.trim() !== '' && password.trim().length < 12

  const submit = async (): Promise<void> => {
    setLocalError(null)
    if (host.trim() === '') return setLocalError('请填写对端 IP 或主机名')
    if (!editing && password.trim() === '') return setLocalError('请填写对端的调用口令')
    const portNumber = Number.parseInt(port, 10)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return setLocalError('端口需为 1–65535 的整数')
    }
    const parsed = labels
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const ok = editing
      ? await update({
          id: editing.id,
          name: name.trim(),
          host: host.trim(),
          port: portNumber,
          labels: parsed,
          ...(password.trim() === '' ? {} : { password: password.trim() }),
        })
      : await add({
          name: name.trim(),
          host: host.trim(),
          port: portNumber,
          password: password.trim(),
          labels: parsed,
        })
    if (!ok)
      setLocalError(
        '配对或保存失败：确认对端已启用开放通道、口令正确，并在「访问范围」里勾了局域网',
      )
  }

  return (
    <div className="overlay" onPointerDown={() => setEditor(false)}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-editor-title"
        data-testid="node-editor"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="node-editor-title">
          {editing ? '编辑节点' : '配对新节点'}
        </div>

        <div className="field">
          <span>对端地址</span>
          <div className="node-host">
            <input
              value={host}
              placeholder="192.168.1.23"
              spellCheck={false}
              aria-label="对端 IP 或主机名"
              data-testid="node-host"
              onChange={(e) => setHost(e.target.value)}
            />
            <input
              value={port}
              aria-label="对端端口"
              data-testid="node-port"
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>

        <label className="field">
          <span>{editing ? '调用口令（留空表示不改）' : '调用口令'}</span>
          <input
            type="password"
            value={password}
            placeholder="对端「开放调用」里设置的那串"
            spellCheck={false}
            aria-label="调用口令"
            data-testid="node-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {weak && (
          <div className="tapi-error" data-testid="node-weak">
            口令少于 12 位：信道加密强度就等于口令强度，建议用对端「生成」出的随机口令
          </div>
        )}

        <label className="field">
          <span>别名</span>
          <input
            value={name}
            placeholder="测试机"
            aria-label="节点别名"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>标签（逗号分隔）</span>
          <input
            value={labels}
            placeholder="staging, win"
            spellCheck={false}
            aria-label="节点标签"
            onChange={(e) => setLabels(e.target.value)}
          />
        </label>

        {!self?.pairable && (
          <div className="node-hint">
            本机当前不可被配对：对方若要回连本机，需先在「设置 → 开放调用」设置口令并启用。
          </div>
        )}

        {localError !== null && <div className="tapi-error">{localError}</div>}

        <div className="dialog-actions">
          <button className="pill ghost" title="取消" onClick={() => setEditor(false)}>
            取消
          </button>
          <button
            className="pill primary"
            title={editing ? '保存节点' : '配对并保存'}
            data-testid="node-save"
            onClick={() => void submit()}
          >
            {editing ? '保存' : '配对'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PullDialog() {
  const { pullFor, closeDialogs, pull } = useNodes()
  const tree = useApp((s) => s.tree)
  const projects = pullFor?.probe?.projects ?? []
  const [remote, setRemote] = useState('')
  const [mode, setMode] = useState<'new' | 'into'>('new')
  const [target, setTarget] = useState('')
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'duplicate'>('skip')

  useEffect(() => {
    if (!pullFor) return
    setRemote(pullFor.probe?.projects[0]?.id ?? '')
    setMode('new')
    setTarget(tree[0]?.project.id ?? '')
  }, [pullFor, tree])

  if (!pullFor) return null
  const picked = projects.find((p) => p.id === remote) ?? null

  return (
    <div className="overlay" onPointerDown={closeDialogs}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-pull-title"
        data-testid="node-pull"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="node-pull-title">
          从「{pullFor.name}」拉取项目
        </div>

        <label className="field">
          <span>远端项目</span>
          <select
            value={remote}
            aria-label="远端项目"
            data-testid="node-pull-project"
            onChange={(e) => setRemote(e.target.value)}
          >
            {projects.length === 0 && <option value="">对端没有项目</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{String(p.apis)} 接口 · {p.hash.slice(0, 6)}）
              </option>
            ))}
          </select>
        </label>

        <PullSummary node={pullFor} remote={picked} />

        <div className="field">
          <span>落地方式</span>
          <div className="segmented" role="tablist" aria-label="落地方式">
            <button
              type="button"
              aria-selected={mode === 'new'}
              title="新建一个本地项目"
              onClick={() => setMode('new')}
            >
              新建项目
            </button>
            <button
              type="button"
              aria-selected={mode === 'into'}
              title="合并进已选的本机项目"
              onClick={() => setMode('into')}
            >
              合并进
            </button>
          </div>
        </div>

        {mode === 'into' && (
          <label className="field">
            <span>目标项目</span>
            <select
              value={target}
              aria-label="目标项目"
              onChange={(e) => setTarget(e.target.value)}
            >
              {tree.length === 0 && <option value="">本机还没有项目</option>}
              {tree.map((node) => (
                <option key={node.project.id} value={node.project.id}>
                  {node.project.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>同名接口</span>
          <select
            value={conflict}
            aria-label="同名接口策略"
            onChange={(e) => setConflict(e.target.value as 'skip' | 'overwrite' | 'duplicate')}
          >
            {Object.entries(CONFLICT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="dialog-actions">
          <button className="pill ghost" title="取消" onClick={closeDialogs}>
            取消
          </button>
          <button
            className="pill primary"
            title="拉取并导入"
            data-testid="node-pull-go"
            disabled={remote === '' || (mode === 'into' && target === '')}
            onClick={() =>
              void pull({
                nodeId: pullFor.id,
                projectId: remote,
                mode,
                ...(mode === 'into' ? { targetProjectId: target } : {}),
                apiConflict: conflict,
              })
            }
          >
            拉取
          </button>
        </div>
      </div>
    </div>
  )
}

/** 拉取前的差异与密钥提示：hash 只用于"看起来是否一致"（§3） */
function PullSummary({
  node,
  remote,
}: {
  node: NodeListItem
  remote: { id: string; name: string; hash: string; apis: number } | null
}) {
  const tree = useApp((s) => s.tree)
  if (remote === null) return <div className="dialog-text">对端当前没有可拉取的项目。</div>
  const local = tree.find((n) => n.project.name === remote.name)
  return (
    <dl className="tapi-summary" data-testid="node-pull-summary">
      <div className="tapi-summary-row">
        <dt>远端</dt>
        <dd>
          {node.name} · {remote.name}（{String(remote.apis)} 接口 · {remote.hash.slice(0, 8)}）
        </dd>
      </div>
      <div className="tapi-summary-row">
        <dt>与本机同名项目</dt>
        <dd>
          {local === undefined
            ? '本机还没有同名项目'
            : `${local.project.name} · ${String(localApis(local))} 接口`}
        </dd>
      </div>
      <div className="tapi-summary-row">
        <dt>密钥</dt>
        <dd>只传变量名，值永不跨机；导入后需在本机补填</dd>
      </div>
    </dl>
  )
}

function PushDialog() {
  const { pushFor, closeDialogs, push } = useNodes()
  const tree = useApp((s) => s.tree)
  const [projectId, setProjectId] = useState('')
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'duplicate'>('duplicate')

  useEffect(() => {
    if (pushFor) setProjectId(tree[0]?.project.id ?? '')
  }, [pushFor, tree])

  if (!pushFor) return null
  const sameName = pushFor.probe?.projects.find(
    (p) => p.name === tree.find((n) => n.project.id === projectId)?.project.name,
  )

  return (
    <div className="overlay" onPointerDown={closeDialogs}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-push-title"
        data-testid="node-push"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="node-push-title">
          推送项目到「{pushFor.name}」
        </div>

        <label className="field">
          <span>本机项目</span>
          <select
            value={projectId}
            aria-label="本机项目"
            data-testid="node-push-project"
            onChange={(e) => setProjectId(e.target.value)}
          >
            {tree.length === 0 && <option value="">本机还没有项目</option>}
            {tree.map((node) => (
              <option key={node.project.id} value={node.project.id}>
                {node.project.name}（{String(localApis(node))} 接口）
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>同名接口</span>
          <select
            value={conflict}
            aria-label="同名接口策略"
            onChange={(e) => setConflict(e.target.value as 'skip' | 'overwrite' | 'duplicate')}
          >
            {Object.entries(CONFLICT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="node-hint">
          {sameName
            ? `对端已有同名项目「${sameName.name}」：按上面的同名接口策略合并，不覆盖对端独有内容。`
            : '对端没有同名项目，将新建。'}{' '}
          密钥变量只传名字与占位，值不跨机。
        </div>

        <div className="dialog-actions">
          <button className="pill ghost" title="取消" onClick={closeDialogs}>
            取消
          </button>
          <button
            className="pill primary"
            title="推送并导入"
            data-testid="node-push-go"
            disabled={projectId === ''}
            onClick={() => void push({ nodeId: pushFor.id, projectId, apiConflict: conflict })}
          >
            推送
          </button>
        </div>
      </div>
    </div>
  )
}

function RunDialog() {
  const { runFor, closeDialogs, prepareRun, run } = useNodes()
  const [scopeId, setScopeId] = useState('')
  const [envId, setEnvId] = useState('')
  const [projectId, setProjectId] = useState('')

  useEffect(() => {
    if (!runFor) return
    setProjectId(runFor.projectId)
    setScopeId(runFor.tree.collections[0]?.id ?? '')
    setEnvId('')
  }, [runFor])

  if (!runFor) return null
  const collections = runFor.tree.collections
  const picked = collections.find((c) => c.id === scopeId) ?? null
  const total = picked?.apis ?? 0
  const input: NodeRunInput = {
    nodeId: runFor.node.id,
    scopeType: picked ? 'collection' : 'project',
    scopeId: picked ? picked.id : projectId,
    envId: envId === '' ? null : envId,
  }

  return (
    <div className="overlay" onPointerDown={closeDialogs}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-run-title"
        data-testid="node-run"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="node-run-title">
          在「{runFor.node.name}」上代为运行
        </div>

        <label className="field">
          <span>远端项目</span>
          <select
            value={projectId}
            aria-label="远端项目"
            onChange={(e) => {
              setProjectId(e.target.value)
              void prepareRun(runFor.node.id, e.target.value)
            }}
          >
            {(runFor.node.probe?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>运行范围</span>
          <select
            value={scopeId}
            aria-label="运行范围"
            data-testid="node-run-scope"
            onChange={(e) => setScopeId(e.target.value)}
          >
            <option value="">整个项目（{String(runFor.tree.collections.length)} 个集合）</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{String(c.apis)} 接口）
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>远端环境（必须显式指定）</span>
          <select
            value={envId}
            aria-label="远端环境"
            data-testid="node-run-env"
            onChange={(e) => setEnvId(e.target.value)}
          >
            <option value="">选择环境</option>
            {runFor.tree.envs.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </label>

        <div className="node-hint">
          将打到 {runFor.node.host}:{runFor.node.port} 这台机器上执行；环境不跟随本机激活项，
          预计请求量 {String(total)}，结果会落成本机一份运行记录并汇报。
        </div>

        <div className="dialog-actions">
          <button className="pill ghost" title="取消" onClick={closeDialogs}>
            取消
          </button>
          <button
            className="pill primary"
            title="下发远端运行"
            data-testid="node-run-go"
            disabled={envId === ''}
            onClick={() => void run(input)}
          >
            开始运行
          </button>
        </div>
      </div>
    </div>
  )
}
