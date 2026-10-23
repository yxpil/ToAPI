# ToAPI — TAPI 文件格式规范（跨部门互传）

> `.tapi` 是 ToAPI 的单一文件交换格式：一个项目（或其子集）的接口、脚本、
> 环境、测试案例打包成一个 JSON 文件，丢给任何部门的同事双击即可导入。

## 1. 设计目标

| 目标 | 落地 |
|---|---|
| 单文件可传输 | 一个 `.tapi` 文件走 IM/邮件/网盘均可，无外部依赖 |
| 人类可读 | 格式化 JSON，diff 友好，可进 Git 做版本管理 |
| 安全可控 | 导出时敏感变量默认剔除，可选加密 |
| 向后兼容 | `format_version` 语义化版本，旧应用读新文件给出明确提示 |
| 可校验 | 内嵌 JSON Schema 版本号 + 文件级 SHA-256 校验和 |

## 2. 文件结构

```jsonc
{
  "format": "tapi",
  "format_version": "1.0",
  "meta": {
    "exported_at": 1761206400000,
    "app_version": "0.5.0",
    "name": "订单中心接口",
    "description": "给测试部的联调用例集",
    "checksum": "sha256:..."        // 对 payload 的规范化 JSON 取哈希，见 §6
  },
  "payload": {
    "project": { /* 见 §3 */ },
    "environments": [ /* 见 §4 */ ],
    "globals": [ /* 全局变量（可选） */ ],
    "cases": [ /* 测试案例（可选，见 09 号文档） */ ]
  }
}
```

## 3. payload.project — 项目树

与 DB 结构一一对应，但 ID 在导出时**重新生成**（导出专用临时 ID），导入时映射为新 ULID，避免跨库主键冲突：

```jsonc
{
  "name": "订单中心",
  "description": "",
  "settings": { "fake": { "ua": "@preset:chrome-win" } },
  "collections": [
    {
      "key": "col-1",               // 文件内引用键，非数据库 ID
      "name": "订单接口",
      "pre_script": "...",
      "post_script": "",
      "children": [ /* 嵌套 collection */ ],
      "apis": [
        {
          "key": "api-1",
          "name": "创建订单",
          "method": "POST",
          "url": "{{baseUrl}}/api/orders",
          "params": [],
          "headers": [{"key":"Content-Type","value":"application/json","enabled":true}],
          "body_type": "json",
          "body": "{...}",
          "auth": {"type":"bearer","token":"{{token}}"},
          "fake": {},
          "pre_script": "",
          "post_script": "",
          "extractors": [
            {"name":"orderId","source":"body","type":"jsonpath","expr":"$.data.id","scope":"runtime"}
          ],
          "tests": [ /* 自动生成的断言脚手架，见 09 号文档 §5 */ ]
        }
      ]
    }
  ]
}
```

## 4. payload.environments — 环境与敏感数据

```jsonc
{
  "name": "staging",
  "variables": [
    {"key": "baseUrl", "value": "https://staging.example.com", "secret": false},
    {"key": "password", "value": "", "secret": true, "redacted": true}
  ]
}
```

| 导出选项 | 行为 |
|---|---|
| 剔除敏感变量（默认） | `secret=1` 的变量 `value` 置空、`redacted: true`，导入方 UI 高亮提示"需自行填写" |
| 携带敏感变量 | 明文写入，导出前二次确认弹窗，文件头加 `"contains_secrets": true` 醒目提示 |
| 加密携带 | AES-256-GCM，密码导出时设置；导入方输入密码解密，密文存 `value_enc` |

> 历史记录、Runner 记录、Cookie Jar **永不导出** —— TAPI 只携带"定义"，不携带"数据"。

## 5. 导入策略

导入入口：拖文件进窗口 / 菜单导入 / `tapi:import` channel。

| 冲突 | 策略（用户可选，默认第一项） |
|---|---|
| 项目名称已存在 | 重命名为「订单中心 (2)」 / 合并进同名项目 |
| 合并时集合同名 | 按名称合并，接口按「名称+方法+URL」判重 |
| 接口判重命中 | 跳过 / 覆盖 / 保留两份（重命名） |
| format_version 高于应用支持 | 拒绝导入，提示升级；低于当前版本走迁移链（与 DB 迁移同机制） |
| checksum 不匹配 | 警告"文件可能被修改"，用户确认后可继续 |

导入全程事务：任何一步失败整体回滚，不留半个项目。

## 6. 校验和算法

```
canonical = JSON.stringify(payload, 按 key 字典序递归排序, 无空白)
checksum  = "sha256:" + hex(sha256(utf8(canonical)))
```
导入时重新计算比对。字段遗漏（旧版本导出无 checksum）降级为跳过校验。

## 7. IPC 契约（追加进 04 号文档清单）

| Channel | 入参 | 返回 |
|---|---|---|
| `tapi:export` | `{projectId, scope?: {collectionIds?}, secrets:'strip'\|'plain'\|'encrypt', password?, filePath}` | `{filePath, stats:{apis, collections, cases}}` |
| `tapi:inspect` | `{filePath}` | `{meta, stats, containsSecrets, supported}`（导入预览，不写库） |
| `tapi:import` | `{filePath, strategy, password?}` | `{projectId, imported, skipped}` |

## 8. 与 Git 协作的建议用法

- `.tapi` 文件可直接进部门间共享仓库，格式化 JSON 保证 diff 可读。
- 敏感变量走"剔除"导出 + 接收方本地环境补齐，仓库里永不落明文密钥。
- 建议在文件名携带日期与环境：`订单中心-staging-20261023.tapi`。
