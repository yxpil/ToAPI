# ToAPI — Postman 兼容规范

> 目标：**本地全量兼容**。凡 Postman 能在单机完成的能力，ToAPI 都要有等价物；
> 云端账号、团队工作区、Postman 云服务不在范围内（见 §9）。
> 兼容分四批交付，每批都是可独立发版、可回归验证的闭环。

## 1. 兼容原则

| 原则 | 落地 |
|---|---|
| 资产双向 | Postman Collection v2.1 与 Environment 可导入、可导出；导入后再导出语义等价 |
| 脚本源码级 | Postman 的 Pre-request / Tests 脚本不改一行即可运行；`pm.*` 与常用沙箱库齐备 |
| 不静默丢数据 | 不支持的字段/构造进入导入报告的 `warnings`，原文留存于 `source_json`，导出时原样带回 |
| 本地优先 | 变量、Mock、监控、Runner 全部落 SQLite，不依赖网络账号 |
| 原生仍为 `.tapi` | `.tapi` 是 ToAPI 的项目交换格式（08 号文档）；Postman 格式是互操作层，不替代 `.tapi` |
| 可度量 | 每批给出兼容矩阵、验收用例与已知差异，发布说明照此声明（13 号文档 §2） |

## 2. 批次总览

| 批次 | 版本 | 内容 | 验收关键词 |
|---|---|---|---|
| B1 资产与脚本 | **v0.2.0** | Collection v2.1 / Environment 导入导出、集合级 auth/variables/scripts 继承、`pm.*` 沙箱、动态变量、常用沙箱库 | 真实 Collection 往返无损；Postman 官方脚本示例全绿 |
| B2 数据驱动与 CLI | v0.3.0 | CSV/JSON 数据文件、多迭代、`pm.iterationData`、`pm.execution.setNextRequest`、`toapi run` 无头 CLI、JUnit/JSON/HTML 报告 | CLI 退出码可被 CI 判定；数据行注入与迭代数正确 |
| B3 协议扩展 | v0.4.0 | GraphQL、WebSocket、SSE、gRPC、MQTT | 每种协议有真实往返用例与历史记录 |
| B4 自动化与长尾 | v0.5.0 | OpenAPI 2.0/3.0/3.1 导入导出、本地 Mock、保存示例、代码生成扩展、`pm.visualizer`、认证长尾与传输能力 | 认证矩阵全绿；OpenAPI 导入可跑 |

> 批次之间不破坏数据：B1 的 `source_json` 字段为后续批次保留原文，后续解析器可逐步消化，无需重新导入。

## 3. B1：Collection v2.1 资产映射

### 3.1 数据模型增补（迁移 003）

| 实体 | 新增列 | 说明 |
|---|---|---|
| `project` | `auth TEXT`、`variables TEXT`、`pre_script TEXT`、`post_script TEXT`、`source_json TEXT` | 承接 Postman 根集合（root collection）的 auth / variable / event |
| `collection` | `description TEXT`、`auth TEXT`、`variables TEXT`、`source_json TEXT` | 文件夹即集合（`parent_id` 表达嵌套） |
| `api` | `description TEXT`、`source_json TEXT` | 请求描述与未识别字段原文 |
| `environment` | `source_json TEXT` | 保留 `_postman_exported_at` 等元数据 |
| `variable` | `enabled INTEGER NOT NULL DEFAULT 1` | Postman 变量可禁用；禁用变量不参与插值 |

- `auth.type` 增加 `inherit`：接口未单独配置认证时沿 `api → collection 链 → project` 向上取第一个非 `inherit`/`none` 的配置。
- 变量优先级（低 → 高）：`global < collection（由外到内）< environment < runtime（含 local / iterationData）`；同层同名后者覆盖前者。
- 所有新增列均为可选，旧库迁移后保持原行为。

### 3.2 结构映射

