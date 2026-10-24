# ToAPI

一款简约、可脚本化的桌面 API 请求工具 —— Electron + SQLite，浅灰画布上漂浮白色面板，药丸控件与下划线 Tab 的极简设计。

核心能力：接口调试 / JS 脚本自动化（参数生成、伪装、断言）/ 链式联合请求 / 批量测试 Runner，全部数据本地 SQLite 存储，按项目与集合分类管理。

## 文档导航

| 文档 | 内容 |
|---|---|
| [01-产品规划](docs/01-产品规划.md) | 定位、功能清单 P0–P3、里程碑 M1–M8、非目标、候选功能清单 |
| [02-技术架构](docs/02-技术架构.md) | Electron 三进程架构、技术选型、数据流、性能预算、安全边界 |
| [03-数据库设计](docs/03-数据库设计.md) | SQLite 全表结构、伪装配置 Schema、迁移与备份机制 |
| [04-IPC接口设计规范](docs/04-IPC接口设计规范.md) | Channel 命名/载荷/错误码、完整 Channel 清单、核心类型 |
| [05-脚本与自动化规范](docs/05-脚本与自动化规范.md) | `toapi` 内置对象 API、UA 预设库、提取器、链式请求两种模式、沙箱熔断 |
| [06-UI设计规范](docs/06-UI设计规范.md) | 画布浮层 + 药丸设计系统：tokens、组件、布局、反模式清单 |
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
| [23-Postman兼容规范](docs/23-Postman兼容规范.md) | 本地全量兼容范围、Collection v2.1/Environment 映射、`pm.*` 覆盖、动态变量、四批交付与验收 |
| [24-局域网协作与多机联合测试规范](docs/24-局域网协作与多机联合测试规范.md) | 节点配对（IP+口令、加密信道、TOFU 指纹）、项目互传、代为测试、多机联合测试与联合压测口径 |

## 速览

```
项目 → 集合（可嵌套） → 接口 / 案例（JS / Python）
环境变量 / 全局变量 / 运行时变量，{{var}} 全链路插值
Pre/Post 脚本（worker + vm 沙箱，`toapi.*` 与 `pm.*` 双轨）+ 声明式提取器 + 集合 Runner
Postman 本地全量兼容：Collection v2.1 / Environment 双向、动态变量、数据驱动 CLI、五种协议（23 号文档）
伪装：UA 预设、Header 模板、代理、CookieJar，项目级默认 + 接口级覆盖
协作：.tapi 单文件互传（密钥可剔除/加密），接口 ↔ cURL/JS/Python 双向转换，响应一键转测试
文档：任意 MD 接口文档解读建项目，.tapi.md 文档内直接跑测试，与集合双向同步
开放：Local HTTP API（脚本/CI 驱动）+ 内嵌 MCP Server（AI 直接调用）+ MD Skill 包（无 MCP 的 AI 照说明书调用）
自动化：cron 定时测试 + 系统级唤醒 + 界面动作宏；单机压测（VU/RPS/分位数/阈值/HTML 报告）
发行：Windows x64 / Linux x64（AppImage·deb·rpm·tar.gz）/ macOS arm64 由 CI 原生 runner 出包并本平台冒烟；中/英/日/繁与版本化 EULA 尚未实现（14 号文档）
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
| UI 规范适配 | **已完成并验证** | Windows 无边框窗口 + 一体化自绘标题栏（拖拽区、最小化/最大化/还原/关闭药丸）、三栏可拖宽（记忆栏宽/分屏方向）、上下分屏、底栏 DB 大小与版本、右键菜单 + 拖拽排序 + 删除确认、Ctrl+K 命令面板、响应状态行、历史虚拟滚动/分组/搜索/加载更多、检查/叉号 SVG 反馈、Toast 与空态；v0.1.5 现代化重构：浅灰画布 + 14px 浮层白卡、10px 间距、下划线文字 Tab、底色方法/状态徽章、填充式输入框、底部居中 Toast、窄容器图标发送钮；v0.1.6 标题栏与窗口/安装包换用自有 `TA.` LOGO |
| M5 伪装与测试 | 部分 | UA 预设/伪装 Header/代理/超时/重定向已可用；Runner 报告导出（`runner:report`，json/junit/html）已可用；响应/历史导出待做 |
| M5.5 TAPI 互传 | **已完成并验证** | `.tapi` 导出/预览/导入（密钥默认剔除、checksum 与版本闸门、同名合并与判重、事务回滚）+ `toapi run project.tapi`；加密携带与 `payload.cases` 未做（08 号文档 §9） |
| M6 开放调用 | **已完成并验证** | Local HTTP API + 内嵌 MCP（stdio / Streamable HTTP，15 工具）+ 调用密码闸门 + 客户端授权条 + host 白名单 + 全链路脱敏 + `external_call_log` 审计 + SKILL.md 生成 |
| M7 定时与通知 | **已完成并验证** | cron/间隔/单次定时回归（锁环境、overlap、misfire、单调时钟）+ 通知中心/Toast/OS 通知/声音/Webhook + 60s 合并与状态变化抑制 + 系统托盘驻留；动作宏与系统级唤醒未做（12 号文档 §6） |
| M8 国际化与发行 | **发行矩阵已落地三平台，i18n/EULA 未做** | Windows x64、Linux x64（AppImage/deb/rpm/tar.gz）、macOS arm64 由 CI 原生 runner 构建并本平台冒烟（14 号文档 §3.4）；四语言与版本化 EULA 尚未实现 |
| M10 局域网协作 | **进行中（第一段已完成并验证）** | 填 IP + 口令配对另一台 ToAPI，`toapi-node/1` 强制应用层加密（口令 scrypt 派生 + AES-256-GCM + 序号防重放 + TOFU 指纹核对）；项目互传（密钥不跨机）、指定机器代为测试并落地本机运行记录 + 通知汇报、入站/出站审计；**多机联合测试与联合压测未开工**（24 号文档 §5/§6） |
| M9 Postman 兼容 | **进行中** | B1 资产与脚本、B2 数据驱动与 CLI 已发布；B3 协议（v0.6.0）与 B4 自动化长尾（v0.7.0，含 Apifox）待做；范围与验收见 23 号文档 |

### 下载

最新发布 **v0.4.1**（三平台产物 + `sha256sums.txt`）：https://github.com/yxpil/ToAPI/releases/latest

| 平台 | 文件 | 安装 |
|---|---|---|
| Windows x64 | `ToAPI-Setup-<ver>-win-x64.exe` / `ToAPI-<ver>-win-x64.zip` | NSIS 安装器或便携版 |
| Linux x64 | `ToAPI-<ver>-linux-x86_64.AppImage` | `chmod +x` 直接运行；无 FUSE 的容器加 `APPIMAGE_EXTRACT_AND_RUN=1` |
| Debian/Ubuntu/UOS | `ToAPI-<ver>-linux-amd64.deb` | `sudo apt install ./ToAPI-<ver>-linux-amd64.deb` |
| Fedora/RHEL/麒麟 | `ToAPI-<ver>-linux-x86_64.rpm` | `sudo rpm -i ToAPI-<ver>-linux-x86_64.rpm` |
| Linux 通用 | `ToAPI-<ver>-linux-x64.tar.gz` | 解压后运行 `toapi` |
| Apple Silicon | `ToAPI-<ver>-mac-arm64.dmg` / `.zip` | 未签名：Finder 里右键 →「打开」；或 `xattr -dr com.apple.quarantine /Applications/ToAPI.app` |

**未签名**：没有 Windows Authenticode 证书与 Apple 开发者公证，Windows 首次运行过 SmartScreen、macOS 需右键打开。**macOS Intel（x86_64）与 Windows arm64 暂未出包**。
**平台差异**：只有 Windows 用无边框窗口 + 自绘标题栏，Linux/macOS 保留系统原生装饰；「关窗最小化到托盘」在 Linux 默认关闭（GNOME 等常无可用托盘，默认隐藏等于把应用藏没），Windows/macOS 默认开启。

历史版本：v0.4.0 定时回归 + 通知中心 + 托盘（仅 Windows 产物）；v0.3.0 `.tapi` 互传 + AI 可调用面 + 全局搜索；v0.2.0 Postman B1+B2（Collection/Environment 双向、`pm.*`、数据驱动、`toapi run`）；v0.1.x 界面与视觉基线（浅灰画布 + 白色浮层、药丸控件、自有 LOGO、无边框标题栏）。均未做代码签名。

视觉与交互基线（v0.1.2–v0.1.6 逐步定型，现仍沿用）：浅灰画布 `#F2F2F4` 上漂浮三块白色面板（14px 圆角、1px 细线、10px 间距、无投影）、下划线文字 Tab、底色方法/状态徽章、填充式输入框、URL 44px 大胶囊、底部居中 Toast、原生直角下拉换成 10px 弹层 + 999px 药丸选项、Windows 无边框窗口与 46px 自绘标题栏、标题栏与安装包使用自有 `TA.` LOGO。1024×640 下三栏不重叠、URL 输入实测 ≥200px。

