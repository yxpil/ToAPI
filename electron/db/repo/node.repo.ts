// @author yxpil
import type { NodeView } from '@shared/channels'
import type { Db } from '../database'
import { ulid } from '../../infra/id'
import { bool, num, optStr, str, type Row } from './rows'

/** 局域网节点表与调用审计（24 号文档 §1）：只存派生信道密钥，绝不存口令明文 */

export interface NodeRow {
  id: string
  name: string
  host: string
  port: number
  deviceId: string
  /** hex 编码的 32 字节信道密钥；对外视图里永不出现 */
  channelKey: string
  fingerprint: string
  confirmedFingerprint: string
  labels: string[]
  enabled: boolean
  addedAt: number
  lastSeenAt: number | null
  lastError: string | null
  /** 出站帧序号：跨进程也要单调，落库记住最后用到的值 */
  seq: number
  /** 每次配对换一个新的轮次标识，对端防重放表按「设备 + 轮次」分lane */
  epoch: string
}

const SQL = {
  insert: `INSERT INTO node (id, name, host, port, device_id, channel_key, fingerprint,
                             confirmed_fingerprint, labels, enabled, added_at, seq, epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 1, ?, ?, ?)`,
  update: `UPDATE node SET name = ?, host = ?, port = ?, labels = ?, enabled = ? WHERE id = ?`,
  setKey: `UPDATE node SET channel_key = ?, fingerprint = ?, device_id = ?, last_error = NULL,
                           epoch = ?, seq = ? WHERE id = ?`,
  bumpSeq: 'UPDATE node SET seq = seq + 1 WHERE id = ? RETURNING seq',
  confirm: 'UPDATE node SET confirmed_fingerprint = ? WHERE id = ?',
  seen: 'UPDATE node SET last_seen_at = ?, last_error = NULL WHERE id = ?',
  failed: 'UPDATE node SET last_error = ? WHERE id = ?',
  delete: 'DELETE FROM node WHERE id = ?',
  all: 'SELECT * FROM node ORDER BY added_at',
  byId: 'SELECT * FROM node WHERE id = ?',
  log: `INSERT INTO node_call_log (id, node_id, peer, action, ok, error_code, time_ms, items, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  recentLog: 'SELECT * FROM node_call_log ORDER BY created_at DESC LIMIT ?',
  trimLog: `DELETE FROM node_call_log WHERE id NOT IN (
              SELECT id FROM node_call_log ORDER BY created_at DESC LIMIT ?
            )`,
} as const

/** 审计日志容量（与 external_call_log 同规则） */
const KEEP_LOG = 5000

const map = (row: Row): NodeRow => ({
  id: str(row['id']),
  name: str(row['name']),
  host: str(row['host']),
  port: num(row['port']),
  deviceId: str(row['device_id']),
  channelKey: str(row['channel_key']),
  fingerprint: str(row['fingerprint']),
  confirmedFingerprint: str(row['confirmed_fingerprint']),
  labels: str(row['labels'])
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  enabled: bool(row['enabled']),
  addedAt: num(row['added_at']),
  lastSeenAt: row['last_seen_at'] === null ? null : num(row['last_seen_at']),
  lastError: optStr(row['last_error']),
  seq: num(row['seq']),
  epoch: str(row['epoch']),
})

export const toView = (row: NodeRow): NodeView => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  deviceId: row.deviceId,
  fingerprint: row.fingerprint,
  confirmedFingerprint: row.confirmedFingerprint,
  /** 指纹未锁定或口令换过：只能只读探测，不能执行写操作 */
  trusted: row.fingerprint !== '' && row.fingerprint === row.confirmedFingerprint,
  labels: row.labels,
  enabled: row.enabled,
  addedAt: row.addedAt,
  lastSeenAt: row.lastSeenAt,
  lastError: row.lastError,
})

export interface NewNodeRow {
  name: string
  host: string
  port: number
  labels: string[]
  channelKey: string
  fingerprint: string
  deviceId: string
  seq: number
  epoch: string
}

/** 节点调用留痕（24 号文档 §1）：nodeId 为空表示"被对方调用"的入站记录 */
export interface NodeCallLogRow {
  id: string
  nodeId: string
  peer: string
  action: string
  ok: boolean
  errorCode: string | null
  timeMs: number
  items: number
  createdAt: number
}

export class NodeRepo {
  constructor(private readonly db: Db) {}

  create(input: NewNodeRow): NodeRow {
    const id = ulid()
    this.db
      .prepare(SQL.insert)
      .run(
        id,
        input.name,
        input.host,
        input.port,
        input.deviceId,
        input.channelKey,
        input.fingerprint,
        input.labels.join(','),
        Date.now(),
        input.seq,
        input.epoch,
      )
    return this.require(id)
  }

  require(id: string): NodeRow {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    if (!row) throw new Error(`节点不存在：${id}`)
    return map(row)
  }

  get(id: string): NodeRow | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? map(row) : null
  }

  list(): NodeRow[] {
    return (this.db.prepare(SQL.all).all() as unknown as Row[]).map(map)
  }

  update(
    id: string,
    patch: { name?: string; host?: string; port?: number; labels?: string[]; enabled?: boolean },
  ): NodeRow {
    const current = this.require(id)
    const next = {
      name: patch.name ?? current.name,
      host: patch.host ?? current.host,
      port: patch.port ?? current.port,
      labels: patch.labels ?? current.labels,
      enabled: patch.enabled ?? current.enabled,
    }
    this.db
      .prepare(SQL.update)
      .run(next.name, next.host, next.port, next.labels.join(','), next.enabled ? 1 : 0, id)
    return this.require(id)
  }

  /** 重新配对（换口令或换盐）：密钥与指纹都要重写，旧的锁定指纹与序号轮次作废 */
  setChannel(
    id: string,
    channelKey: string,
    fingerprint: string,
    deviceId: string,
    epoch: string,
    seq: number,
  ): NodeRow {
    this.db.prepare(SQL.setKey).run(channelKey, fingerprint, deviceId, epoch, seq, id)
    this.db.prepare(SQL.confirm).run('', id)
    return this.require(id)
  }

  /** 占用下一个出站序号：序号必须比上一次的更大，否则对端按重放拒绝 */
  nextSeq(id: string): number {
    const row = this.db.prepare(SQL.bumpSeq).get(id) as Row | undefined
    return row ? num(row['seq']) : 1
  }

  confirm(id: string): NodeRow {
    const current = this.require(id)
    this.db.prepare(SQL.confirm).run(current.fingerprint, id)
    return this.require(id)
  }

  markSeen(id: string): void {
    this.db.prepare(SQL.seen).run(Date.now(), id)
  }

  markFailed(id: string, message: string): void {
    this.db.prepare(SQL.failed).run(message.slice(0, 300), id)
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  log(input: {
    /** 出站调用所属节点；入站调用留空 */
    nodeId: string
    /** 对端标识：出站为 host:port，入站为解密帧里的 deviceId */
    peer?: string
    action: string
    ok: boolean
    errorCode?: string | null
    timeMs: number
    items?: number
  }): void {
    this.db
      .prepare(SQL.log)
      .run(
        ulid(),
        input.nodeId,
        input.peer ?? '',
        input.action,
        input.ok ? 1 : 0,
        input.errorCode ?? null,
        Math.round(input.timeMs),
        input.items ?? 0,
        Date.now(),
      )
    this.db.prepare(SQL.trimLog).run(KEEP_LOG)
  }

  recentLog(limit: number): NodeCallLogRow[] {
    return (this.db.prepare(SQL.recentLog).all(limit) as unknown as Row[]).map((row) => ({
      id: str(row['id']),
      nodeId: str(row['node_id']),
      peer: str(row['peer']),
      action: str(row['action']),
      ok: bool(row['ok']),
      errorCode: optStr(row['error_code']),
      timeMs: num(row['time_ms']),
      items: num(row['items']),
      createdAt: num(row['created_at']),
    }))
  }
}