| Postman v2.1 | ToAPI | 规则 |
|---|---|---|
| `info.name` / `info.description` | `project.name` / `description` | `description` 允许字符串或 `{content,type}`，取 `content` |
| `info._postman_id`、`info.schema` | `project.source_json` | 导出时生成新 ID，除非用户勾选「保留来源 ID」 |
| 顶层 `item[]`（folder） | `collection`（`parent_id=null`） | 名称与顺序保留 |
| 嵌套 `item[]`（folder） | 子 `collection` | 任意深度；空文件夹保留 |
| `item`（request） | `api` | 顶层请求挂到导入时自动创建的「根集合」占位集合下（见 §3.4） |
| `item.response[]` | `api.source_json`（B1）/ 保存示例（B4） | B1 原文保留，B4 起映射为可运行示例 |
| `event[listen=prerequest]` | `pre_script` | 多个 event 按数组顺序以 `\n` 拼接 |
| `event[listen=test]` | `post_script` | 同上 |
| `variable[]` | `variables` JSON | 保留 key/value/disabled/description；导出时写回 |
| `auth` | `auth` JSON | §3.3 映射 |
| `description`（item/folder） | `description` | 支持 Markdown 对象 |
| `protocolProfileBehavior` | `source_json` + 已识别行为 | `followRedirects` / `strictSSL` / `disableBodyPruning` 等映射到请求选项；其余原文留存 |

### 3.3 请求字段映射

| Postman | ToAPI | 备注 |
|---|---|---|
| `request.method` | `api.method` | 非标准动词按字符串保留 |
| `request.url`（string 或对象） | `api.url` | 优先 `url.raw`；否则由 `protocol/host/path/port/query` 重建 |
| `url.query[].disabled` | `params.enabled=false` | key/value 原样保留 |
| `url.variable[]` + `path` 中的 `:name` | 集合变量 + `{{name}}` | 路径变量提升为集合变量（同名已存在则复用），`/users/:id` → `/users/{{id}}` |
| `request.header[]`（含 `disabled`） | `headers` | 同名多值保留顺序；重复键按 Postman 语义发送 |
| `header` 为字符串 | `headers` | 按行解析 `Key: Value` |
| `body.mode=raw` + `options.raw.language=json` | `bodyType=json` + `body` | 非 JSON 语言 → `bodyType=raw`，语言写入 `source_json` |
| `body.mode=urlencoded` | `bodyType=urlencoded` | `disabled` → `enabled=false` |
| `body.mode=formdata`（text） | `bodyType=form` | 文件字段 B1 记录 warning，B3 起支持 |
| `body.mode=graphql` | B3：`bodyType=graphql` | B1 导入为 `raw` 并保留原文，警告「GraphQL 将在 B3 启用」 |
| `body.mode=file` / `formdata.type=file` | `bodyType=binary`（仅路径） | 文件不随 Collection 传输；导入时警告并保留 `src` |
| `request.auth` | `api.auth` | `noauth` → `none`；`inherit` → `inherit` |
| `request.proxy` / `request.certificate` | `source_json` | B4 映射到传输设置 |

### 3.4 根集合占位

Postman 的根 `item[]` 直接挂在集合下，而 ToAPI 是「项目 → 集合 → 接口」三级。导入时：

- 用 `info.name` 建项目；
- 若根下直接出现 request item，创建名为 `根集合` 的集合承接，保证层级与顺序不丢；
- 根级 auth / variable / event 存入 `project` 对应列，不复制到占位集合，避免双重继承；
- 导出时把项目根级配置写回顶层 `auth`/`variable`/`event`，占位集合还原为顶层请求。

### 3.5 环境文件

Postman Environment 导出格式：

```jsonc
{
  "id": "...",
  "name": "staging",
  "values": [{"key": "baseUrl", "value": "https://...", "type": "default", "enabled": true}],
  "_postman_variable_scope": "environment",
  "_postman_exported_at": "...",
  "_postman_exported_using": "Postman/..."
}
```

- `type=secret` → `variable.secret=1`，导出时保持 `type=secret`；
- `enabled=false` → `variable.enabled=0`；
- 同名环境已存在：默认新建「staging (2)」，可选覆盖（覆盖为事务操作）；
- 活动环境状态不写入导出文件。

### 3.6 导入报告与冲突策略

```ts
interface PostmanImportReport {
  projectId: string
  counts: { collections: number; apis: number; variables: number; scripts: number }
  warnings: { path: string; code: string; message: string }[] // path 用 JSON Pointer，如 /item/0/request/body
  preserved: number // 进入 source_json 的未知字段数
}
```

