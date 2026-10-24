// @author yxpil
import { useRef, useState } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import type { ProjectNode, TreeApiNode, TreeCollectionNode } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { useRunner } from '../../stores/runner.store'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/EmptyState'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { RenameDialog } from '../../components/RenameDialog'

const methodClass = (method: string): string =>
  ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) ? method : 'OTHER'

type DragPayload = { type: 'api' | 'collection'; id: string; projectId: string }

interface DragState extends DragPayload {
  key: string
}

type MenuState =
  | { kind: 'project'; x: number; y: number; node: ProjectNode }
  | {
      kind: 'collection'
      x: number
      y: number
      node: TreeCollectionNode
      projectId: string
      siblings: TreeCollectionNode[]
      index: number
    }
  | {
      kind: 'api'
      x: number
      y: number
      api: TreeApiNode
      collection: TreeCollectionNode
      projectId: string
    }

interface ConfirmState {
  title: string
  text: string
  onConfirm: () => void
}

interface RenameState {
  kind: 'project' | 'collection' | 'api'
  id: string
  title: string
  label: string
  current: string
}

const countCollections = (nodes: TreeCollectionNode[]): number =>
  nodes.reduce((n, c) => n + 1 + countCollections(c.children), 0)

const countApis = (nodes: TreeCollectionNode[]): number =>
  nodes.reduce((n, c) => n + c.apis.length + countApis(c.children), 0)

const readPayload = (e: DragEvent, fallback: DragState | null): DragPayload | null => {
  try {
    const raw = e.dataTransfer.getData('text/plain')
    if (raw) return JSON.parse(raw) as DragPayload
  } catch {
    /* 非本应用的拖拽载荷 */
  }
  return fallback
}

interface CollectionProps {
  node: TreeCollectionNode
  depth: number
  projectId: string
  siblings: TreeCollectionNode[]
  index: number
  dragging: DragState | null
  dropTarget: { key: string; pos: 'before' | 'after' | 'into' } | null
  setDragging: (d: DragState | null) => void
  setDropTarget: (d: { key: string; pos: 'before' | 'after' | 'into' } | null) => void
  setMenu: (m: MenuState) => void
  setConfirm: (c: ConfirmState) => void
  setRenaming: (r: RenameState) => void
}

