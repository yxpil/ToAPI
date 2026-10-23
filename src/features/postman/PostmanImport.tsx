import { useEffect, useRef, useState } from 'react'
import type { PostmanImportReport, PostmanInspect } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { Icon } from '../../components/Icon'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

const PREVIEW_LIMIT = 6

/** Postman 资产导入（23 号文档 §8）：粘贴或选文件 → 自动识别 → 预览 → 导入 */
export function PostmanImport({ open, projectId, onClose }: Props) {
  const { inspectPostman, importPostman, importEnvironment, tree } = useApp()
  const projectName = tree.find((n) => n.project.id === projectId)?.project.name ?? null
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [inspected, setInspected] = useState<PostmanInspect | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'new' | 'into'>('new')
  const [overwrite, setOverwrite] = useState(false)
  const [pending, setPending] = useState(false)
  const [report, setReport] = useState<PostmanImportReport | null>(null)
  const seq = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setContent('')
      setFileName('')
      setInspected(null)
      setError(null)
      setMode('new')
      setOverwrite(false)
      setPending(false)
      setReport(null)
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    const text = content.trim()
    if (!open || text === '') {
      setInspected(null)
      setError(null)
      return
    }
    const ticket = seq.current + 1
    seq.current = ticket
    const timer = setTimeout(() => {
      void inspectPostman({ content }).then((result) => {
        if (seq.current !== ticket) return
        if (!result) {
          setInspected(null)
          setError('无法识别该文件，请确认是 Postman Collection v2.1 或 Environment 导出')
          return
        }
        setInspected(result)
        setError(null)
        if (result.kind === 'environment') setMode('new')
      })
    }, 350)
    return () => clearTimeout(timer)
  }, [content, open, inspectPostman])

  if (!open) return null

  const needsProject = inspected?.kind === 'environment' && !projectId
  const canImport = Boolean(inspected) && !pending && !needsProject

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setFileName(file.name)
    setError(null)
    try {
      setContent(await file.text())
    } catch (e) {
      setError(`文件读取失败：${(e as Error).message}`)
    }
  }

  const submit = async (): Promise<void> => {
    if (!inspected || !canImport) return
    setPending(true)
    try {
      const result =
        inspected.kind === 'collection'
          ? await importPostman({
              content,
              mode,
              ...(mode === 'into' && projectId ? { targetProjectId: projectId } : {}),
            })
          : await importEnvironment({
              content,
              projectId: projectId ?? '',
              mode: overwrite ? 'overwrite' : 'new',
            })
      if (!result) return
      if (result.warnings.length > 0) setReport(result)
      else onClose()
    } finally {
      setPending(false)
    }
  }

  if (report) {
    const { collections, apis, variables } = report.counts
    return (
      <div className="overlay" onPointerDown={onClose}>
        <div
          className="dialog postman-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="postman-report-title"
          data-testid="postman-report"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="dialog-title" id="postman-report-title">
            导入报告
          </div>
          <p className="dialog-text">
            导入完成：{collections} 集合 · {apis} 接口 · {variables} 变量 · {report.warnings.length}{' '}
            条提示
          </p>
          <section className="postman-preview postman-report">
            <ul className="postman-warnings">
              {report.warnings.map((w) => (
                <li key={`${w.path}:${w.code}`} title={w.message}>
                  <code>{w.path || '/'}</code> {w.message}
                </li>
              ))}
            </ul>
          </section>
          <div className="dialog-actions">
            <button
              className="pill primary"
              title="完成"
              data-testid="postman-report-done"
              onClick={onClose}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onPointerDown={onClose}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="postman-title"
        data-testid="postman-import"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="postman-title">
          导入 Postman 资产
        </div>
        <p className="dialog-text">
          支持 Collection v2.1 与 Environment 导出文件；粘贴 JSON 或选择本地文件，自动识别类型。
        </p>

        <div className="postman-picker">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="postman-file"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
          <button className="pill" title="选择 JSON 文件" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} /> 选择文件
          </button>
          <span className="postman-filename" title={fileName}>
            {fileName || '未选择文件'}
          </span>
        </div>

        <textarea
          className="postman-textarea"
          value={content}
          placeholder="或在此粘贴 Postman Collection / Environment JSON"
          aria-label="Postman JSON 内容"
          data-testid="postman-content"
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
        />

        {error && (
          <p className="postman-error" role="alert">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}

        {inspected && (
          <section className="postman-preview" data-testid="postman-preview">
            <div className="postman-preview-head">
              <span className={`pill postman-kind ${inspected.kind}`}>
                {inspected.kind === 'collection' ? 'Collection' : 'Environment'}
              </span>
              <span className="postman-name" title={inspected.name}>
                {inspected.name}
              </span>
            </div>
            <div className="postman-counts">
              {inspected.kind === 'collection' ? (
                <>
                  <span>{inspected.counts.collections} 集合</span>
                  <span>{inspected.counts.apis} 接口</span>
                </>
              ) : null}
              <span>{inspected.counts.variables} 变量</span>
              <span>{inspected.counts.scripts} 脚本</span>
            </div>
            {inspected.warnings.length > 0 && (
              <ul className="postman-warnings">
                {inspected.warnings.slice(0, PREVIEW_LIMIT).map((w) => (
                  <li key={`${w.path}:${w.code}`} title={w.message}>
                    <code>{w.path || '/'}</code> {w.message}
                  </li>
                ))}
                {inspected.warnings.length > PREVIEW_LIMIT && (
                  <li className="muted">还有 {inspected.warnings.length - PREVIEW_LIMIT} 条提示</li>
                )}
              </ul>
            )}
          </section>
        )}

        {inspected?.kind === 'collection' && (
          <div className="postman-modes" role="radiogroup" aria-label="导入方式">
            <label>
              <input
                type="radio"
                name="postman-mode"
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              新建项目
            </label>
            <label className={projectId ? '' : 'disabled'}>
              <input
                type="radio"
                name="postman-mode"
                checked={mode === 'into'}
                disabled={!projectId}
                onChange={() => setMode('into')}
              />
              导入到{projectName ? `「${projectName}」` : '当前项目'}
            </label>
          </div>
        )}

        {inspected?.kind === 'environment' && (
          <label className="postman-overwrite">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            同名环境覆盖变量
          </label>
        )}

        {needsProject && (
          <p className="postman-error" role="alert">
            <Icon name="alert" size={14} /> 环境需要归属项目，请先在左侧选择或创建项目
          </p>
        )}

        <div className="dialog-actions">
          <button className="pill" title="取消（Esc）" onClick={onClose}>
            取消
          </button>
          <button
            className="pill primary"
            title="开始导入"
            disabled={!canImport}
            data-testid="postman-import-ok"
            onClick={() => void submit()}
          >
            {pending ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