| 情况 | 默认行为 |
|---|---|
| schema 不是 v2.1 | v2.0 走兼容读取；v1 / 未知 schema 拒绝并提示 |
| 同名项目已存在 | 新建「名称 (2)」，不自动合并 |
| 同名集合/接口 | 各自独立创建（Postman 允许重名，ToAPI 不擅自合并） |
| 未知 auth 类型 / body 模式 | 保留原文 + warning，接口仍可打开（auth 显示「未支持，仅保留原文」） |
| 文件字段 / 二进制 body | warning + 保留 `src`，不阻断其余导入 |
| 超大文件（>50MB） | 拒绝并提示拆分 |

## 4. B1：脚本兼容 `pm.*`

### 4.1 执行顺序（与 05 号文档 §1 对齐）

```
project.pre_script → collection 链由外到内 pre_script → api.pre_script
  → 发送请求
→ api.post_script → collection 链由内到外 post_script → project.post_script
```

- 前置脚本任一 `pm.request.skipRequest()` / `toapi.request.skip()` 中止发送；
- 后置脚本里的断言按「请求 → 内层集合 → 外层集合 → 项目」聚合，任一失败本轮失败；
- 集合级脚本可访问当前请求上下文（`pm.request` / `pm.response`），与 Postman 一致；
- 脚本异常不推翻已收到的响应，以失败断言呈现（05 号文档 §6）。

### 4.2 `pm` 对象覆盖表

| 分组 | 成员 | 状态 | 说明 |
|---|---|---|---|
| 断言 | `pm.test(name, fn)` | ✅ B1 | 同步 / 返回 Promise / `done` 回调三种写法；异步用例收尾前统一收敛再汇总 |
| 断言 | `pm.test.skip(name)`、`pm.test.index` | ✅ B1 | 跳过用例计入 `skipped`，不判失败 |
| 断言 | `pm.expect(value)` | ✅ B1 | 链式 chai 子集，见 §4.3 |
| 响应 | `pm.response.code / status / responseTime / headers` | ✅ B1 | `headers.get/has/toObject` |
| 响应 | `pm.response.json() / text() / size()` | ✅ B1 | `json()` 解析失败抛错并计为脚本错误 |
| 响应断言 | `pm.response.to.have.status(...) / header(...) / body(...) / jsonBody(...)` | ✅ B1 | `jsonBody` 支持深比较与 JSON Schema 子集（B1 仅深比较） |
| 响应 | `pm.response.cookies` | ✅ B1 | 读当前响应 Set-Cookie 解析结果 |
| 请求 | `pm.request.method / url / headers / body` | ✅ B1 | `url` 为 Url 对象：`toString()`、`query`、`addQueryParams()` |
| 请求 | `pm.request.headers.add/upsert/remove/get/has` | ✅ B1 | 前置脚本可改请求；后置脚本只读（写入抛 warning） |
| 请求 | `pm.request.auth` | ✅ B1 | 只读视图 |
| 变量 | `pm.variables.get/set/has/unset/replaceIn/toObject` | ✅ B1 | 映射**请求级 local** 变量，优先级最高 |
| 变量 | `pm.collectionVariables.*` | ✅ B1 | 读写当前集合；Runner 中写回集合定义 |
| 变量 | `pm.environment.*` | ✅ B1 | 写当前激活环境，持久化 |
| 变量 | `pm.globals.*` | ✅ B1 | 写全局变量，持久化 |
| 变量 | `pm.iterationData.*` | ✅ B2 | 数据行只读视图 |
| 信息 | `pm.info.requestName / requestId / eventName / iteration / iterationCount` | ✅ B1（iteration 在 B2 生效） | Runner 外 `iteration=1/1` |
| 子请求 | `pm.sendRequest(urlOrOptions, callback?)` | ✅ B1 | 返回 thenable；选项支持 method/url/header/body/auth(basic,bearer,apikey)；复用代理、CookieJar、历史 |
| Cookie | `pm.cookies.get/set/has/unset/toObject` | ✅ B1 | 项目级 CookieJar；`pm.cookies.jar()` 的异步域接口 B2 |
| 流程 | `pm.execution.setNextRequest(name \| null)`、`skipRequest()` | ✅ B2 | Runner 内生效；集合外调用抛错 |
| 可视化 | `pm.visualizer.set(template, data)` | ✅ B4 | 响应页 iframe 沙箱渲染（`sandbox` 无脚本外联） |
| 库 | `pm.require(...)` | ❌ 不支持 | 沙箱不允许任意模块加载；改用内置库（§4.4） |
| 云 | `pm.workspace / pm.vault / pm.api` | ❌ 不支持 | 无账号体系，见 §9 |

