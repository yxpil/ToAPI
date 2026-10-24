// @author yxpil
import { useState } from 'react'
import type { NotifyChannelFlags, NotifyEventType, WebhookTemplate } from '@shared/channels'
import { NOTIFY_EVENT_TYPES } from '@shared/channels'
import { useNotify } from '../../stores/notify.store'
import { Icon } from '../../components/Icon'

/** 通知设置（15 号文档 §3.1/§4）：事件 × 通道订阅矩阵、托盘驻留、Webhook 配置 */

const CHANNELS: { key: keyof NotifyChannelFlags; label: string; hint: string }[] = [
  { key: 'toast', label: 'Toast', hint: '窗口前台时的底部药丸提示' },
  { key: 'os', label: '系统通知', hint: '窗口失焦或收进托盘时发 OS 原生通知' },
  { key: 'sound', label: '声音', hint: '系统通知带提示音，遵守系统勿扰' },
  { key: 'webhook', label: 'Webhook', hint: 'POST 到机器人地址，需先在下方配置' },
]

const TYPE_LABEL: Record<NotifyEventType, string> = {
  'runner.finished': '运行完成',
  'runner.failed': '运行失败',
  'task.finished': '定时任务完成',
  'task.misfire': '定时任务补跑',
  'node.finished': '节点代为测试',
  'open.denied': '外部调用异常',
  'db.failed': '数据库错误',
}

const TEMPLATES: { value: WebhookTemplate; label: string }[] = [
  { value: 'raw', label: '原始 JSON' },
  { value: 'wecom', label: '企业微信' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'feishu', label: '飞书' },
]

export function NotifySettings() {
  const { settingsOpen, settings, setSettingsOpen, saveSettings, testWebhook, webhookResult } =
    useNotify()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!settingsOpen || !settings) return null
  const close = (): void => void setSettingsOpen(false)

  const toggle = (type: NotifyEventType, channel: keyof NotifyChannelFlags): void => {
    const current = settings.rules[type][channel]
    void saveSettings({ rules: { [type]: { [channel]: !current } } }).catch((e: Error) =>
      setError(e.message),
    )
  }

  const submitUrl = (): void => {
    setError(null)
    void saveSettings({ webhookUrl: url })
      .then(() => setUrl(''))
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div className="overlay" onPointerDown={close}>
      <div
        className="dialog postman-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notify-settings-title"
        data-testid="notify-settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="notify-settings-title">
          通知设置
        </div>
        <p className="dialog-text">
          通知中心始终留痕，这里只决定用什么方式打扰你。相同事件 60 秒内合并为一条。
        </p>

        <table className="notify-matrix">
          <thead>
            <tr>
              <th>事件</th>
              {CHANNELS.map((c) => (
                <th key={c.key} title={c.hint}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFY_EVENT_TYPES.map((type) => (
              <tr key={type}>
                <td title={type}>{TYPE_LABEL[type]}</td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="notify-cell">
                    <input
                      type="checkbox"
                      checked={settings.rules[type][c.key]}
                      aria-label={`${TYPE_LABEL[type]} · ${c.label}`}
                      onChange={() => toggle(type, c.key)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <label className="field">
          <span>关闭窗口时最小化到托盘</span>
          <input
            type="checkbox"
            checked={settings.closeToTray}
            aria-label="关闭窗口时最小化到托盘"
            data-testid="notify-tray"
            onChange={(e) => void saveSettings({ closeToTray: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>定时任务只在结果变化时通知</span>
          <input
            type="checkbox"
            checked={settings.stateChangeOnly}
            aria-label="定时任务只在结果变化时通知"
            onChange={(e) => void saveSettings({ stateChangeOnly: e.target.checked })}
          />
        </label>

        <div className="field">
          <span>Webhook 地址</span>
          {/* URL 视为敏感配置，输入后以掩码显示（15 号文档 §3.3） */}
          <input
            type="password"
            placeholder={
              settings.webhookUrl === ''
                ? 'https://qyapi.weixin.qq.com/...'
                : '已设置（输入新值替换，留空清除）'
            }
            value={url}
            spellCheck={false}
            aria-label="Webhook 地址"
            data-testid="notify-webhook-url"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="pill" title="保存 Webhook 地址" onClick={submitUrl}>
            应用
          </button>
        </div>

        <div className="field">
          <span>消息模板</span>
          <div className="segmented" role="tablist" aria-label="Webhook 模板">
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-selected={settings.webhookTemplate === t.value}
                title={`按 ${t.label} 机器人格式发送`}
                onClick={() => void saveSettings({ webhookTemplate: t.value })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>连通性</span>
          <button
            className="pill ghost"
            title="向当前地址发一条测试消息"
            data-testid="notify-webhook-test"
            onClick={() =>
              void testWebhook(settings.webhookUrl, settings.webhookTemplate).catch((e: Error) =>
                setError(e.message),
              )
            }
          >
            <Icon name="send" size={14} /> 发送测试消息
          </button>
          {webhookResult && (
            <span className={webhookResult.ok ? 'meta' : 'tapi-error'}>
              {webhookResult.ok
                ? `已送达（${webhookResult.status}）`
                : `失败：${webhookResult.error}`}
            </span>
          )}
        </div>

        {error && <div className="tapi-error">{error}</div>}

        <div className="dialog-actions">
          <button className="pill" title="关闭（Esc）" onClick={close} data-testid="notify-close">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
