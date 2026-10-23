# ToAPI

一款简约、可脚本化的桌面 API 请求工具 —— Electron + SQLite，药丸式白底黑字设计。

核心能力：接口调试 / JS 脚本自动化（参数生成、伪装、断言）/ 链式联合请求 / 批量测试 Runner，全部数据本地 SQLite 存储，按项目与集合分类管理。

## 文档导航

| 文档 | 内容 |
|---|---|
| [01-产品规划](docs/01-产品规划.md) | 定位、功能清单 P0–P3、里程碑 M1–M8、非目标、候选功能清单 |
| [02-技术架构](docs/02-技术架构.md) | Electron 三进程架构、技术选型、数据流、性能预算、安全边界 |
| [03-数据库设计](docs/03-数据库设计.md) | SQLite 全表结构、伪装配置 Schema、迁移与备份机制 |
| [04-IPC接口设计规范](docs/04-IPC接口设计规范.md) | Channel 命名/载荷/错误码、完整 Channel 清单、核心类型 |
| [05-脚本与自动化规范](docs/05-脚本与自动化规范.md) | `toapi` 内置对象 API、UA 预设库、提取器、链式请求两种模式、沙箱熔断 |
| [06-UI设计规范](docs/06-UI设计规范.md) | 药丸白底黑字设计系统：tokens、组件、布局、反模式清单 |
| [07-测试与质量规范](docs/07-测试与质量规范.md) | 测试金字塔、关键用例清单、发布检查单 |
| [08-TAPI文件格式规范](docs/08-TAPI文件格式规范.md) | `.tapi` 单文件互传：结构、敏感数据处理、导入合并策略、checksum |
| [09-多语言案例与代码转换规范](docs/09-多语言案例与代码转换规范.md) | JS/Python 双语言案例、案例代码生成、响应/代码自动转测试 |
| [10-MD文档解读与文档内测试规范](docs/10-MD文档解读与文档内测试规范.md) | 任意 MD 接口文档解读、`.tapi.md` 可执行测试文档、文档 ↔ 集合双向同步 |
| [11-开放调用与AI协作规范](docs/11-开放调用与AI协作规范.md) | Local HTTP API、内嵌 MCP Server、MD Skill 包导出、授权闸门与审计 |
| [12-定时任务与动作自动化规范](docs/12-定时任务与动作自动化规范.md) | cron 定时测试、系统级唤醒、动作宏录制回放 |
| [13-压测与功能全景规范](docs/13-压测与功能全景规范.md) | 单机压测引擎、阈值判定、主流 API 工具能力对照表 |
| [14-国际化与多平台发行规范](docs/14-国际化与多平台发行规范.md) | 多语言自动识别、EULA、Windows/macOS/Linux/国产OS/国产芯片发行矩阵 |
| [15-消息通知与后台提醒规范](docs/15-消息通知与后台提醒规范.md) | 通知中心、Toast/托盘/OS 通知/Webhook 多通道、订阅规则与聚合防轰炸 |
| [16-AI能力集成规范](docs/16-AI能力集成规范.md) | OpenAI 兼容接入（含本地 Ollama）、NL 生成接口/脚本/断言、失败归因、脱敏与草稿采纳流 |
| [17-概要设计](docs/17-概要设计.md) | 分层依赖铁律、模块责任矩阵、关键时序、数据所有权、横切关注点 |
| [18-详细设计](docs/18-详细设计.md) | 逐模块文件/签名/内部结构/错误路径、shared 类型层、新单元连接检查清单 |
| [19-前后端通信实施规范](docs/19-前后端通信实施规范.md) | invoke/event/文件引用三通道、store 三态与错误分流、取消与节流、版本握手、CI 契约校验 |
| [20-代码编写规范](docs/20-代码编写规范.md) | TS 基线、命名、错误处理、日志脱敏、UI 规则、安全红线、Git/PR 门禁、文档同步义务 |
| [21-测试实施规范](docs/21-测试实施规范.md) | 单元/集成/沙箱/E2E 编写标准、靶场与夹具、确定性纪律、覆盖率与 CI 门禁 |
| [22-CI-CD与GitHub协作规范](docs/22-CI-CD与GitHub协作规范.md) | 分支模型、PR 门禁、pr/nightly/release 三条流水线、签名公证、版本节奏、Issue 体系、安全响应 |

## 速览

```
项目 → 集合（可嵌套） → 接口 / 案例（JS / Python）
环境变量 / 全局变量 / 运行时变量，{{var}} 全链路插值
Pre/Post 脚本（isolated-vm 沙箱）+ 声明式提取器 + 集合 Runner
伪装：UA 预设、Header 模板、代理、CookieJar，项目级默认 + 接口级覆盖
协作：.tapi 单文件互传（密钥可剔除/加密），接口 ↔ cURL/JS/Python 双向转换，响应一键转测试
文档：任意 MD 接口文档解读建项目，.tapi.md 文档内直接跑测试，与集合双向同步
开放：Local HTTP API（脚本/CI 驱动）+ 内嵌 MCP Server（AI 直接调用）+ MD Skill 包（无 MCP 的 AI 照说明书调用）
自动化：cron 定时测试 + 系统级唤醒 + 界面动作宏；单机压测（VU/RPS/分位数/阈值/HTML 报告）
发行：中/英/日/繁随系统识别，版本化 EULA；Windows/macOS/Linux 各发行版、国产 OS 与国产芯片
AI：OpenAI 兼容接口接入任意模型（含本地 Ollama），NL 生成/失败归因/报告解读，生成物草稿制 + 全程脱敏审计
图标：全部内联 SVG（1.5px 线性、currentColor），严禁 emoji 充当图标
```

## 实现状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 骨架 | **已完成并验证** | Electron 45 + React 19 + Vite 8 + `node:sqlite`；24 个 IPC 通道；项目/集合/接口三级树、请求编辑器（Params/Headers/Auth/伪装/Body/提取器）、响应面板（Pretty 高亮/Raw/Headers/历史）、环境与变量、UA 预设、CookieJar、大响应体落盘、游标分页历史 |
| M2 变量与环境 | 大部分随 M1 完成 | `{{var}}` 全链路插值、runtime/环境/全局三级优先、循环引用检测、链式提取器传递已实现并通过集成测试 |
| M3 脚本引擎 | 未开始 | 需 `isolated-vm`（原生模块，按 14 号文档准备 prebuild 矩阵） |
| M4–M8 | 未开始 | Runner、TAPI、MD、开放调用、定时/压测、国际化与多平台 |

### 已跑过的验证（不是声明，是实测）

```bash
npm run typecheck   # tsconfig.json + tsconfig.electron.json 双侧零错误
npm run lint        # ESLint 零错误
npm run format:check
npm run check:channels   # 24 invoke + 1 event 通道：schema/handler/文档四方一致
npm test            # 56 个用例全通过（单元 + 集成，含真实 HTTP 靶场）
node scripts/verify-flow.mjs   # CDP 驱动真机：建项目→建接口→保存→发送 200→重启后数据与历史仍在
```

真机验证要点（`scripts/verify-flow.mjs` 输出）：状态徽章 `200`、`200 OK · 15ms · 111 B`、query 参数送达靶场、重启后接口与 URL 持久化、历史 2 条、DOM 内 emoji 数 0、渲染无 console 错误。

### 运行

```bash
npm install
npm run build && npm start     # 生产式启动
npm run dev                    # vite HMR + esbuild watch + Electron
```