### 4.3 `pm.expect` 链式子集

B1 必须通过：`to.equal / eql / deep.equal`、`to.be.true / false / null / undefined / ok`、`to.be.a(type)`、`to.include / contain`、`to.have.property(name[, value])`、`to.have.lengthOf`、`to.match(regex)`、`to.be.above / below / least / most`、`to.be.oneOf`、`to.be.empty`、`to.be.instanceOf`、`.not`、`.deep`、`.have`、`.that`。`to.have.jsonSchema` 在 B4 随 OpenAPI 一并联调。

### 4.4 沙箱库

| 库 | 版本策略 | 批次 |
|---|---|---|
| `_`（lodash） | 与 Postman 同源的 4.x 子集，覆盖 collection/object/string 常用方法 | B1 |
| `CryptoJS` | 4.x，AES/HMAC/MD5/SHA/Base64/PBKDF2 | B1 |
| `uuid` | v4 / v7 | B1 |
| `moment` | 2.x 只读时间格式化 | B1 |
| `atob` / `btoa` | 全局函数 | B1 |
| `URL` / `URLSearchParams` / `TextEncoder` / `TextDecoder` | 宿主 Web 标准对象 | B1 |
| `setTimeout` / `setInterval`（含 clear） | 宿主定时器，受脚本 5s 总时限约束 | B1 |
| `console.log/info/debug/warn/error` | 转发到脚本日志面板 | B1 |
| `xml2js`、`cheerio`、`tv4`（JSON Schema） | 按需体积评估后内置 | B4 |

> 所有库在 worker 启动时注入 vm 上下文，不暴露 `require`；脚本无法触达文件系统与进程。`fetch` / `XMLHttpRequest` 不存在，网络只能走 `pm.sendRequest`。

### 4.5 动态变量

发送前对 URL / Header / Body / auth 字段统一求值，语法 `{{$name}}`。

| 类别 | 变量（官方同名同义） |
|---|---|
| 标识与时间 | `$guid`、`$timestamp`、`$isoTimestamp`、`$randomUUID`、`$randomAlphaNumeric`、`$randomBoolean`、`$randomInt`、`$randomSemver` |
| 网络 | `$randomIP`、`$randomIPV6`、`$randomMACAddress`、`$randomProtocol`、`$randomUserAgent`、`$randomLocale` |
| 人物 | `$randomFirstName`、`$randomLastName`、`$randomFullName`、`$randomNamePrefix`、`$randomNameSuffix`、`$randomJobArea`、`$randomJobDescriptor`、`$randomJobTitle`、`$randomJobType` |
| 联系方式/地址 | `$randomPhoneNumber`、`$randomPhoneNumberExt`、`$randomCity`、`$randomStreetName`、`$randomStreetAddress`、`$randomCountry`、`$randomCountryCode`、`$randomLatitude`、`$randomLongitude` |
| 文本与颜色 | `$randomColor`、`$randomHexColor`、`$randomAbbreviation`、`$randomPassword`、`$randomMimeType` |
| 图片 | `$randomAvatarImage`、`$randomImageUrl`、`$randomAbstractImage`、`$randomAnimalsImage`、`$randomBusinessImage`、`$randomCatsImage`、`$randomCityImage`、`$randomFoodImage`、`$randomNightlifeImage`、`$randomFashionImage`、`$randomPeopleImage`、`$randomNatureImage`、`$randomSportsImage`、`$randomTransportImage`、`$randomImageSourceUrl` |
| 金融 | `$randomBankAccount`、`$randomBankAccountName`、`$randomCreditCardMask`、`$randomBankAccountBic`、`$randomBankAccountIban`、`$randomTransactionType`、`$randomCurrencyCode`、`$randomCurrencyName`、`$randomCurrencySymbol`、`$randomBitcoin` |
| 商业 | `$randomCompanyName`、`$randomCompanySuffix`、`$randomBs`、`$randomBsAdjective`、`$randomBsBuzz`、`$randomBsNoun`、`$randomCatchPhrase`、`$randomCatchPhraseAdjective`、`$randomCatchPhraseDescriptor`、`$randomCatchPhraseNoun`、`$randomDepartment` |
| 产品 | `$randomProduct`、`$randomProductAdjective`、`$randomProductMaterial`、`$randomProductName`、`$randomPrice` |
| 互联网 | `$randomEmail`、`$randomExampleEmail`、`$randomUserName`、`$randomUrl`、`$randomDomainName`、`$randomDomainSuffix`、`$randomDomainWord`、`$randomFileExt`、`$randomFileName`、`$randomFileType`、`$randomFilePath`、`$randomCommonFileName`、`$randomCommonFileExt`、`$randomCommonFileType`、`$randomDirectoryPath` |

