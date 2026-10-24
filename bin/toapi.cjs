#!/usr/bin/env node
// @author yxpil
'use strict'

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const bundle = join(__dirname, '..', 'dist-electron', 'cli.cjs')
if (!existsSync(bundle)) {
  process.stderr.write('未找到 dist-electron/cli.cjs，请先执行 npm run build:electron\n')
  process.exitCode = 2
} else {
  const { runCli } = require(bundle)
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e) => {
      process.stderr.write(`错误：${(e && e.stack) || e}\n`)
      process.exitCode = 2
    },
  )
}
