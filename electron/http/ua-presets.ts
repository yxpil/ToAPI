// @author yxpil
// UA 预设库（05 号文档 §3）。随版本更新维护，UI 伪装面板与脚本共用。
export const UA_PRESETS = {
  'chrome-win':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'chrome-mac':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'firefox-win': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'edge-win':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'safari-ios':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1',
  postman: 'PostmanRuntime/7.42.0',
  curl: 'curl/8.9.1',
  okhttp: 'okhttp/4.12.0',
} as const

export type UaPresetName = keyof typeof UA_PRESETS

const PRESET_PREFIX = '@preset:'

export const presetNames = (): UaPresetName[] => Object.keys(UA_PRESETS) as UaPresetName[]

/** 解析 `@preset:name` 或直接返回原字符串；未知预设报错交由上层校验 */
export function resolveUa(input: string | undefined): string | undefined {
  if (!input) return undefined
  if (!input.startsWith(PRESET_PREFIX)) return input
  const name = input.slice(PRESET_PREFIX.length) as UaPresetName
  const value = UA_PRESETS[name]
  if (!value) throw new Error(`未知 UA 预设: ${name}`)
  return value
}
