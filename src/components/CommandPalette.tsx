// @author yxpil
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TreeCollectionNode } from '@shared/types'
import type { IconName } from './Icon'
import { Icon } from './Icon'
import { useApp } from '../stores/app.store'
import { useRunner } from '../stores/runner.store'

interface Props {
  open: boolean
  onClose: () => void
  setPane: (pane: 'response' | 'runner') => void
  toggleOrientation: () => void
}

interface Command {
  id: string
  label: string
  hint?: string
  detail?: string
  icon: IconName
  run: () => void | Promise<void>
}

const walk = (nodes: TreeCollectionNode[], visit: (node: TreeCollectionNode) => void): void => {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

const countCollections = (nodes: TreeCollectionNode[]): number =>
  nodes.reduce((n, c) => n + 1 + countCollections(c.children), 0)

const countApis = (nodes: TreeCollectionNode[]): number =>
  nodes.reduce((n, c) => n + c.apis.length + countApis(c.children), 0)

/** Ctrl+K 命令面板（06 号文档 §5）：跳接口 / 跑集合 / 切环境 / 快捷动作 */
export function CommandPalette({ open, onClose, setPane, toggleOrientation }: Props) {
  const { tree, envs, activeProjectId, api, selectProject, selectApi, activateEnv, send, saveApi } =
    useApp()
  const runCollection = useRunner((s) => s.runCollection)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []

    if (api) {
      list.push({
        id: 'send',
        label: '发送当前请求',
        hint: 'Ctrl+Enter',
        detail: api.name,
        icon: 'send',
        run: () => send(),
      })
      list.push({
        id: 'save',
        label: '保存当前接口',
        hint: 'Ctrl+S',
        detail: api.name,
        icon: 'check',
        run: () => saveApi(),
      })
    }

    for (const node of tree) {
      const projectId = node.project.id
      const projectName = node.project.name
      list.push({
        id: `project-${projectId}`,
        label: `打开项目 · ${projectName}`,
        detail: `${countCollections(node.collections)} 集合 / ${countApis(node.collections)} 接口`,
        icon: 'folder',
        run: () => selectProject(projectId),
      })
      walk(node.collections, (collection) => {
        list.push({
          id: `run-${collection.id}`,
          label: `运行集合 · ${collection.name}`,
          detail: projectName,
          icon: 'send',
          run: async () => {
            if (activeProjectId !== projectId) await selectProject(projectId)
            setPane('runner')
            await runCollection(collection.id, collection.name)
          },
        })
        for (const item of collection.apis) {
          list.push({
            id: `api-${item.id}`,
            label: item.name,
            hint: item.method,
            // URL 进 detail 才能「按 URL 搜接口」（06 号文档 §5）
            detail: `${projectName} / ${collection.name} · ${item.url}`,
            icon: 'doc',
            run: async () => {
              if (activeProjectId !== projectId) await selectProject(projectId)
              await selectApi(item.id)
              setPane('response')
            },
          })
        }
      })
    }

    for (const env of envs) {
      list.push({
        id: `env-${env.id}`,
        label: `切换环境 · ${env.name}`,
        detail: env.isActive ? '当前环境' : undefined,
        icon: 'refresh',
        run: () => activateEnv(env.id),
      })
    }

    list.push(
      {
        id: 'pane-response',
        label: '显示响应面板',
        icon: 'panel',
        run: () => setPane('response'),
      },
      { id: 'pane-runner', label: '显示 Runner 面板', icon: 'panel', run: () => setPane('runner') },
      {
        id: 'orientation',
        label: '切换响应面板方向',
        hint: 'Ctrl+`',
        icon: 'panel',
        run: toggleOrientation,
      },
    )

    return list
  }, [
    api,
    tree,
    envs,
    activeProjectId,
    selectProject,
    selectApi,
    activateEnv,
    send,
    saveApi,
    runCollection,
    setPane,
    toggleOrientation,
  ])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      `${c.label} ${c.hint ?? ''} ${c.detail ?? ''}`.toLowerCase().includes(q),
    )
  }, [commands, query])

  if (!open) return null

  const selected = Math.min(index, Math.max(0, filtered.length - 1))

  const execute = (command: Command | undefined): void => {
    if (!command) return
    onClose()
    void command.run()
  }

  return (
    <div className="overlay palette-overlay" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        data-testid="command-palette"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="搜索项目、接口、URL、集合、环境或动作"
            aria-label="命令"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                execute(filtered[selected])
              }
            }}
          />
        </div>
        <div className="palette-list" role="listbox" aria-label="命令结果">
          {filtered.length === 0 && <div className="palette-empty">没有匹配项</div>}
          {filtered.map((command, i) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={i === selected}
              title={command.label}
              data-testid="palette-item"
              className={`palette-item${i === selected ? ' selected' : ''}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => execute(command)}
            >
              <Icon name={command.icon} size={14} />
              <span className="palette-label">{command.label}</span>
              {command.detail ? <span className="palette-detail">{command.detail}</span> : null}
              {command.hint ? <kbd>{command.hint}</kbd> : null}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
