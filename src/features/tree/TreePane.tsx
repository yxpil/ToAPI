import { useState } from 'react'
import type { ProjectNode, TreeCollectionNode } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { useRunner } from '../../stores/runner.store'
import { Icon } from '../../components/Icon'

const methodClass = (method: string): string =>
  ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) ? method : 'OTHER'

function CollectionBlock({ node, depth }: { node: TreeCollectionNode; depth: number }) {
  const { selectedApiId, selectApi, removeApi } = useApp()
  const runCollection = useRunner((s) => s.runCollection)
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: 12 + depth * 14 }}
        title={`${node.children.length + node.apis.length} 个子项`}
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
      {node.apis.map((api) => (
        <div
          key={api.id}
          className={`tree-row${selectedApiId === api.id ? ' selected' : ''}`}
          style={{ paddingLeft: 12 + (depth + 1) * 14 }}
          onClick={() => void selectApi(api.id)}
          title={`${api.method} ${api.url}`}
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
                void removeApi(api.id)
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
      ))}
      {node.children.map((child) => (
        <CollectionBlock key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

export function TreePane() {
  const { tree, activeProjectId, selectProject, createProject, createCollection, createApi } =
    useApp()
  const [name, setName] = useState('')

  const submit = (): void => {
    const value = name.trim()
    if (!value) return
    void createProject(value)
    setName('')
  }

  return (
    <aside className="tree">
      <div className="tree-editor">
        <input
          value={name}
          placeholder="新建项目名称"
          aria-label="项目名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="pill ghost" title="创建项目" aria-label="创建项目" onClick={submit}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      {tree.length === 0 && <div className="empty">还没有项目，先建一个</div>}

      {tree.map((node: ProjectNode) => (
        <section key={node.project.id}>
          <div
            className={`tree-row${activeProjectId === node.project.id ? ' selected' : ''}`}
            onClick={() => void selectProject(node.project.id)}
            title={node.project.description || node.project.name}
          >
            <Icon name="doc" size={14} />
            <span className="label">{node.project.name}</span>
          </div>

          {activeProjectId === node.project.id && (
            <>
              <div className="tree-row" style={{ paddingLeft: 26 }}>
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
              {node.collections.map((child) => (
                <CollectionBlock key={child.id} node={child} depth={1} />
              ))}
            </>
          )}
        </section>
      ))}
    </aside>
  )
}
