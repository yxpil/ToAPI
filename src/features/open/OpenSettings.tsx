// @author yxpil
import { useState } from 'react'
import { useOpen } from '../../stores/open.store'
import { Icon } from '../../components/Icon'

/**
 * 开放调用设置（11 号文档 §0/§1/§2.3）：开关、端口、限流、调用密码、客户端与调用审计。
 * 面板内不显示任何已存密码，只显示「是否已设置」与本次新生成的那一次。
 */
export function OpenSettings() {
  const {
    config,
    clients,
    log,
    settingsOpen,
    setSettingsOpen,
    save,
    rotate,
    revoke,
    revealed,
    clearRevealed,
  } = useOpen()
  const [password, setPassword] = useState('')
  const [port, setPort] = useState('')
  const [lanConfirmed, setLanConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!settingsOpen) return null

  const close = (): void => setSettingsOpen(false)

  const submitPassword = async (): Promise<void> => {
    try {
      setError(null)
      if (password.trim().length > 0 && password.trim().length < 8) {
        setError('调用密码至少 8 位')
        return
      }
      await save({ password })
      setPassword('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="overlay" onPointerDown={close}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-title"
        data-testid="open-settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="open-title">
          开放调用
        </div>
        <p className="dialog-text">
          让脚本、CI 与 AI 客户端通过 Local HTTP API 或 MCP 调用 ToAPI。默认关闭，只监听本机。
        </p>

        <label className="field">
          <span>启用</span>
          <input
            type="checkbox"
            checked={config?.enabled ?? false}
            aria-label="启用开放通道"
            data-testid="open-enabled"
            disabled={!config?.hasPassword}
            title={config?.hasPassword ? '启用后开始监听' : '请先设置调用密码'}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
        </label>
        {!config?.hasPassword && (
          <div className="tapi-error">未设置调用密码前不能启用：外部调用必须有口令。</div>
        )}

        <div className="field">
          <span>监听地址</span>
          <div className="segmented" role="tablist" aria-label="访问范围">
            <button
              type="button"
              aria-selected={(config?.access ?? 'loopback') === 'loopback'}
              title="仅本机 127.0.0.1"
              onClick={() => void save({ access: 'loopback' })}
            >
              仅本机
            </button>
            <button
              type="button"
              aria-selected={config?.access === 'lan'}
              disabled={!lanConfirmed}
              title={lanConfirmed ? '允许局域网访问' : '需先勾选下方二次确认'}
              onClick={() => void save({ access: 'lan' })}
            >
              局域网
            </button>
          </div>
        </div>
        <label className="field">
          <span>局域网确认</span>
          <input
            type="checkbox"
            checked={lanConfirmed}
            aria-label="确认暴露到局域网"
            data-testid="open-lan-confirm"
            onChange={(e) => setLanConfirmed(e.target.checked)}
          />
        </label>
        {config?.access === 'lan' && (
          <div className="node-hint" data-testid="open-lan-hint">
            已对局域网开放，本机可被其他 ToAPI 配对（节点协议强制加密）。明文 /v1/* 端点跨机不加密，
            只建议本机脚本使用；跨机互传与代为测试请走「节点」面板。
          </div>
        )}

        <label className="field">
          <span>端口</span>
          <input
            type="number"
            min={1024}
            max={65535}
            placeholder={String(config?.port ?? 4730)}
            value={port}
            aria-label="监听端口"
            data-testid="open-port"
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => {
              const next = Number.parseInt(port, 10)
              if (Number.isFinite(next) && next >= 1024) void save({ port: next })
              setPort('')
            }}
          />
        </label>

        <div className="field">
          <span>调用密码</span>
          <input
            type="password"
            placeholder={config?.hasPassword ? '已设置（输入新值替换，留空清除）' : '至少 8 位'}
            value={password}
            spellCheck={false}
            aria-label="新调用密码"
            data-testid="open-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="pill" title="应用调用密码" onClick={() => void submitPassword()}>
            应用
          </button>
          <button
            className="pill ghost"
            title="随机生成一次性的调用密码"
            onClick={() => void rotate()}
          >
            <Icon name="refresh" size={14} /> 生成
          </button>
        </div>
        {revealed && (
          <div className="open-revealed">
            <code title={revealed}>{revealed}</code>
            <button className="pill ghost" title="我已保存，不再显示" onClick={clearRevealed}>
              <Icon name="check" size={14} /> 已记录
            </button>
          </div>
        )}
        {error && <div className="tapi-error">{error}</div>}

        <div className="open-block">
          <div className="tree-group">已授权客户端</div>
          {clients.length === 0 && <div className="meta">还没有外部客户端连接过</div>}
          {clients.map((client) => (
            <div className="open-row" key={client.id}>
              <Icon name={client.kind === 'mcp' ? 'doc' : 'send'} size={14} />
              <span className="label" title={client.id}>
                {client.name}
              </span>
              <span className="meta">
                {client.kind} · 最近 {new Date(client.lastSeenAt).toLocaleString()}
              </span>
              <button
                className="pill ghost"
                title="撤销该客户端授权"
                onClick={() => void revoke(client.id)}
              >
                撤销
              </button>
            </div>
          ))}
        </div>

        <div className="open-block">
          <div className="tree-group">外部调用记录</div>
          {log.length === 0 && <div className="meta">暂无外部调用</div>}
          {log.map((row) => (
            <div className="open-row" key={row.id} title={row.paramsSummary}>
              <Icon name={row.ok ? 'check' : 'cross'} size={14} />
              <span className="label">{row.tool}</span>
              <span className="meta">
                {row.channel} · {row.client} · {Math.round(row.timeMs)}ms
                {row.errorCode ? ` · ${row.errorCode}` : ''}
              </span>
            </div>
          ))}
        </div>

        <div className="open-block">
          <div className="tree-group">接入方式</div>
          <pre className="open-snippet">{`# AI 客户端（MCP stdio）
{"command": "toapi", "args": ["mcp", "--db", "<toapi.db 路径>"], "env": {"TOAPI_OPEN_SECRET": "<调用密码>"}}

# 脚本 / CI（Local HTTP API）
curl -H "Authorization: Bearer <调用密码>" ${config?.baseUrl ?? ''}/v1/health
curl -X POST -H "Authorization: Bearer <调用密码>" -H "content-type: application/json" \\
  -d '{"apiId":"<接口 id>"}' ${config?.baseUrl ?? ''}/v1/send`}</pre>
        </div>

        <div className="dialog-actions">
          <button className="pill" title="关闭（Esc）" onClick={close} data-testid="open-close">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/** 首次连接 / 越界 host 的授权条：默认 60s 未操作按拒绝处理 */
export function OpenApprovalBar() {
  const { approvals, decide } = useOpen()
  const [showSkill, setShowSkill] = useState(false)
  const pending = approvals[0]
  if (!pending) return null
  return (
    <div className="open-approval" role="alertdialog" data-testid="open-approval">
      <div className="open-approval-body">
        <div className="dialog-title">
          {pending.clientId.startsWith('host:') ? '外部调用要访问新地址' : '外部客户端请求接入'}
        </div>
        <div className="meta">{pending.detail}</div>
        {pending.skillPreview && (
          <>
            <button
              className="pill ghost"
              title="查看将交付给 AI 的说明书摘要"
              onClick={() => setShowSkill((v) => !v)}
            >
              <Icon name="doc" size={14} /> {showSkill ? '收起说明书' : '查看说明书摘要'}
            </button>
            {showSkill && <pre className="open-snippet">{pending.skillPreview}</pre>}
          </>
        )}
      </div>
      <div className="open-approval-actions">
        <button
          className="pill danger"
          title="拒绝并记录"
          onClick={() => void decide(pending.clientId, false)}
          data-testid="open-approval-deny"
        >
          拒绝
        </button>
        <button
          className="pill primary"
          title="允许该客户端调用只读与执行工具"
          onClick={() => void decide(pending.clientId, true)}
          data-testid="open-approval-allow"
        >
          允许
        </button>
      </div>
    </div>
  )
}