- 完整键名清单由 `electron/postman/dynamic-vars.ts` 维护，并以单测锁定；新增键必须同时补文档表格与测试。
- 同一次发送内每个 `{{$...}}` 占位符**独立求值**；需要同值复用请先写入变量（`pm.variables.set`）。
- 未知 `{{$name}}` 保持原样并进入未解析变量清单，不静默替换为空。

## 5. B2：数据驱动 Runner 与 CLI

### 5.1 数据文件

| 格式 | 规则 |
|---|---|
| CSV | UTF-8（可带 BOM）；首行表头；RFC 4180 引号/换行；空单元格为空串 |
| JSON | 对象数组，每个对象一行；非对象行报错并中止 |
| 行注入 | 每行作为 `iterationData`，在变量优先级中高于 environment、低于 local |
| 列名 | 原样作为变量名，支持 `{{column}}` 与 `pm.iterationData.get('column')` |

### 5.2 迭代与流程

- 迭代次数默认 = 数据行数；无数据文件时默认 1 次；`--iteration-count N` 显式指定，数据行不足时循环取行。
- `pm.info.iteration` 从 1 开始，`iterationCount` 为本轮总次数。
- `pm.execution.setNextRequest(name)` 跳转到指定请求（按名称匹配当前集合内请求）；`null` 结束本轮；`skipRequest()` 跳过当前请求但仍继续。
- 失败语义：请求错误、断言失败、提取器未命中均计失败；`--bail` 首次失败即停；其余按 `stopOnFail`（05 号文档 §5）。

### 5.3 CLI `toapi run`

```
toapi run <collection.tapi | postman_collection.json> \
  --env <environment.json|name> --globals <globals.json> \
  --data <data.csv|data.json> --iteration-count <n> \
  --folder <name> --delay <ms> --timeout <ms> --bail \
  --reporters cli,json,junit,html --reporter-json-export <path> \
  --reporter-junit-export <path> --reporter-html-export <path>
```

| 退出码 | 含义 |
|---|---|
| 0 | 全部通过（允许 skipped） |
| 1 | 存在失败项 / 断言失败 / 脚本错误 |
| 2 | 用法错误、文件不可读、导入失败、数据库不可写 |

- CLI 与 GUI 共用 `kernel`（无窗口模式），Runner、变量、脚本、CookieJar 行为完全一致（17 号文档）；
- 输出至少包含：每请求状态/耗时/断言数、汇总通过率、失败明细、报告路径；
- 报告格式：CLI 文本、JSON（机器可读）、JUnit XML（CI）、HTML（人读，复用压测报告样式）。

## 6. B3：协议扩展

| 协议 | 能力 | 存储 |
|---|---|---|
| GraphQL | Query / Variables / Operation Name；Schema introspect；响应同 HTTP | `api.bodyType='graphql'`，body 存 `{query,variables,operationName}` |
| WebSocket | 连接（URL/Header/子协议）、文本/二进制帧、消息时间线、ping/pong、关闭码；历史逐帧留存 | 新表 `ws_session` / `ws_message`（或历史扩展 `kind`） |
| SSE | 流式事件表、`Last-Event-ID` 重连、事件过滤、停止 | 复用 HTTP 历史，标记 `stream` |
| gRPC | Unary + Server Streaming；`.proto` 文件或服务反射；metadata；TLS/mTLS | proto 存项目资产目录；历史存消息 JSON |
| MQTT | 3.1.1 / 5.0；TCP/TLS/WebSocket；pub/sub、QoS、保留消息 | 新表 `mqtt_session` |

