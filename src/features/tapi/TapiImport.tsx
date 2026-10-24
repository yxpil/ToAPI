// @author yxpil
import { useEffect, useRef, useState } from 'react'
import type { TapiInspection } from '@shared/channels'
import { useApp } from '../../stores/app.store'
import { Icon } from '../../components/Icon'

/** 预览摘要：一行一项，纯文字 + 辅助色，无卡片（06 号文档 §3.7） */
function TapiSummary({ inspection }: { inspection: TapiInspection }) {
  const { stats } = inspection
  const rows: [string, string][] = [
    ['项目', inspection.name],
    ['来源版本', inspection.appVersion || '未知'],
    ['格式', `tapi ${inspection.formatVersion}`],
    [
      '内容',
      `${String(stats.collections)} 集合 · ${String(stats.apis)} 接口 · ${String(stats.environments)} 环境 · ${String(stats.globals)} 全局变量`,
    ],
    ['校验和', inspection.checksumOk ? '一致' : '不一致'],
    [
      '敏感变量',
      inspection.containsSecrets
        ? '文件内含明文密钥'
        : inspection.redactedCount > 0
          ? `已剔除 ${String(inspection.redactedCount)} 个，导入后需自行填写`
          : '无',
    ],
  ]
  return (
    <dl className="tapi-summary" data-testid="tapi-summary">
      {rows.map(([label, value]) => (
        <div key={label} className="tapi-summary-row">
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface Props {
  open: boolean
  onClose: () => void
}

/** .tapi 导入（08 号文档 §5）：选文件或粘贴 → 预览 → 策略 → 导入 */
export function TapiImport({ open, onClose }: Props) {
  const { inspectTapi, importTapiFile, tree } = useApp()
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [inspection, setInspection] = useState<TapiInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'new' | 'into'>('new')
  const [target, setTarget] = useState('')
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'duplicate'>('skip')
  const [pending, setPending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!open) {
      setContent('')
      setFileName('')
      setInspection(null)
      setError(null)
      setPending(false)
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
      setInspection(null)
      setError(null)
      return
    }
    const ticket = seq.current + 1
    seq.current = ticket
    const timer = setTimeout(() => {
      void inspectTapi({ content }).then((result) => {
        if (seq.current !== ticket) return
        setInspection(result)
        setError(result ? null : '无法解析该 .tapi 文件，请确认内容来自 ToAPI 导出')
        if (!result) return
        setMode(result.sameNameProjectId ? 'into' : 'new')
        setTarget(result.sameNameProjectId ?? tree[0]?.project.id ?? '')
      })
    }, 350)
    return () => clearTimeout(timer)
  }, [content, open, inspectTapi, tree])

  if (!open) return null

  const blocked = inspection ? !inspection.supported || !inspection.checksumOk : true
  const projectName = tree.find((n) => n.project.id === target)?.project.name ?? null

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
    if (!inspection || blocked || pending) return
    setPending(true)
    try {
      await importTapiFile({
        content,
        mode,
        ...(mode === 'into' && target ? { targetProjectId: target } : {}),
        apiConflict: conflict,
      })
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="overlay" onPointerDown={onClose}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tapi-title"
        data-testid="tapi-import"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="tapi-title">
          导入 .tapi 项目
        </div>
        <p className="dialog-text">
          跨部门互传的单文件用例集。历史记录、Runner 结果与 Cookie 不随文件传递（08 号文档 §4）。
        </p>

        <div className="postman-picker">
          <input
            ref={fileRef}
            type="file"
            accept=".tapi,application/json"
            hidden
            data-testid="tapi-file"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
          <button className="pill" title="选择 .tapi 文件" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} /> 选择文件
          </button>
          <span className="postman-filename" title={fileName}>
            {fileName || '未选择文件'}
          </span>
        </div>

        <textarea
          className="postman-textarea"
          value={content}
          placeholder="或在此粘贴 .tapi 内容"
          aria-label="TAPI 内容"
          data-testid="tapi-content"
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
        />

        {error && <div className="tapi-error">{error}</div>}

        {inspection && (
          <>
            <TapiSummary inspection={inspection} />
            <div className="field">
              <span>导入方式</span>
              <div className="segmented" role="tablist" aria-label="导入方式">
                <button
                  type="button"
                  aria-selected={mode === 'new'}
                  title="新建项目"
                  onClick={() => setMode('new')}
                >
                  新建项目
                </button>
                <button
                  type="button"
                  aria-selected={mode === 'into'}
                  disabled={tree.length === 0}
                  title="合并进现有项目"
                  onClick={() => setMode('into')}
                >
                  合并进现有项目
                </button>
              </div>
            </div>
            {mode === 'into' && (
              <label className="field">
                <span>目标项目</span>
                <select
                  value={target}
                  aria-label="目标项目"
                  data-testid="tapi-target"
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {tree.map((node) => (
                    <option key={node.project.id} value={node.project.id}>
                      {node.project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mode === 'into' && projectName && (
              <p className="dialog-text">
                合并到「{projectName}」：同名集合按名称合并，接口按「方法 + URL + 名称」判重。
              </p>
            )}
            <div className="field">
              <span>判重命中</span>
              <div className="segmented" role="tablist" aria-label="接口判重策略">
                {(
                  [
                    ['skip', '跳过'],
                    ['overwrite', '覆盖'],
                    ['duplicate', '保留两份'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-selected={conflict === value}
                    title={label}
                    onClick={() => setConflict(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {blocked && (
              <div className="tapi-error" data-testid="tapi-blocked">
                {!inspection.supported
                  ? `该文件由更高版本导出（format_version ${inspection.formatVersion}），请升级 ToAPI`
                  : '校验和不匹配：文件可能被修改，已禁止导入'}
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button className="pill" title="取消（Esc）" onClick={onClose} data-testid="tapi-cancel">
            取消
          </button>
          <button
            className="pill primary"
            title="导入项目"
            disabled={inspection === null || blocked || pending}
            onClick={() => void submit()}
            data-testid="tapi-import-ok"
          >
            {pending ? '导入中' : '导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
