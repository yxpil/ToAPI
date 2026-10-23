import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { AppHello } from '@shared/channels'
import type { ProjectNode, TreeCollectionNode } from '@shared/types'
import { useApp } from './stores/app.store'
import { useRunner } from './stores/runner.store'
import { invoke } from './lib/ipc'
import { formatBytes } from './lib/format'
import { loadPref, savePref } from './lib/prefs'
import { TreePane } from './features/tree/TreePane'
import { EditorPane } from './features/editor/EditorPane'
import { ResponsePane } from './features/response/ResponsePane'
import { RunnerPane } from './features/runner/RunnerPane'
import { Icon } from './components/Icon'
import { Splitter } from './components/Splitter'
import { CommandPalette } from './components/CommandPalette'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

const locateApi = (
  tree: ProjectNode[],
  apiId: string,
): { projectId: string; collection: TreeCollectionNode } | null => {
  for (const node of tree) {
    const stack = [...node.collections]
    while (stack.length > 0) {
      const collection = stack.pop()
      if (!collection) continue
      if (collection.apis.some((api) => api.id === apiId)) {
        return { projectId: node.project.id, collection }
      }
      stack.push(...collection.children)
    }
  }
  return null
}

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
    <footer className="statusbar" data-testid="statusbar">
      <label className="status-item">
        环境
        <select
          className="pill ghost"
          style={{ height: 20 }}
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

      <label className="status-item status-probe">
        <span className="pill ghost" style={{ height: 20 }}>
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
          style={{ height: 20, width: 190 }}
          value={probeValue}
          placeholder={active ? '设置该环境变量' : '设置全局变量'}
          aria-label="变量值"
          onChange={(e) => void setVar(probeKey, e.target.value, active?.id ?? null)}
        />
      </label>

      <span className="status-item" title="数据库文件大小" data-testid="db-size">
        DB {hello ? formatBytes(hello.dbSizeBytes) : '—'}
      </span>
      <span
        className="status-item"
        title={hello ? `契约 ${hello.channelsHash} · ${hello.platform}` : '主进程握手'}
        data-testid="app-version"
      >
        {hello ? `v${hello.mainVersion}` : '连接中'}
      </span>
    </footer>
  )
}