### 已跑过的验证（不是声明，是实测）

```bash
npm run gate             # typecheck + lint + format:check + check:channels + 全部测试
npm run verify:flow      # CDP 驱动真机：建项目→建接口→发送→脚本断言→集合 Runner→定时任务→通知→重启验持久化→托盘/关窗语义
node scripts/smoke-package.mjs <产物路径>   # 打包产物冷启动冒烟（三平台通用）
```

CI（`.github/workflows/`）：`pr.yml` 在 ubuntu-22.04 与 windows-latest 双平台跑 `npm run gate` + CLI 自举；`release.yml` 在 tag 推送时于 **windows-latest / ubuntu-22.04 / macos-14 三个原生 runner** 各自跑「本平台测试 → golden-path e2e → 打包 → 产物冒烟」，全绿才收进 Release 并生成 `sha256sums.txt`。v0.4.1 三平台首次运行即全绿，并暴露了只在 macOS 出现的 App Nap 挂起问题（已修，见 15 号文档 §4）。

真机验证要点（`scripts/verify-flow.mjs` 输出）：状态行 `200 OK · 16ms · 112 B`、脚本两条断言通过、两个接口的集合 Runner 输出「默认集合 · 2/2 项 · 通过率 100%」、query 送达靶场；画布 `rgb(242,242,244)`、三块面板白底/1px/14px、下划线 Tab 透明底+2px 黑条、Toast 距底 44px 且 999px 圆角；右键菜单 10px/无阴影、下拉弹层 10px/无阴影/选项 999px、命令面板 14px、删除确认文案、拖拽排序、栏宽 300→240 与上下/左右分屏全部持久化；1024×640 三栏不重叠且 URL 237px；标题栏 46px 且 `drag`、控件 `no-drag`、三枚 32×28/8px 均带 title、品牌 LOGO 实测加载（128px 源显示 24px），点击最大化/还原/最小化后由 Win32 `GetWindowPlacement` 实测 `maximized → normal → minimized`，关闭按钮真实退出进程；字体仅 12/13/14/20、按钮按角色圆角且带 title、渐变/投影计数 0、JSON 三色 `22/29/180` 正确；DOM emoji 0、两轮 console 错误 0。

### 运行

```bash
npm install
npm run build && npm start     # 生产式启动
npm run dev                    # vite HMR + esbuild watch + Electron
```
