# ToAPI — 内部 API 设计规范（IPC 契约）

> 本规范约束渲染进程与主进程之间的全部通信。它等同于本项目的"API 设计规范"：
> 所有跨进程调用必须经过 IpcRouter，统一命名、统一载荷、统一错误格式。

## 1. 总原则

1. **单入口**：渲染进程只能通过 `window.toapi.invoke(channel, payload)` / `window.toapi.on(channel, cb)` 通信，Preload 白名单校验 channel。
2. **命名**：`域:动作`，动词小写，如 `api:send`、`project:list`、`runner:start`。
3. **校验**：每个 channel 在主进程侧用 zod schema 校验入参；非法载荷直接拒绝，不进业务层。
4. **错误统一**：失败返回 `IpcError`，不 throw 裸 Error 给渲染进程。
5. **幂等与取消**：耗时操作（发送请求、Runner）必须支持 `cancelId` 取消。

## 2. 标准载荷格式

### 成功
```ts
type IpcOk<T> = { ok: true; data: T }
```
### 失败
```ts
type IpcErr = {
  ok: false
  error: {
    code: string        // 机器可读，如 'VALIDATION' / 'NETWORK' / 'SCRIPT_TIMEOUT'
    message: string     // 人类可读
    details?: unknown   // zod issues / 脚本堆栈等
  }
}
type IpcResult<T> = IpcOk<T> | IpcErr
```
渲染进程任何调用都先判 `ok`，禁止 `try/catch` 当主流程控制。

## 3. Channel 清单

### 3.1 项目与分类
| Channel | 入参 | 返回 |
|---|---|---|
| `project:list` | `{}` | `Project[]`（含嵌套 collection/api 树，懒加载模式则返回浅层） |
| `project:create` | `{name, description?}` | `Project` |
| `project:update` | `{id, name?, description?, settings?}` | `Project` |
| `project:delete` | `{id}` | `{}` |
| `collection:create` | `{projectId, parentId?, name}` | `Collection` |
| `collection:update` | `{id, name?, preScript?, postScript?}` | `Collection` |
| `collection:delete` | `{id}` | `{}` |
| `tree:move` | `{nodeType:'collection'\|'api', id, targetParentId, beforeSortOrder?, afterSortOrder?}` | `{sortOrder}` |

### 3.2 接口
| Channel | 入参 | 返回 |
|---|---|---|
| `api:get` | `{id}` | `ApiDetail` |
| `api:create` | `{collectionId, name, method?, url?}` | `ApiDetail` |
| `api:update` | `{id, ...partial}` | `ApiDetail` |
| `api:duplicate` | `{id, targetCollectionId?}` | `ApiDetail` |
| `api:delete` | `{id}` | `{}` |
| `api:send` | `{apiId?, draft?, envId?, cancelId}` | `SendResult`（见 §4） |
| `api:cancel` | `{cancelId}` | `{}` |

> `api:send` 支持两种模式：传 `apiId` 发已保存接口；传 `draft` 发未保存的临时请求（如 cURL 导入预览）。

### 3.3 变量与环境
| Channel | 入参 | 返回 |
|---|---|---|
| `env:list` | `{projectId}` | `Environment[]`（含 variables） |
| `env:create / env:update / env:delete` | 常规 | |
| `env:activate` | `{projectId, environmentId}` | `{}` |
| `var:set` | `{scope, environmentId?, key, value, secret?}` | `{}` |
| `var:delete` | `{id}` | `{}` |

### 3.4 历史与 Runner
| Channel | 入参 | 返回 |
|---|---|---|
| `history:list` | `{projectId?, apiId?, cursor?, limit}` | `{items, nextCursor}`（游标分页，禁止 offset） |
| `history:get` | `{id}` | 完整含 body |
| `history:clear` | `{projectId?, beforeTs?}` | `{deleted}` |
| `runner:start` | `{scopeType:'collection'\|'api', scopeId, envId?, cancelId, stopOnFail?, delayMs?}` | `{runId, total}`（结果走事件推送） |
| `runner:cancel` | `{runId}` | `{}` |
| `runner:get` | `{id}` | `RunnerRunView`（含逐项与断言） |
| `runner:list` | `{limit?}` | `Omit<RunnerRunView,'items'>[]` |
| `runner:report` | `{runId, format:'html'\|'json'}` | `{filePath}`（**待实现**，M5） |

