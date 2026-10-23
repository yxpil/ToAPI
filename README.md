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
| M1 骨架 | **已完成并验证** | Electron 45 + React 19 + Vite 8 + `node:sqlite`；项目/集合/接口三级树、请求编辑器、响应面板、环境与变量、UA 预设、CookieJar、大响应体落盘、游标分页历史 |
| M2 变量与环境 | **已完成并验证** | `{{var}}` 全链路插值、runtime/环境/全局三级优先、循环引用检测、环境切换与状态栏变量编辑 |
| M3 脚本引擎 | **已完成并验证** | worker + vm 双层隔离沙箱；`toapi.request`(含 setHeader/setBody/skip/send 子请求)、`vars/env/globals`、`fake.*`、`test/expect`、`log`、md5/sha256/hmac/base64/uuid/timestamp/sleep；5s 熔断（同步 vm timeout + 异步 terminate）、子请求深度 8 / 总数 50 |
| M4 联合请求 | **已完成并验证** | 声明式提取器 + 脚本式链式；集合 Runner（顺序执行、运行时变量跨接口传递、stopOnFail、逐项断言、进度事件、运行记录持久化）+ Runner 面板 |
| UI 规范适配 | **已完成并验证** | 三栏可拖宽（记忆栏宽/分屏方向）、上下分屏、底栏 DB 大小与版本、右键菜单 + 拖拽排序 + 删除确认、Ctrl+K 命令面板、响应状态行、历史虚拟滚动/分组/搜索/加载更多、检查/叉号 SVG 反馈、Toast 与空态 |
| M5 伪装与测试 | 部分 | UA 预设/伪装 Header/代理/超时/重定向已可用；批量报告导出待做 |
| M5.5–M8 | 未开始 | TAPI、MD 文档、开放调用/MCP、定时与压测、国际化与多平台 |

**已发布 v0.1.2**：`ToAPI-Setup-0.1.2-win-x64.exe`（NSIS 安装器）与 `ToAPI-0.1.2-win-x64.zip`（便携版），附 `sha256sums.txt`。v0.1.2 按 06/07/21 号文档把 UI 行为补齐：三栏拖拽与分屏偏好记忆、右键菜单/确认框/拖拽排序、命令面板、响应状态行、历史虚拟滚动与搜索、底栏 DB 大小，并把每条硬指标写成 CDP 断言；同时修掉草稿接口空 URL 无法保存的校验缺陷。1024×640 下 URL 输入实测 207px。未做代码签名（无证书），首次运行需通过 SmartScreen；产物冒烟由 `scripts/smoke-package.mjs` 验证。

### 已跑过的验证（不是声明，是实测）

```bash
npm run gate             # typecheck + lint + format:check + check:channels + 全部测试
node scripts/verify-flow.mjs             # CDP 驱动真机：建项目→建接口→发送→脚本断言→集合 Runner→重启验持久化
node scripts/smoke-package.mjs <exe 路径>  # 打包产物冷启动冒烟
```

真机验证要点（`scripts/verify-flow.mjs` 输出）：状态行 `200 OK · Nms · 112 B`、脚本两条断言通过、两个接口的集合 Runner 输出「默认集合 · 2/2 项 · 通过率 100%」、query 送达靶场；右键菜单 10px/无阴影、删除确认文案、拖拽排序、栏宽 300→240 与上下/左右分屏全部持久化；1024×640 三栏不重叠且 URL 207px；字体仅 12/13/14、按钮全部 999px 且带 title、渐变/投影计数 0、JSON 三色正确；DOM emoji 0、两轮 console 错误 0。

### 运行

```bash
npm install
npm run build && npm start     # 生产式启动
npm run dev                    # vite HMR + esbuild watch + Electron
```
