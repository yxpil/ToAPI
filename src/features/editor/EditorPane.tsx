// @author yxpil
import { useState } from 'react'
import type { Api, Auth, Extractor, FakeConfig, HttpMethod } from '@shared/types'
import { HTTP_METHODS } from '@shared/types'
import { useApp } from '../../stores/app.store'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/EmptyState'
import { Spinner } from '../../components/Spinner'
import { KvTable } from './KvTable'

type Tab = 'params' | 'headers' | 'auth' | 'fake' | 'body' | 'extractors' | 'scripts'

const TABS: { id: Tab; label: string }[] = [
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'auth', label: 'Auth' },
  { id: 'fake', label: '伪装' },
  { id: 'body', label: 'Body' },
  { id: 'extractors', label: '提取器' },
  { id: 'scripts', label: '脚本' },
]

const SCRIPT_API_HINT =
  '可用：toapi.request.setHeader/setBody/skip/send · toapi.vars/env/globals · toapi.fake.ua/header/proxy/timeout · toapi.test/expect · toapi.md5/sha256/hmacSha256/base64Encode/uuid/timestamp/sleep/log'

const UA_PRESETS = [
  '@preset:chrome-win',
  '@preset:chrome-mac',
  '@preset:firefox-win',
  '@preset:edge-win',
  '@preset:safari-ios',
  '@preset:postman',
  '@preset:curl',
  '@preset:okhttp',
]