### 3.5 协作与代码（详见 08 / 09 / 10 号文档）
| Channel | 入参 | 返回 |
|---|---|---|
| `tapi:export / tapi:inspect / tapi:import` | 见 08 号文档 §7 | |
| `case:run` / `codegen:from-api` / `codegen:to-api` / `testgen:from-history` / `python:detect` | 见 09 号文档 §7 | |
| `md:interpret` / `md:open` / `md:run` / `md:sync` | 见 10 号文档 §2.3 / §4 / §5 | |
| `open:get-config` / `open:set-config` / `open:rotate-token` / `open:list-clients` / `open:revoke-client` / `open:call-log` | 见 11 号文档 §6 | |
| `task:*` / `macro:*`（CRUD、preview、run-now、system-register） | 见 12 号文档 §4 | |
| `load:run` / `load:cancel` / `load:get` / `load:compare` / `event:load-tick` | 见 13 号文档 §3 | |
| `notify:list` / `notify:mark-read` / `notify:mark-all-read` / `notify:get-rules` / `notify:set-rules` / `notify:test-webhook` / `event:notify` | 见 15 号文档 §6 | |
| `ai:get-config` / `ai:set-config` / `ai:test-connection` / `ai:gen-api` / `ai:gen-script` / `ai:gen-schema` / `ai:explain-failure` / `ai:explain-load` / `ai:interpret-md` / `ai:adopt` / `ai:call-log` | 见 16 号文档 §5 | |

### 3.6 事件（主进程 → 渲染进程）
| Channel | 载荷 | 时机 |
|---|---|---|
| `event:send-progress` | `{cancelId, phase:'script'\|'sending'\|'receiving'}` | 请求进行中 |
| `event:runner-progress` | `{runId, item: RunnerItem}` | 每完成一项 |
| `event:script-log` | `{source:'pre'\|'post'\|'test', level, text, ts}` | 脚本 console 输出 |

## 4. 核心类型：SendResult

```ts
type SendResult = {
  finalRequest: {            // 插值 + 脚本 + 伪装后的真实请求
    method: string
    url: string
    headers: [string, string][]
    bodyBase64?: string
  }
  response: {
    status: number
    statusText: string
    headers: [string, string][]
    bodyText?: string        // 小 body 内联
    bodyPath?: string        // 大 body 文件路径
    timeMs: number
    sizeBytes: number
    redirects: {status: number, location: string}[]
  }
  script: {
    preLogs: LogEntry[]
    postLogs: LogEntry[]
    assertions: {name: string, pass: boolean, error?: string}[]
  }
  extracted: {name: string, scope: string, valuePreview: string}[]
}
```

## 5. 错误码表

| code | 含义 | 典型处理 |
|---|---|---|
| `VALIDATION` | 载荷不符合 schema | UI 标红字段 |
| `NOT_FOUND` | 实体不存在 | 刷新树 |
| `NETWORK` | 连接失败/DNS/TLS | 响应面板展示错误态 |
| `TIMEOUT` | 请求超时 | 同上 |
| `SCRIPT_ERROR` | 用户脚本抛异常 | 脚本面板显示堆栈 |
| `SCRIPT_TIMEOUT` | 脚本熔断 | 同上 |
| `CANCELLED` | 用户取消 | 静默 |
| `DB` | SQLite 错误 | 弹错 + 引导备份 |

## 6. 规范细则

- **时间**：所有时间戳为 Unix 毫秒整数；耗时为毫秒浮点。
- **ID**：一律 ULID 字符串，由主进程生成。
- **分页**：只用游标（`cursor = 最后一条的 created_at:id`），`limit` 上限 200。
- **排序变更**：`tree:move` 由主进程计算新 `sort_order`（前后邻居中值，间隔过小时触发局部重排）。
- **版本协商**：preload 暴露 `app:version`，渲染进程启动时校验主进程版本一致，不一致提示重启。
- **大对象**：超过 1MB 的返回一律走文件路径，不走 IPC（IPC 有体积与序列化成本上限）。
