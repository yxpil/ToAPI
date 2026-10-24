// @author yxpil
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 大 body / 报告 / 导出文件落盘（03 号文档 §5），DB 只存路径 */
export class FileStore {
  constructor(private readonly root: string) {
    mkdirSync(join(root, 'bodies'), { recursive: true })
    mkdirSync(join(root, 'reports'), { recursive: true })
  }

  private bodyPath(id: string): string {
    return join(this.root, 'bodies', `${id}.bin`)
  }

  writeBody(id: string, data: Uint8Array): string {
    const path = this.bodyPath(id)
    writeFileSync(path, data)
    return path
  }

  readBody(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path))
  }

  reportsDir(): string {
    return join(this.root, 'reports')
  }

  removeBody(path: string): void {
    rmSync(path, { force: true })
  }
}
