import { useEffect, useState } from 'react'
import type { AppHello } from '@shared/channels'
import { useApp } from './stores/app.store'
import { invoke } from './lib/ipc'
import { TreePane } from './features/tree/TreePane'
import { EditorPane } from './features/editor/EditorPane'
import { ResponsePane } from './features/response/ResponsePane'
import { RunnerPane } from './features/runner/RunnerPane'
import { Icon } from './components/Icon'

function StatusBar({ hello }: { hello: AppHello | null }) {
  const { envs, vars, activeProjectId, activateEnv, setVar } = useApp()
  const active = envs.find((e) => e.isActive) ?? null
  const [probeKey, setProbeKey] = useState('baseUrl')

  const globals = vars.filter((v) => v.scope === 'global')
  const envVars = vars.filter((v) => v.scope === 'environment' && v.environmentId === active?.id)
  const probeValue =
    (active ? envVars.find((v) => v.key === probeKey)?.value : undefined) ??
    globals.find((v) => v.key === probeKey)?.value ??
    ''

  return (
    <footer className="statusbar">
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        环境
        <select
          className="pill ghost"
          style={{ height: 22 }}
          value={active?.id ?? ''}
          aria-label="当前环境"
          title="切换环境"
          disabled={!activeProjectId}
          onChange={(e) => void activateEnv(e.target.value || null)}
        >
          <option value="">无</option>
          {envs.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <span className="pill ghost" style={{ height: 22 }}>
          {'{{'}
          <input
            style={{ width: 90, border: 0, outline: 'none', background: 'transparent' }}
            value={probeKey}
            aria-label="变量名"
            onChange={(e) => setProbeKey(e.target.value)}
          />
          {'}}'}
        </span>
        <input
          className="pill ghost"
          style={{ height: 22, width: 200 }}
          value={probeValue}
          placeholder={active ? '设置该环境变量' : '设置全局变量'}
          aria-label="变量值"
          onChange={(e) => void setVar(probeKey, e.target.value, active?.id ?? null)}
        />
      </label>

      <span title="主进程版本与契约哈希">
        {hello ? `v${hello.mainVersion} · db${hello.schemaVersion} · ${hello.platform}` : '连接中'}
      </span>
    </footer>
  )
}

export default function App() {
  const { boot, toast, dismissToast, saveApi, send, cancelSend, sendPending } = useApp()
  const [hello, setHello] = useState<AppHello | null>(null)
  const [pane, setPane] = useState<'response' | 'runner'>('response')

  useEffect(() => {
    void boot()
    void invoke('app:hello', {})
      .then(setHello)
      .catch(() => setHello(null))
  }, [boot])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismissToast, toast.kind === 'error' ? 5000 : 2000)
    return () => clearTimeout(timer)
  }, [toast, dismissToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        void send()
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveApi()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send, saveApi])

  return (
    <div className="app">
      <TreePane />
      <EditorPane />
      <div className="response-col">
        <div className="pane-switch">
          <div className="segmented" role="tablist" aria-label="右侧面板切换">
            <button
              role="tab"
              aria-selected={pane === 'response'}
              title="响应与历史"
              onClick={() => setPane('response')}
            >
              响应
            </button>
            <button
              role="tab"
              aria-selected={pane === 'runner'}
              title="集合 Runner 结果"
              onClick={() => setPane('runner')}
            >
              Runner
            </button>
          </div>
        </div>
        {pane === 'response' ? <ResponsePane /> : <RunnerPane />}
      </div>
      <StatusBar hello={hello} />
      {toast && (
        <div className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          <Icon name={toast.kind === 'error' ? 'cross' : 'check'} size={14} />
          {toast.text}
        </div>
      )}
      {sendPending && (
        <button
          className="pill danger"
          style={{ position: 'fixed', right: 16, bottom: 40 }}
          title="取消当前请求"
          onClick={() => void cancelSend()}
        >
          <Icon name="cross" size={14} /> 取消
        </button>
      )}
    </div>
  )
}
