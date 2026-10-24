// @author yxpil
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Db } from '../db/database'
import { transaction } from '../db/database'
import type { Repos } from '../db/repo'
import type {
  Api,
  PostmanExportResult,
  PostmanImportReport,
  PostmanInspect,
  PostmanWarning,
} from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type {
  PostmanExportCollectionInput,
  PostmanExportEnvironmentInput,
  PostmanImportEnvironmentInput,
  PostmanImportInput,
  PostmanSource,
} from '@shared/channels'
import { buildCollectionExport, buildEnvironmentExport } from './export'
import { countCollection, parseCollection, parseEnvironment } from './parse'
import type { ImportedApi, ImportedCollection, ImportedCollectionModel } from './types'

const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface PostmanDialogs {
  /** 弹保存对话框并写盘；用户取消返回 null。仅 Electron 主进程注入 */
  saveText: (defaultName: string, content: string) => Promise<string | null>
}

export interface PostmanServiceDeps {
  db: Db
  repos: Repos
  dialogs?: PostmanDialogs
}

export class PostmanService {
  constructor(private readonly deps: PostmanServiceDeps) {}

  private readSource(input: PostmanSource): string {
    if (input.content !== undefined) {
      if (input.content.length > MAX_FILE_BYTES)
        throw new IpcErrorRaised({
          code: 'VALIDATION',
          message: '文件超过 50MB，请拆分后再导入',
        })
      return input.content
    }
    if (!input.filePath)
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '缺少 content 或 filePath' })
    try {
      const stat = statSync(input.filePath)
      if (stat.size > MAX_FILE_BYTES)
        throw new IpcErrorRaised({ code: 'VALIDATION', message: '文件超过 50MB，请拆分后再导入' })
      return readFileSync(input.filePath, 'utf8')
    } catch (e) {
      if (e instanceof IpcErrorRaised) throw e
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `文件读取失败：${(e as Error).message}`,
      })
    }
  }

  private static parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown
    } catch (e) {
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `JSON 解析失败：${(e as Error).message}`,
      })
    }
  }

  private static parseResult<T>(build: () => T): T {
    try {
      return build()
    } catch (e) {
      if (e instanceof IpcErrorRaised) throw e
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** 自动识别 Collection / Environment（23 号文档 §3.4） */
  inspect(input: PostmanSource): PostmanInspect {
    const raw = PostmanService.parseJson(this.readSource(input))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '不是有效的 Postman 文件' })
    return PostmanService.parseResult(() => this.inspectRaw(raw))
  }

  private inspectRaw(raw: unknown): PostmanInspect {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj['values']) && obj['info'] === undefined) {
      const { model, warnings } = parseEnvironment(raw)
      return {
        kind: 'environment',
        name: model.name,
        counts: { collections: 0, apis: 0, variables: model.variables.length, scripts: 0 },
        warnings,
        schema: '',
      }
    }
    const { model, warnings } = parseCollection(raw)
    return {
      kind: 'collection',
      name: model.name,
      counts: countCollection(model),
      warnings,
      schema: model.schema,
    }
  }

  importCollection(input: PostmanImportInput): PostmanImportReport {
    const { model, warnings } = PostmanService.parseResult(() =>
      parseCollection(PostmanService.parseJson(this.readSource(input))),
    )
    return transaction(this.deps.db, () => {
      const extra: PostmanWarning[] = []
      let projectId: string
      if (input.mode === 'into') {
        if (!input.targetProjectId)
          throw new IpcErrorRaised({
            code: 'VALIDATION',
            message: '导入到现有项目需要 targetProjectId',
          })
        const project = this.deps.repos.project.get(input.targetProjectId)
        if (!project) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })
        projectId = project.id
        const merged = [...project.variables]
        for (const v of model.variables) {
          if (!merged.some((x) => x.key === v.key)) merged.push(v)
        }
        this.deps.repos.project.update(project.id, {
          variables: merged,
          preScript: [project.preScript, model.preScript].filter(Boolean).join('\n'),
          postScript: [project.postScript, model.postScript].filter(Boolean).join('\n'),
        })
      } else {
        projectId = this.createProject(model, extra)
      }

      const counts = this.insertCollections(projectId, model)
      if (model.rootApis.length > 0) {
        const placeholder = this.deps.repos.collection.create({
          projectId,
          name: '根集合',
        })
        this.deps.repos.collection.update(placeholder.id, {
          description: '承接 Postman 顶层请求（导出时还原为顶层 item）',
        })
        this.deps.repos.collection.setSortOrder(
          placeholder.id,
          Math.min(...model.rootApis.map((a) => a.sortOrder)) - 1,
        )
        this.deps.repos.source.set('collection', placeholder.id, {
          __toapiRootPlaceholder: true,
          item: { name: '根集合' },
        })
        for (const api of model.rootApis) {
          if (api.preScript) counts.scripts += 1
          if (api.postScript) counts.scripts += 1
          this.insertApi(placeholder.id, api)
        }
        counts.collections += 1
        counts.apis += model.rootApis.length
      }

      return {
        projectId,
        counts,
        warnings: [...warnings, ...extra],
        preserved: this.preservedCount(projectId),
      }
    })
  }

  private createProject(model: ImportedCollectionModel, warnings: PostmanWarning[]): string {
    const repos = this.deps.repos
    const base = model.name || '导入的集合'
    let name = base
    let n = 2
    while (repos.project.list().some((p) => p.name === name)) {
      name = `${base} (${n})`
      n += 1
    }
    if (name !== base)
      warnings.push({
        path: '/info/name',
        code: 'PROJECT_RENAMED',
        message: `同名项目已存在，导入为「${name}」`,
      })
    const project = repos.project.create({ name, description: model.description })
    repos.project.update(project.id, {
      auth: model.auth,
      variables: model.variables,
      preScript: model.preScript,
      postScript: model.postScript,
    })
    repos.source.set('project', project.id, model.source)
    return project.id
  }

  private insertCollections(
    projectId: string,
    model: ImportedCollectionModel,
  ): { collections: number; apis: number; variables: number; scripts: number } {
    const counts = { collections: 0, apis: 0, variables: model.variables.length, scripts: 0 }
    if (model.preScript) counts.scripts += 1
    if (model.postScript) counts.scripts += 1
    for (const node of model.collections) {
      this.insertCollectionNode(projectId, null, node, counts)
    }
    return counts
  }

  private insertCollectionNode(
    projectId: string,
    parentId: string | null,
    node: ImportedCollection,
    counts: { collections: number; apis: number; variables: number; scripts: number },
  ): void {
    const repos = this.deps.repos
    const created = repos.collection.create({ projectId, parentId, name: node.name })
    repos.collection.update(created.id, {
      description: node.description,
      auth: node.auth,
      variables: node.variables,
      preScript: node.preScript,
      postScript: node.postScript,
    })
    repos.collection.setSortOrder(created.id, node.sortOrder)
    repos.source.set('collection', created.id, node.source)
    counts.collections += 1
    counts.variables += node.variables.length
    if (node.preScript) counts.scripts += 1
    if (node.postScript) counts.scripts += 1
    for (const api of node.apis) {
      if (api.preScript) counts.scripts += 1
      if (api.postScript) counts.scripts += 1
      this.insertApi(created.id, api)
    }
    counts.apis += node.apis.length
    for (const child of node.children) {
      this.insertCollectionNode(projectId, created.id, child, counts)
    }
  }

  private insertApi(collectionId: string, imported: ImportedApi): void {
    const repos = this.deps.repos
    const created = repos.api.create({
      collectionId,
      name: imported.name,
      method: imported.method,
      url: imported.url,
    })
    const patch: Partial<Omit<Api, 'id' | 'collectionId' | 'createdAt' | 'updatedAt'>> = {
      name: imported.name,
      description: imported.description,
      method: imported.method,
      url: imported.url,
      params: imported.params,
      headers: imported.headers,
      bodyType: imported.bodyType,
      body: imported.body,
      auth: imported.auth,
      fake: imported.fake,
      preScript: imported.preScript,
      postScript: imported.postScript,
      extractors: imported.extractors,
      sortOrder: imported.sortOrder,
    }
    repos.api.update(created.id, patch)
    repos.source.set('api', created.id, imported.source)
  }

  private preservedCount(projectId: string): number {
    const repos = this.deps.repos
    let n = 0
    if (Object.keys(repos.source.get('project', projectId)).length > 0) n += 1
    for (const c of repos.collection.listByProject(projectId)) {
      if (Object.keys(repos.source.get('collection', c.id)).length > 0) n += 1
      for (const a of repos.api.listByCollection(c.id)) {
        if (Object.keys(repos.source.get('api', a.id)).length > 0) n += 1
      }
    }
    return n
  }

  importEnvironment(input: PostmanImportEnvironmentInput): PostmanImportReport {
    const { model, warnings } = PostmanService.parseResult(() =>
      parseEnvironment(PostmanService.parseJson(this.readSource(input))),
    )
    return transaction(this.deps.db, () => {
      const repos = this.deps.repos
      if (!repos.project.get(input.projectId))
        throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })
      const existing = repos.environment
        .listByProject(input.projectId)
        .find((e) => e.name === model.name)
      let env = existing ?? null
      if (existing && input.mode === 'overwrite') {
        repos.variable.removeForEnv(existing.id)
      } else if (existing) {
        let name = `${model.name} (2)`
        let n = 3
        while (repos.environment.listByProject(input.projectId).some((e) => e.name === name)) {
          name = `${model.name} (${n})`
          n += 1
        }
        env = repos.environment.create({ projectId: input.projectId, name })
        warnings.push({
          path: '/name',
          code: 'ENV_RENAMED',
          message: `同名环境已存在，导入为「${name}」`,
        })
      } else {
        env = repos.environment.create({ projectId: input.projectId, name: model.name })
      }
      if (!env) throw new IpcErrorRaised({ code: 'INTERNAL', message: '环境创建失败' })
      for (const v of model.variables) {
        repos.variable.upsert({
          scope: 'environment',
          environmentId: env.id,
          key: v.key,
          value: v.value,
          secret: v.secret,
          enabled: v.enabled,
        })
      }
      repos.source.set('environment', env.id, model.source)
      return {
        projectId: input.projectId,
        environmentId: env.id,
        counts: { collections: 0, apis: 0, variables: model.variables.length, scripts: 0 },
        warnings,
        preserved: 1,
      }
    })
  }

  exportCollection(input: PostmanExportCollectionInput): Promise<PostmanExportResult> {
    const repos = this.deps.repos
    const project = repos.project.get(input.projectId)
    if (!project) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })
    if (input.collectionIds && input.collectionIds.length > 0) {
      const owned = new Set(repos.collection.listByProject(project.id).map((c) => c.id))
      for (const id of input.collectionIds) {
        if (!owned.has(id))
          throw new IpcErrorRaised({ code: 'VALIDATION', message: `集合 ${id} 不属于该项目` })
      }
    }
    const { json, counts } = buildCollectionExport(repos, project, input.collectionIds)
    return this.writeOut(
      `${safeName(project.name)}.postman_collection.json`,
      json,
      input.filePath,
      counts,
    )
  }

  exportEnvironment(input: PostmanExportEnvironmentInput): Promise<PostmanExportResult> {
    const repos = this.deps.repos
    const env = repos.environment.get(input.environmentId)
    if (!env) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '环境不存在' })
    const { json, counts } = buildEnvironmentExport(repos, env)
    return this.writeOut(`${safeName(env.name)}.postman_environment.json`, json, input.filePath, {
      collections: 0,
      apis: 0,
      variables: counts.variables,
    })
  }

  private async writeOut(
    defaultName: string,
    json: Record<string, unknown>,
    filePath: string | undefined,
    counts: { collections: number; apis: number; variables: number },
  ): Promise<PostmanExportResult> {
    const content = `${JSON.stringify(json, null, 2)}\n`
    if (filePath) {
      writeFileSync(filePath, content, 'utf8')
      return { filePath, counts }
    }
    if (!this.deps.dialogs)
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: '缺少 filePath（当前环境无保存对话框）',
      })
    const chosen = await this.deps.dialogs.saveText(defaultName, content)
    if (!chosen) throw new IpcErrorRaised({ code: 'CANCELLED', message: '已取消导出' })
    return { filePath: chosen, counts }
  }
}

const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_')
