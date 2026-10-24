// @author yxpil
import { readFileSync, writeFileSync } from 'node:fs'
import { IpcErrorRaised } from '@shared/types'
import type {
  TapiExportInput,
  TapiExportResult,
  TapiImportInput,
  TapiImportResult,
  TapiInspection,
} from '@shared/channels'
import type { Db } from '../db/database'
import type { Repos } from '../db/repo'
import { buildTapi } from './export'
import { importTapi, inspectTapi, readTapi } from './import'
import type { TapiFile } from './format'

const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface TapiDialogs {
  /** 保存对话框 + 写盘；取消返回 null */
  saveText: (defaultName: string, content: string, filters?: string[]) => Promise<string | null>
}

export interface TapiServiceDeps {
  db: Db
  repos: Repos
  appVersion: () => string
  dialogs?: TapiDialogs
}

export class TapiService {
  constructor(private readonly deps: TapiServiceDeps) {}

  private parse(text: string): TapiFile {
    return readTapi(text)
  }

  /** 导出：filePath 缺省时走保存对话框（08 号文档 §7） */
  async export(input: TapiExportInput): Promise<TapiExportResult> {
    const { file, stats, containsSecrets } = buildTapi(this.deps.repos, {
      projectId: input.projectId,
      ...(input.collectionIds && input.collectionIds.length > 0
        ? { collectionIds: input.collectionIds }
        : {}),
      secrets: input.secrets ?? 'strip',
      appVersion: this.deps.appVersion(),
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
    })
    const content = `${JSON.stringify(file, null, 2)}\n`
    const defaultName = `${(input.name ?? file.payload.project.name).replace(/[\\/:*?"<>|]/g, '_')}.tapi`

    let filePath = input.filePath
    if (!filePath) {
      if (!this.deps.dialogs)
        throw new IpcErrorRaised({
          code: 'VALIDATION',
          message: '未指定 filePath 且当前环境没有保存对话框',
        })
      const picked = await this.deps.dialogs.saveText(defaultName, content, ['tapi', 'json'])
      if (!picked) throw new IpcErrorRaised({ code: 'CANCELLED', message: '已取消导出' })
      filePath = picked
    } else {
      writeFileSync(filePath, content, 'utf8')
    }
    return { filePath, stats, containsSecrets }
  }

  /** 导入预览：不写库；GUI 用文件输入或粘贴内容走这里 */
  inspect(source: { content?: string; filePath?: string }): TapiInspection {
    return inspectTapi(this.deps.repos, this.parse(this.read(source)))
  }

  import(input: TapiImportInput): TapiImportResult {
    const file = this.parse(this.read(input))
    const inspection = inspectTapi(this.deps.repos, file)
    if (!inspection.supported)
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `format_version ${file.format_version} 高于本应用支持范围，请升级 ToAPI`,
      })
    if (!inspection.checksumOk)
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: '校验和不匹配：文件可能在传输中被修改，请确认来源后再重新导出导入',
      })
    const report = importTapi(this.deps.db, this.deps.repos, {
      file,
      mode: input.mode ?? 'new',
      ...(input.targetProjectId ? { targetProjectId: input.targetProjectId } : {}),
      ...(input.apiConflict ? { apiConflict: input.apiConflict } : {}),
    })
    return { ...report, inspection }
  }

  private read(source: { content?: string; filePath?: string }): string {
    if (source.content !== undefined) {
      if (source.content.length > MAX_FILE_BYTES)
        throw new IpcErrorRaised({ code: 'VALIDATION', message: '文件超过 50MB，请拆分后再导入' })
      return source.content
    }
    if (!source.filePath)
      throw new IpcErrorRaised({ code: 'VALIDATION', message: 'content 与 filePath 必须二选一' })
    try {
      const text = readFileSync(source.filePath, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES)
        throw new IpcErrorRaised({ code: 'VALIDATION', message: '文件超过 50MB，请拆分后再导入' })
      return text
    } catch (e) {
      if (e instanceof IpcErrorRaised) throw e
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `文件不可读：${source.filePath}（${(e as Error).message}）`,
      })
    }
  }
}