export default function App() {
  const { boot, toast, dismissToast, saveApi, send, cancelSend, sendPending } = useApp()
  const [hello, setHello] = useState<AppHello | null>(null)
  const [pane, setPane] = useState<'response' | 'runner'>('response')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [orientation, setOrientation] = useState<'right' | 'bottom'>(() =>
    loadPref<'right' | 'bottom'>('orientation', 'right'),
  )
  const [treeWidth, setTreeWidth] = useState<number>(() => loadPref('treeWidth', 240))
  const [rightRatio, setRightRatio] = useState<number>(() => loadPref('rightRatio', 0.45))
  const [bottomRatio, setBottomRatio] = useState<number>(() => loadPref('bottomRatio', 0.45))
  const shellRef = useRef<HTMLDivElement>(null)
  const treeWidthRef = useRef(treeWidth)
  const rightRatioRef = useRef(rightRatio)
  const bottomRatioRef = useRef(bottomRatio)

  useEffect(() => {
    void boot()
    void invoke('app:hello', {})
      .then(setHello)
      .catch(() => setHello(null))
  }, [boot])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismissToast, 2000)
    return () => clearTimeout(timer)
  }, [toast, dismissToast])

  const toggleOrientation = useCallback(() => {
    setOrientation((current) => {
      const next = current === 'right' ? 'bottom' : 'right'
      savePref('orientation', next)
      return next
    })
  }, [])

  const runCurrentCollection = useCallback(async () => {
    const state = useApp.getState()
    if (!state.api) {
      useApp.setState({ toast: { kind: 'error', text: '请先选择接口' } })
      return
    }
    const found = locateApi(state.tree, state.api.id)
    if (!found) return
    if (state.activeProjectId !== found.projectId) await state.selectProject(found.projectId)
    setPane('runner')
    await useRunner.getState().runCollection(found.collection.id, found.collection.name)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (e.key === '`') {
        e.preventDefault()
        toggleOrientation()
      } else if (key === 'r' && e.shiftKey) {
        e.preventDefault()
        void runCurrentCollection()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void send()
      } else if (key === 's') {
        e.preventDefault()
        void saveApi()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [send, saveApi, toggleOrientation, runCurrentCollection])

  const maxTreeWidth = (): number => Math.max(180, Math.min(480, window.innerWidth - 690))

  const updateTreeWidth = (width: number): void => {
    treeWidthRef.current = width
    setTreeWidth(width)
  }

  const updateRightRatio = (ratio: number): void => {
    rightRatioRef.current = ratio
    setRightRatio(ratio)
  }

  const updateBottomRatio = (ratio: number): void => {
    bottomRatioRef.current = ratio
    setBottomRatio(ratio)
  }

  const moveResponse = (pos: number): void => {
    const shell = shellRef.current?.getBoundingClientRect()
    if (!shell) return
    if (orientation === 'right') {
      const mainWidth = Math.max(1, shell.width - treeWidthRef.current - 5)
      updateRightRatio(clamp((shell.right - pos) / mainWidth, 320 / mainWidth, 0.65))
    } else {
      updateBottomRatio(clamp((shell.bottom - pos) / shell.height, 180 / shell.height, 0.7))
    }
  }

  const nudgeResponse = (delta: number): void => {
    const shell = shellRef.current?.getBoundingClientRect()
    if (!shell) return
    if (orientation === 'right') {
      const mainWidth = Math.max(1, shell.width - treeWidthRef.current - 5)
      updateRightRatio(clamp(rightRatioRef.current + delta / mainWidth, 320 / mainWidth, 0.65))
    } else {
      updateBottomRatio(
        clamp(bottomRatioRef.current + delta / shell.height, 180 / shell.height, 0.7),
      )
    }
  }

  const commitResponse = (): void => {
    savePref('rightRatio', rightRatioRef.current)
    savePref('bottomRatio', bottomRatioRef.current)
  }

  return (
    <div className="app">
      <div
        className="shell"
        ref={shellRef}
        data-testid="shell"
        style={
          {
            '--tree-width': `${treeWidth}px`,
            '--response-width': `${rightRatio * 100}%`,
            '--response-height': `${bottomRatio * 100}%`,
          } as CSSProperties
        }
      >
        <TreePane />
        <Splitter
          orientation="vertical"
          label="调整项目树宽度"
          testId="splitter-tree"
          onDrag={(x) => updateTreeWidth(clamp(x, 180, maxTreeWidth()))}
          onNudge={(d) => updateTreeWidth(clamp(treeWidthRef.current + d, 180, maxTreeWidth()))}
          onEnd={() => savePref('treeWidth', treeWidthRef.current)}
        />
        <div className="main-col" data-orientation={orientation} data-testid="main-col">
          <EditorPane />
          <Splitter
            orientation={orientation === 'right' ? 'vertical' : 'horizontal'}
            label={orientation === 'right' ? '调整响应面板宽度' : '调整响应面板高度'}
            testId="splitter-response"
            onDrag={moveResponse}
            onNudge={nudgeResponse}
            onEnd={commitResponse}
          />
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
              <div className="pane-actions">
                <button
                  className="pill ghost"
                  title="命令面板 (Ctrl+K)"
                  aria-label="打开命令面板"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Icon name="search" size={14} />
                </button>
                <button
                  className="pill ghost"
                  title="切换响应面板方向 (Ctrl+`)"
                  aria-label="切换响应面板方向"
                  onClick={toggleOrientation}
                >
                  <Icon
                    name="panel"
                    size={14}
                    style={orientation === 'bottom' ? { transform: 'rotate(90deg)' } : undefined}
                  />
                </button>
              </div>
            </div>
            {pane === 'response' ? <ResponsePane /> : <RunnerPane />}
          </div>
        </div>
      </div>

      <StatusBar hello={hello} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        setPane={setPane}
        toggleOrientation={toggleOrientation}
      />

      {toast && (
        <div className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          <Icon name={toast.kind === 'error' ? 'cross' : 'check'} size={14} />
          {toast.text}
        </div>
      )}
      {sendPending && (
        <button
          className="pill danger cancel-float"
          title="取消当前请求"
          onClick={() => void cancelSend()}
        >
          <Icon name="cross" size={14} /> 取消
        </button>
      )}
    </div>
  )
}
