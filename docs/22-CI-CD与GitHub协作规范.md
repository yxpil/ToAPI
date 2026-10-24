# ToAPI — CI/CD 与 GitHub 协作规范

> 覆盖：分支模型、PR 流程、GitHub Actions 流水线（PR 门禁 / 夜间 / 发版）、
> 签名公证、发布通道、Issue/标签体系。测试金字塔细节见 21 号文档，平台矩阵见 14 号文档。

## 1. 分支模型（简化 trunk-based）

```
main（受保护）        ← 永远可发布
├─ feat/<scope>-<短述>      功能分支，寿命 ≤ 3 天
├─ fix/<scope>-<短述>       修复分支
└─ release/x.y.z            发版 stabilization 分支（仅发版期存在，只收 fix）
```

- 禁直接向 main push；一切经 PR + squash merge（保持 main 线性、每个 PR 一个提交）。
- 提交信息规范沿用 20 号文档 §9；squash 后标题 = PR 标题，须符合 `type(scope): 摘要`。
- main 历史即变更日志来源：release 时用 `git log` 按 type 分组生成 CHANGELOG。

## 2. PR 流程与门禁

### 2.1 PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）
```
## 变更内容
## 契约变更
- [ ] 改了 shared/channels.ts（须同步 04 号文档并附 diff 链接）
- [ ] 改了 DB migration（须同步 03 号文档）
- [ ] 改了沙箱 API（须同步 05 号文档）
- [ ] 改了 UI tokens/组件行为（须同步 06 号文档）
## 验证
- [ ] 本地 unit+integration 通过
- [ ] 新增行为有对应测试（单测/集成/E2E 之一）
- [ ] UI 变更附截图（含 hover/focus/disabled 态）
```

### 2.2 评审规则
- 至少 1 名 reviewer；`shared/`、`electron/db/migrations/`、`electron/open/`（安全面）改动需 CODEOWNERS 中对应 owner 批准。
- 评审焦点顺序：契约一致性 → 安全红线（20 号文档 §8）→ 测试覆盖 → 风格（风格有 lint 兜底，不做逐行 nit）。
- PR 体积：diff 超 800 行应拆分；纯格式化/重命名必须独立 PR。

## 3. GitHub Actions 流水线

### 3.1 `pr.yml` — PR 门禁（每个 PR 触发，目标 < 10 分钟）
```
jobs 并行：
  lint        → eslint + prettier --check + i18n key 覆盖 lint
  typecheck   → tsc --noEmit（strict）
  channels    → scripts/check-channels.ts（19 号文档 §7 四方一致）
  unit        → vitest run --project unit（Linux runner，Node 矩阵：Electron 内置版本）
  integration → vitest run --project integration（含靶场）
  sandbox     → vitest run --project sandbox（含 python job 变体）
全绿才可合并（required status checks）。
```

### 3.2 `nightly.yml` — 夜间（cron 02:00 UTC）
```
- e2e 全套（Windows + macOS + Linux 三 runner 并行）
- @online 标记用例（真实网络探测，失败只告警不阻塞）
- 压测引擎长跑回归：本地靶场 200 RPS × 300s，断言资源预算（13 号文档 §3）
- 自举回归：用 `toapi run` 跑真实 Collection（含 `--data` 数据驱动、`--bail`、`--reporters junit`），退出码非 0 即夜间失败，JUnit 与 HTML 报告以 artifact 上传（23 号文档 §5.3）
- DB 迁移矩阵：v1..v(n-1) 样本库逐一升到最新
- 失败 → 自动开 issue（label: nightly-failure，指派当天值班）
```

### 3.3 `release.yml` — 发版（tag `v*.*.*` 触发）
```
1. 验证门禁：golden-path e2e 全绿（三平台）+ 07 号文档 §4 检查单脚本化部分
2. 构建矩阵（14 号文档 §3.1）：
   windows-latest      → x64/arm64 NSIS + zip（signtool 签名）
   macos-latest        → universal dmg/zip（notarize 公证 + staple）
   ubuntu-latest       → x64/arm64 AppImage/deb/rpm/tar.gz
   国产 OS 适配 job     → UOS/麒麟 deb（QEMU 容器内构建+冒烟）
   loong64 job         → 龙芯 Electron 分支构建（allow-failure: true，产物标 beta）
3. 产物校验：每包跑冒烟（启动→请求靶场→DB 迁移→Runner）后才上传
4. 发布：draft release → 自动生成 CHANGELOG（按 type 分组）→ 人工确认公开
   → electron-updater 渠道推送（stable）；sha256sums.txt + GPG 签名随包
```

### 3.4 流水线纪律
- Secrets（签名证书、notarize 凭证、GPG key）只进 GitHub Environments，配 required reviewer 才可用；禁止进 fork PR 上下文。
- CI 时间与缓存：依赖 npm cache（`actions/setup-node` 的 cache: npm）+ 原生模块 prebuild 缓存；任一 job 超 15 分钟必须拆分。
- workflow 文件本身变更需额外 reviewer（`CODEOWNERS` 覆盖 `.github/workflows/`）。

## 4. 版本与发布节奏

| 项 | 规则 |
|---|---|
| 版本号 | SemVer；契约破坏（channel 删除/载荷不兼容、TAPI format 大版本）必升 minor 以上 |
| 节奏 | 每 2 周一个 minor（对齐 01 号文档里程碑）；hotfix 走 patch 随时发 |
| 通道 | `latest`（stable）/ `beta`（feature-flag 预览）；auto-update 默认只跟 stable |
| 兼容性承诺 | TAPI format、`.tapi.md` 指令、MCP tools 名称进 SemVer 承诺；DB 只能向前迁移 |
| 回滚 | release 发现致命问题：撤销 release 标记 + auto-update 指向上一版 + hotfix 分支修复 |

## 5. Issue 与项目管理

### 5.1 标签体系
| 类别 | 标签 |
|---|---|
| 类型 | `bug` / `feat` / `docs` / `chore` |
| 域 | `area:runner` `area:http` `area:ui` `area:mcp` ...（与模块名一致） |
| 平台 | `os:windows` `os:macos` `os:linux` `arch:loong64` `os:uos` |
| 状态 | `needs-triage` / `confirmed` / `help-wanted` / `nightly-failure` / `flaky-test` |

### 5.2 Issue 模板
- Bug：环境（OS/架构/版本）+ 复现步骤 + 期望/实际 + `history`/`external_call_log` 相关片段（提示脱敏）
- Feature：场景 → 建议方案 → 是否愿提 PR；进 01 号文档 §6 候选清单评估流程

### 5.3 里程碑与看板
- GitHub Milestone 对齐 M1–M8；Project 看板列：Backlog / In Progress / In Review / Done。
- 每周 triage：`needs-triage` 清零，候选清单条目要么进里程碑要么明确不做（进非目标）。

## 6. 安全响应

- `SECURITY.md`：漏洞报告走 GitHub Private Vulnerability Reporting，禁公开 issue。
- 响应 SLA：确认 ≤ 48h，修复版本 ≤ 7 天（高危）；CVE 编号申请与披露随 release notes。
- 供应链：依赖每周 `npm audit` + Dependabot；原生依赖升级需重跑全架构冒烟（14 号文档 §3.2）。

## 7. 度量（每月看一次）

- PR 门禁时长 P50/P95、夜间失败率、flaky 率（重试后通过占比）、发版频率、回滚次数。
- 目标：门禁 P95 < 10min、flaky 率 < 1%、夜间失败 48h 内有主。