function CollectionBlock({
  node,
  depth,
  projectId,
  siblings,
  index,
  dragging,
  dropTarget,
  setDragging,
  setDropTarget,
  setMenu,
  setConfirm,
  setRenaming,
}: CollectionProps) {
  const { selectedApiId, selectApi, moveNode } = useApp()
  const runCollection = useRunner((s) => s.runCollection)

  const apiDrop = (e: DragEvent, api: TreeApiNode): void => {
    e.preventDefault()
    e.stopPropagation()
    const payload = readPayload(e, dragging)
    setDropTarget(null)
    setDragging(null)
    if (!payload || payload.type !== 'api' || payload.id === api.id) return
    if (payload.projectId !== projectId) return
    const list = node.apis
    const at = list.findIndex((a) => a.id === api.id)
    if (at < 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    void moveNode({
      nodeType: 'api',
      id: payload.id,
      targetParentId: node.id,
      beforeSortOrder: before ? (list[at - 1]?.sortOrder ?? null) : api.sortOrder,
      afterSortOrder: before ? api.sortOrder : (list[at + 1]?.sortOrder ?? null),
    })
  }

  const collectionDrop = (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const payload = readPayload(e, dragging)
    setDropTarget(null)
    setDragging(null)
    if (!payload || payload.id === node.id || payload.projectId !== projectId) return

    if (payload.type === 'api') {
      void moveNode({
        nodeType: 'api',
        id: payload.id,
        targetParentId: node.id,
        beforeSortOrder: null,
        afterSortOrder: null,
      })
      return
    }

    const rect = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    void moveNode({
      nodeType: 'collection',
      id: payload.id,
      targetParentId: node.parentId ?? projectId,
      beforeSortOrder: before ? (siblings[index - 1]?.sortOrder ?? null) : node.sortOrder,
      afterSortOrder: before ? node.sortOrder : (siblings[index + 1]?.sortOrder ?? null),
    })
  }

  const drop = dropTarget?.key === `c-${node.id}` ? dropTarget.pos : null

  return (
    <>
      <div
        className={`tree-row${drop ? ` drop-${drop}` : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        title={`${node.name} · ${node.children.length + node.apis.length} 个子项`}
        data-testid={`collection-${node.id}`}
        draggable
        onDragStart={(e) => {
          const payload: DragPayload = { type: 'collection', id: node.id, projectId }
          e.dataTransfer.setData('text/plain', JSON.stringify(payload))
          e.dataTransfer.effectAllowed = 'move'
          setDragging({ ...payload, key: `c-${node.id}` })
        }}
        onDragEnd={() => {
          setDragging(null)
          setDropTarget(null)
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.projectId !== projectId) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (dragging.type === 'api') {
            setDropTarget({ key: `c-${node.id}`, pos: 'into' })
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setDropTarget({
            key: `c-${node.id}`,
            pos: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
          })
        }}
        onDragLeave={() => {
          if (dropTarget?.key === `c-${node.id}`) setDropTarget(null)
        }}
        onDrop={collectionDrop}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({
            kind: 'collection',
            x: e.clientX,
            y: e.clientY,
            node,
            projectId,
            siblings,
            index,
          })
        }}
      >
        <Icon name="folder" size={14} />
        <span className="label">{node.name}</span>
        <span className="row-actions">
          <button
            className="pill ghost"
            title="运行集合"
            aria-label="运行集合"
            onClick={(e) => {
              e.stopPropagation()
              void runCollection(node.id, node.name)
            }}
          >
            <Icon name="send" size={14} />
          </button>
        </span>
      </div>
      {node.apis.map((api) => {
        const apiDropPos = dropTarget?.key === `a-${api.id}` ? dropTarget.pos : null
        return (
          <div
            key={api.id}
            className={`tree-row${selectedApiId === api.id ? ' selected' : ''}${
              apiDropPos ? ` drop-${apiDropPos}` : ''
            }`}
            style={{ paddingLeft: 12 + (depth + 1) * 14 }}
            onClick={() => void selectApi(api.id)}
            title={`${api.method} ${api.url}`}
            data-testid={`api-${api.id}`}
            draggable
            onDragStart={(e) => {
              const payload: DragPayload = { type: 'api', id: api.id, projectId }
              e.dataTransfer.setData('text/plain', JSON.stringify(payload))
              e.dataTransfer.effectAllowed = 'move'
              setDragging({ ...payload, key: `a-${api.id}` })
            }}
            onDragEnd={() => {
              setDragging(null)
              setDropTarget(null)
            }}
            onDragOver={(e) => {
              if (!dragging || dragging.projectId !== projectId || dragging.type !== 'api') return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              setDropTarget({
                key: `a-${api.id}`,
                pos: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
              })
            }}
            onDragLeave={() => {
              if (dropTarget?.key === `a-${api.id}`) setDropTarget(null)
            }}
            onDrop={(e) => apiDrop(e, api)}
            onContextMenu={(e: MouseEvent) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({
                kind: 'api',
                x: e.clientX,
                y: e.clientY,
                api,
                collection: node,
                projectId,
              })
            }}
          >
            <span className={`badge ${methodClass(api.method)}`}>{api.method}</span>
            <span className="label">{api.name}</span>
            <span className="row-actions">
              <button
                className="pill ghost"
                title="删除接口"
                aria-label="删除接口"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirm({
                    title: '删除接口',
                    text: `删除接口「${api.name}」？删除后不可恢复，历史保留。`,
                    onConfirm: () => void useApp.getState().removeApi(api.id),
                  })
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
        )
      })}
      {node.children.map((child, i) => (
        <CollectionBlock
          key={child.id}
          node={child}
          depth={depth + 1}
          projectId={projectId}
          siblings={node.children}
          index={i}
          dragging={dragging}
          dropTarget={dropTarget}
          setDragging={setDragging}
          setDropTarget={setDropTarget}
          setMenu={setMenu}
          setConfirm={setConfirm}
          setRenaming={setRenaming}
        />
      ))}
    </>
  )
}

export function TreePane() {
  const {
    tree,
    activeProjectId,
    selectProject,
    createProject,
    createCollection,
    createApi,
    removeProject,
    removeCollection,
    duplicateApi,
    renameNode,
    selectApi,
    moveNode,
    openPostmanImport,
    openTapiImport,
    exportCollection,
    exportTapi,
  } = useApp()
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    key: string
    pos: 'before' | 'after' | 'into'
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = (): void => {
    const value = name.trim()
    if (!value) return
    void createProject(value)
    setName('')
  }

  const menuItems = (state: MenuState): MenuItem[] => {
    if (state.kind === 'project') {
      const collections = countCollections(state.node.collections)
      const apis = countApis(state.node.collections)
      return [
        { label: '新建集合', onSelect: () => void createCollection('新集合') },
        { label: '新建接口', onSelect: () => void createApi('新接口') },
        { label: '导入 Postman…', onSelect: openPostmanImport },
        { label: '导入 .tapi…', onSelect: openTapiImport },
        {
          label: '导出为 .tapi…',
          onSelect: () => void exportTapi(state.node.project.id),
        },
        {
          label: '导出为 Postman Collection…',
          onSelect: () => void exportCollection(state.node.project.id),
        },
        {
          label: '重命名项目',
          onSelect: () =>
            setRenaming({
              kind: 'project',
              id: state.node.project.id,
              title: '重命名项目',
              label: '新名称',
              current: state.node.project.name,
            }),
        },
        {
          label: '删除项目',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: '删除项目',
              text: `删除项目「${state.node.project.name}」？其下 ${collections} 个集合、${apis} 个接口将一并删除，历史保留。`,
              onConfirm: () => void removeProject(state.node.project.id),
            }),
        },
      ]
    }
    if (state.kind === 'collection') {
      const apis = countApis([state.node])
      return [
        { label: '新建接口', onSelect: () => void createApi('新接口', state.node.id) },
        {
          label: '运行集合',
          onSelect: () => void useRunner.getState().runCollection(state.node.id, state.node.name),
        },
        {
          label: '导出为 Postman Collection…',
          onSelect: () => void exportCollection(state.projectId, [state.node.id]),
        },
        {
          label: '导出该集合为 .tapi…',
          onSelect: () => void exportTapi(state.projectId, [state.node.id]),
        },
        {
          label: '重命名集合',
          onSelect: () =>
            setRenaming({
              kind: 'collection',
              id: state.node.id,
              title: '重命名集合',
              label: '新名称',
              current: state.node.name,
            }),
        },
        {
          label: '删除集合',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: '删除集合',
              text: `删除集合「${state.node.name}」？其下 ${apis} 个接口将一并删除，历史保留。`,
              onConfirm: () => void removeCollection(state.node.id),
            }),
        },
      ]
    }
    return [
      { label: '打开', onSelect: () => void selectApi(state.api.id) },
      { label: '复制接口', onSelect: () => void duplicateApi(state.api.id) },
      {
        label: '重命名接口',
        onSelect: () =>
          setRenaming({
            kind: 'api',
            id: state.api.id,
            title: '重命名接口',
            label: '新名称',
            current: state.api.name,
          }),
      },
      {
        label: '删除接口',
        danger: true,
        onSelect: () =>
          setConfirm({
            title: '删除接口',
            text: `删除接口「${state.api.name}」？删除后不可恢复，历史保留。`,
            onConfirm: () => void useApp.getState().removeApi(state.api.id),
          }),
      },
    ]
  }

  return (
    <aside className="tree" data-testid="tree">
      <div className="tree-editor">
        <input
          ref={inputRef}
          value={name}
          placeholder="新建项目名称"
          aria-label="项目名称"
          data-testid="new-project-input"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="pill ghost" title="创建项目" aria-label="创建项目" onClick={submit}>
          <Icon name="plus" size={14} />
        </button>
        <button
          className="pill ghost"
          title="导入 Postman Collection / Environment"
          aria-label="导入 Postman"
          data-testid="postman-open"
          onClick={openPostmanImport}
        >
          <Icon name="upload" size={14} />
        </button>
      </div>

      {tree.length === 0 && (
        <EmptyState
          text="还没有项目，先建一个"
          action={
            <button
              className="pill ghost"
              title="新建项目"
              onClick={() => inputRef.current?.focus()}
            >
              <Icon name="plus" size={14} /> 新建项目
            </button>
          }
        />
      )}

      {tree.map((node) => (
        <section key={node.project.id}>
          <div
            className={`tree-row${activeProjectId === node.project.id ? ' selected' : ''}${
              dropTarget?.key === `p-${node.project.id}` ? ' drop-into' : ''
            }`}
            onClick={() => void selectProject(node.project.id)}
            title={node.project.description || node.project.name}
            data-testid={`project-${node.project.id}`}
            onDragOver={(e) => {
              if (!dragging || dragging.projectId !== node.project.id) return
              if (dragging.type !== 'collection') return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTarget({ key: `p-${node.project.id}`, pos: 'into' })
            }}
            onDragLeave={() => {
              if (dropTarget?.key === `p-${node.project.id}`) setDropTarget(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const payload = readPayload(e, dragging)
              setDragging(null)
              setDropTarget(null)
              if (!payload || payload.type !== 'collection') return
              if (payload.projectId !== node.project.id) return
              void moveNode({
                nodeType: 'collection',
                id: payload.id,
                targetParentId: node.project.id,
                beforeSortOrder: null,
                afterSortOrder: null,
              })
            }}
            onContextMenu={(e: MouseEvent) => {
              e.preventDefault()
              setMenu({ kind: 'project', x: e.clientX, y: e.clientY, node })
            }}
          >
            <Icon name="doc" size={14} />
            <span className="label">{node.project.name}</span>
          </div>

          {activeProjectId === node.project.id && (
            <>
              <div className="tree-row tree-actions" style={{ paddingLeft: 26 }}>
                <button
                  className="pill ghost"
                  title="新建集合"
                  onClick={() => void createCollection('新集合')}
                >
                  <Icon name="plus" size={14} /> 集合
                </button>
                <button
                  className="pill ghost"
                  title="新建接口"
                  onClick={() => void createApi('新接口')}
                >
                  <Icon name="plus" size={14} /> 接口
                </button>
              </div>
              {node.collections.map((child, i) => (
                <CollectionBlock
                  key={child.id}
                  node={child}
                  depth={1}
                  projectId={node.project.id}
                  siblings={node.collections}
                  index={i}
                  dragging={dragging}
                  dropTarget={dropTarget}
                  setDragging={setDragging}
                  setDropTarget={setDropTarget}
                  setMenu={setMenu}
                  setConfirm={setConfirm}
                  setRenaming={setRenaming}
                />
              ))}
            </>
          )}
        </section>
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          text={confirm.text}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.onConfirm()
            setConfirm(null)
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          title={renaming.title}
          label={renaming.label}
          initial={renaming.current}
          onCancel={() => setRenaming(null)}
          onSubmit={(value) => {
            void renameNode(renaming.kind, renaming.id, value)
            setRenaming(null)
          }}
        />
      )}
    </aside>
  )
}