- 脚本钩子在 HTTP 之外的协议上按「请求前 / 响应后」语义对齐；WS 为「连接前 / 每条消息」；
- 所有协议请求进入统一历史与 Runner 结果模型，Runner 可按顺序混跑 HTTP 与 WS/SSE（B3 验收）。

## 7. B4：自动化与资产

| 能力 | 落地 |
|---|---|
| OpenAPI 导入 | Swagger 2.0 / OpenAPI 3.0 / 3.1 → 项目 + 集合 + 接口；`servers[0]` → 环境变量 `baseUrl`；operationId → 接口名 |
| OpenAPI 导出 | 由项目生成 3.1 文档；示例取保存示例，schema 取最近成功响应推断（可选） |
| 本地 Mock | 以接口定义生成路由；按示例/状态码/延迟/Header 规则响应；仅监听 `127.0.0.1`；不做集群 |
| 保存示例 | 每个接口可存多份响应示例；可命名、可运行、可导出为 Postman `item.response[]` |
| 代码生成 | cURL、JS fetch/axios、Python requests、Go、Java OkHttp、C# HttpClient、PHP cURL；反向解析 cURL/JS/Python（09 号文档） |
| 报告 | Runner / CLI 的 JSON、JUnit、HTML；与压测报告共用视觉规范 |
| 本地监控 | 定时任务驱动 Runner（12 号文档），失败按通知规则告警（15 号文档）；不依赖云 Monitor |
| `pm.visualizer` | 响应页沙箱 iframe 渲染模板；禁止网络与父页面访问 |
| 认证长尾 | OAuth2（授权码 + PKCE / 客户端凭证 / 密码 / 设备码，令牌缓存与刷新）、OAuth1、Digest、NTLM、AWS SigV4、Hawk、ASAP、EdgeGrid、JWT 生成、客户端证书（PEM/PFX）、代理认证、自定义 CA、关闭 TLS 校验 |
| 沙箱扩展库 | `xml2js`、`cheerio`、`tv4` |

## 8. IPC 与入口

新增通道（并入 04 号文档 §3.5）：

| Channel | 入参 | 返回 |
|---|---|---|
| `postman:inspect` | `{content?: string, filePath?: string}` | `{kind:'collection'\|'environment', name, counts, warnings}`（不写库） |
| `postman:import` | `{content?: string, filePath?: string, targetProjectId?, mode:'new'\|'into'}` | `PostmanImportReport` |
| `postman:export-collection` | `{projectId, collectionIds?, filePath?}` | `{filePath, counts}` |
| `postman:import-environment` | `{content?: string, filePath?: string, projectId, mode:'new'\|'overwrite'}` | `{environmentId, counts, warnings}` |
| `postman:export-environment` | `{environmentId, filePath?}` | `{filePath}` |

- `content` 与 `filePath` 二选一；`content` 供粘贴导入与 E2E 使用，`filePath` 供文件选择器；
- 导出默认弹保存对话框；指定 `filePath` 时直接写入（CLI / 测试）；
- 所有导入在一个事务内完成，失败整体回滚（08 号文档 §5 同款约束）。

UI 入口（06 号文档）：

- 项目树工具栏「导入」按钮（`upload`）：文件选择 / 粘贴 JSON 二选一，自动识别 Collection 或 Environment；
- 项目右键菜单：`导入 Postman…`、`导出为 Postman Collection…`；
- 集合右键菜单：`导出为 Postman Collection…`（只导出该子树）；
- 环境下拉两侧图标按钮（`upload` / `download`）：`导入 Postman Environment…`、`导出当前环境…`；
- 导入完成 Toast 汇总；warning 数 >0 时对话框保持打开并切换为可滚动的导入报告，确认后关闭。

## 9. 明确不兼容（本地边界）