export function EditorPane() {
  const { api, patchApi, send, saveApi, sendPending, savePending, createApi } = useApp()
  const [tab, setTab] = useState<Tab>('params')

  if (!api) {
    return (
      <div className="workspace" data-testid="editor">
        <EmptyState
          text="左侧选择接口，或新建一个开始调试"
          action={
            <button
              className="pill ghost"
              title="新建接口"
              onClick={() => void createApi('新接口')}
            >
              <Icon name="plus" size={14} /> 新建接口
            </button>
          }
        />
      </div>
    )
  }

  const patchFake = (next: Partial<FakeConfig>): void =>
    patchApi({ fake: { ...api.fake, ...next } })
  const patchAuth = (next: Partial<Auth>): void =>
    patchApi({ auth: { ...api.auth, ...next } as Auth })
  const patchExtractor = (index: number, next: Partial<Extractor>): void =>
    patchApi({ extractors: api.extractors.map((e, i) => (i === index ? { ...e, ...next } : e)) })

  return (
    <div className="workspace" data-testid="editor">
      <div className="title-row">
        <input
          className="name-input"
          value={api.name}
          aria-label="接口名称"
          placeholder="接口名称"
          data-testid="api-name"
          onChange={(e) => patchApi({ name: e.target.value })}
        />
        <button
          className="pill"
          title="保存 (Ctrl+S)"
          data-testid="save"
          onClick={() => void saveApi()}
          disabled={savePending}
        >
          {savePending ? <Spinner label="保存中" /> : <Icon name="check" size={14} />} 保存
        </button>
      </div>
      <div className="url-bar">
        <div className="url-capsule">
          <select
            className={`method-select badge ${HTTP_METHODS.includes(api.method) ? api.method : 'OTHER'}`}
            value={api.method}
            aria-label="请求方法"
            title="请求方法"
            data-testid="method"
            onChange={(e) => patchApi({ method: e.target.value as HttpMethod })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="url-input"
            value={api.url}
            placeholder="https://api.example.com/users?{{query}}"
            aria-label="请求 URL"
            data-testid="url-input"
            spellCheck={false}
            onChange={(e) => patchApi({ url: e.target.value })}
          />
          <button
            className="send-pill"
            title="发送 (Ctrl+Enter)"
            data-testid="send"
            onClick={() => void send()}
            disabled={sendPending}
          >
            {sendPending ? <Spinner label="发送中" /> : <Icon name="send" size={14} />} 发送
          </button>
        </div>
      </div>

      <div className="tab-row">
        <div className="segmented text-tabs" role="tablist" aria-label="请求编辑分区">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={t.label}
              data-testid={`tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-scroll">
        {tab === 'params' && (
          <KvTable
            rows={api.params}
            onChange={(rows) => patchApi({ params: rows })}
            keyPlaceholder="query 名"
            emptyText="暂无查询参数"
          />
        )}

        {tab === 'headers' && (
          <KvTable
            rows={api.headers}
            onChange={(rows) => patchApi({ headers: rows })}
            keyPlaceholder="Header 名"
            emptyText="暂无自定义 Header"
          />
        )}

        {tab === 'auth' && (
          <>
            <div className="field">
              <span>类型</span>
              <select
                value={api.auth.type}
                aria-label="鉴权类型"
                onChange={(e) => {
                  const type = e.target.value as Auth['type']
                  const next: Auth =
                    type === 'bearer'
                      ? { type, token: '' }
                      : type === 'basic'
                        ? { type, username: '', password: '' }
                        : type === 'apikey'
                          ? { type, key: '', value: '', addTo: 'header' }
                          : { type: 'none' }
                  patchApi({ auth: next })
                }}
              >
                <option value="none">无</option>
                <option value="bearer">Bearer</option>
                <option value="basic">Basic</option>
                <option value="apikey">API Key</option>
              </select>
            </div>
            {api.auth.type === 'bearer' && (
              <div className="field">
                <span>Token</span>
                <input
                  value={api.auth.token}
                  placeholder="{{token}}"
                  aria-label="Token"
                  onChange={(e) => patchAuth({ token: e.target.value } as Partial<Auth>)}
                />
              </div>
            )}
            {(api.auth.type === 'basic' || api.auth.type === 'apikey') && (
              <>
                <div className="field">
                  <span>{api.auth.type === 'basic' ? '用户名' : 'Header 名'}</span>
                  <input
                    value={api.auth.type === 'basic' ? api.auth.username : api.auth.key}
                    aria-label="标识"
                    onChange={(e) =>
                      patchAuth(
                        api.auth.type === 'basic'
                          ? ({ username: e.target.value } as Partial<Auth>)
                          : ({ key: e.target.value } as Partial<Auth>),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <span>{api.auth.type === 'basic' ? '密码' : '值'}</span>
                  <input
                    value={api.auth.type === 'basic' ? api.auth.password : api.auth.value}
                    aria-label="凭证"
                    onChange={(e) =>
                      patchAuth(
                        api.auth.type === 'basic'
                          ? ({ password: e.target.value } as Partial<Auth>)
                          : ({ value: e.target.value } as Partial<Auth>),
                      )
                    }
                  />
                </div>
              </>
            )}
            {api.auth.type === 'apikey' && (
              <div className="field">
                <span>位置</span>
                <select
                  value={api.auth.addTo}
                  aria-label="API Key 位置"
                  onChange={(e) =>
                    patchAuth({ addTo: e.target.value as 'header' | 'query' } as Partial<Auth>)
                  }
                >
                  <option value="header">Header</option>
                  <option value="query">Query</option>
                </select>
              </div>
            )}
          </>
        )}

        {tab === 'fake' && (
          <>
            <div className="field">
              <span>User-Agent</span>
              <input
                list="ua-presets"
                value={api.fake.ua ?? ''}
                placeholder="@preset:okhttp 或任意字符串"
                aria-label="User-Agent"
                onChange={(e) => patchFake({ ua: e.target.value })}
              />
            </div>
            <datalist id="ua-presets">
              {UA_PRESETS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <div className="field">
              <span>代理</span>
              <input
                type="checkbox"
                checked={api.fake.proxy?.enabled ?? false}
                aria-label="启用代理"
                onChange={(e) =>
                  patchFake({
                    proxy: {
                      enabled: e.target.checked,
                      url: api.fake.proxy?.url ?? 'http://127.0.0.1:7890',
                    },
                  })
                }
              />
              <input
                value={api.fake.proxy?.url ?? ''}
                placeholder="http://127.0.0.1:7890"
                aria-label="代理地址"
                disabled={!(api.fake.proxy?.enabled ?? false)}
                onChange={(e) => patchFake({ proxy: { enabled: true, url: e.target.value } })}
              />
            </div>
            <div className="field">
              <span>超时 ms</span>
              <input
                type="number"
                min={100}
                max={600000}
                value={api.fake.timeoutMs ?? 30000}
                aria-label="超时毫秒"
                onChange={(e) => patchFake({ timeoutMs: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <span>跟随重定向</span>
              <input
                type="checkbox"
                checked={api.fake.followRedirects ?? true}
                aria-label="跟随重定向"
                onChange={(e) => patchFake({ followRedirects: e.target.checked })}
              />
              <input
                type="number"
                min={0}
                max={20}
                value={api.fake.maxRedirects ?? 5}
                aria-label="最大重定向次数"
                title="最大重定向次数"
                onChange={(e) => patchFake({ maxRedirects: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <span>忽略 TLS 错误</span>
              <input
                type="checkbox"
                checked={api.fake.ignoreTlsErrors ?? false}
                aria-label="忽略证书错误"
                title="仅当前请求生效"
                onChange={(e) => patchFake({ ignoreTlsErrors: e.target.checked })}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="tree-group">伪装 Header（覆盖同名默认头）</div>
              <KvTable
                rows={api.fake.headers ?? []}
                onChange={(rows) => patchFake({ headers: rows })}
                keyPlaceholder="Header 名"
                emptyText="暂无伪装 Header"
              />
            </div>
          </>
        )}

        {tab === 'body' && (
          <>
            <div className="field">
              <span>类型</span>
              <select
                value={api.bodyType}
                aria-label="Body 类型"
                onChange={(e) => patchApi({ bodyType: e.target.value as Api['bodyType'] })}
              >
                <option value="none">none</option>
                <option value="json">json</option>
                <option value="form">form</option>
                <option value="urlencoded">urlencoded</option>
                <option value="raw">raw</option>
                <option value="binary">binary</option>
              </select>
            </div>
            {api.bodyType !== 'none' && (
              <textarea
                className="body-area"
                value={api.body}
                spellCheck={false}
                aria-label="请求体"
                placeholder='{ "id": "{{orderId}}" }'
                onChange={(e) => patchApi({ body: e.target.value })}
              />
            )}
          </>
        )}

        {tab === 'extractors' && (
          <>
            {api.extractors.map((ex, index) => (
              <div className="field" key={`${ex.name}-${index}`}>
                <input
                  value={ex.name}
                  placeholder="变量名"
                  aria-label="提取变量名"
                  onChange={(e) => patchExtractor(index, { name: e.target.value })}
                />
                <select
                  value={ex.source}
                  aria-label="来源"
                  onChange={(e) =>
                    patchExtractor(index, { source: e.target.value as Extractor['source'] })
                  }
                >
                  <option value="body">body</option>
                  <option value="header">header</option>
                  <option value="status">status</option>
                </select>
                <select
                  value={ex.type}
                  aria-label="类型"
                  onChange={(e) =>
                    patchExtractor(index, { type: e.target.value as Extractor['type'] })
                  }
                >
                  <option value="jsonpath">jsonpath</option>
                  <option value="regex">regex</option>
                </select>
                <input
                  value={ex.expr}
                  placeholder="$.data.token"
                  aria-label="表达式"
                  onChange={(e) => patchExtractor(index, { expr: e.target.value })}
                />
                <select
                  value={ex.scope}
                  aria-label="作用域"
                  onChange={(e) =>
                    patchExtractor(index, { scope: e.target.value as Extractor['scope'] })
                  }
                >
                  <option value="runtime">runtime</option>
                  <option value="env">env</option>
                  <option value="global">global</option>
                </select>
                <button
                  className="pill ghost"
                  title="删除提取器"
                  aria-label="删除提取器"
                  onClick={() =>
                    patchApi({ extractors: api.extractors.filter((_, i) => i !== index) })
                  }
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            ))}
            <button
              className="pill"
              title="添加提取器"
              onClick={() =>
                patchApi({
                  extractors: [
                    ...api.extractors,
                    { name: '', source: 'body', type: 'jsonpath', expr: '$.', scope: 'runtime' },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> 添加提取器
            </button>
          </>
        )}

        {tab === 'scripts' && (
          <>
            <div className="tree-group" title={SCRIPT_API_HINT}>
              前置脚本（发送前执行，可改写请求、发子请求、跳过）
            </div>
            <textarea
              className="body-area"
              value={api.preScript}
              spellCheck={false}
              aria-label="前置脚本"
              placeholder={
                "const ts = toapi.timestamp()\ntoapi.request.setHeader('X-Sign', toapi.md5('secret' + ts))"
              }
              onChange={(e) => patchApi({ preScript: e.target.value })}
            />
            <div className="tree-group">后置脚本（收到响应后执行，用于断言与写变量）</div>
            <textarea
              className="body-area"
              value={api.postScript}
              spellCheck={false}
              aria-label="后置脚本"
              placeholder={
                "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))"
              }
              onChange={(e) => patchApi({ postScript: e.target.value })}
            />
            <div style={{ color: 'var(--ink-tertiary)', fontSize: 12 }}>{SCRIPT_API_HINT}</div>
          </>
        )}
      </div>
    </div>
  )
}