| Postman 能力 | 原因 | ToAPI 替代 |
|---|---|---|
| 账号、云同步、团队工作区、公开 API 网络 | 纯本地工具，无账号体系（01 号文档 §5） | `.tapi` 文件 + Git |
| Postman API / Postman CLI 云集成 | 依赖云账号 | 本地 `toapi run` + Local HTTP API（11 号文档） |
| Postman Flows | 可视化云编排 | 集合 Runner + 链式提取器 + 定时任务 |
| Postman AI Agent | 云侧 Agent | 内置 AI 助手（16 号文档，OpenAI 兼容、本地 Ollama） |
| Postman Vault（云密钥库） | 云端密钥托管 | 本地 secret 变量 + 可选 OS 钥匙串（Backlog） |
| Postman 包库 `pm.require` | 沙箱安全边界 | 内置库白名单（§4.4） |
| 浏览器抓包 / Interceptor | 非目标（01 号文档 §5） | cURL / OpenAPI / MD 导入 |
| 云 Mock / 云 Monitor | 依赖云 | 本地 Mock（B4）+ 本地定时任务（12 号文档） |
| 分布式压测 | 非目标（13 号文档） | 单机压测 |

> 线协议兼容 ≠ 云服务兼容。上表是「本地全量兼容」的范围定义，发布说明不得宣称支持云协作。

## 10. 验收标准

### 10.1 B1

1. 取一份包含嵌套文件夹、四种 body、三种 auth、集合变量、路径变量、集合级脚本、保存示例的真实 Postman Collection，导入 → 导出 → 再导入，**规范化后语义 diff 为空**（允许 ID 与时间字段差异）。
2. 未识别字段 100% 出现在导出结果中（`source_json` 回填），警告清单可导出。
3. Postman 官方文档中的脚本示例（环境变量、集合变量、`pm.test`、`pm.response.to.have`、`pm.sendRequest`、动态变量）不改一行全绿。
4. 集合级 auth 继承链正确：接口无 auth → 取最近集合 auth；`noauth` 可显式覆盖。
5. 变量优先级：`local > environment > 内层集合 > 外层集合 > global`，单测覆盖同名冲突。
6. Environment 导入后 secret 标记、禁用变量、同名覆盖策略正确。
7. 导入失败回滚：故意在文件中段制造非法 URL，库中不留半个项目。

### 10.2 B2–B4

- B2：CSV/JSON 数据行、迭代数、`setNextRequest`、`--bail`、四种报告、退出码 0/1/2 全部有集成用例。
- B3：五种协议各有本地靶场用例，请求进入历史与 Runner 报告。
- B4：认证矩阵（每类认证一个靶场端点）、OpenAPI 往返、Mock 路由、示例导出、`pm.visualizer` 隔离测试。
- 所有批次的用例并入 07 号文档 §2.14 与 21 号文档执行清单。

## 11. 已知差异与迁移说明

| 差异 | 说明 |
|---|---|
| 目录层级命名 | Postman「Collection → Folder → Request」在 ToAPI 显示为「项目 → 集合 → 接口」，文件夹即集合；文档与 UI 文案统一用 ToAPI 术语 |
| 根集合 | 项目承载根级 auth/variables/scripts；有顶层请求时出现「根集合」占位（§3.4） |
| 脚本 API 双轨 | 新代码建议 `pm.*`（与 Postman 互通）；`toapi.*` 保留为 ToAPI 增强（伪装、提取器、Python 桥接） |
| 变量作用域 | Postman 的 `local` 映射为请求级 local；`toapi.vars.set` 仍写 runtime（跨请求），两者不要混用同一键 |
| 保存示例 | B1 仅保留原文，B4 才可在 UI 中运行与编辑 |
| 历史与报告 | 永不写入 Collection 导出（与 08 号文档一致） |

## 12. 测试与质量

- 转换器为纯函数：`parsePostmanCollection(json) → ImportModel`、`buildPostmanCollection(project) → json`，单测覆盖每种 body/auth/event 组合与未知字段回填；
- 夹具存放 `tests/fixtures/postman/`，包含官方示例集合与手工构造的边界集合（空文件夹、禁用字段、文件上传、GraphQL、OAuth2）；
- E2E：粘贴导入 → 树中出现集合 → 打开接口字段正确 → 导出文件 → 重新导入语义一致；
- 门禁纳入 `npm run check`（lint + typecheck + 单测 + `check:channels`），发布前跑 `verify-flow` 与 `smoke-package`。
