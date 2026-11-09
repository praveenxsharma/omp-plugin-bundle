#!/usr/bin/env node
// Compile src/*.ts to lib/*.js. No DeepSeek Harness checkout is required.
import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const require = createRequire(import.meta.url)

function tscBin() {
  try {
    return require.resolve('typescript/bin/tsc')
  } catch {
    return undefined
  }
}

const tsc = tscBin()
if (!tsc) {
  console.error('omp-antigravity-acp: typescript is not installed. Run npm install in this package.')
  process.exit(1)
}

const args = ['-p', join(root, 'tsconfig.json')]
if (checkOnly) args.push('--noEmit')
else rmSync(join(root, 'lib'), { recursive: true, force: true })

const result = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
if (!checkOnly && !existsSync(join(root, 'lib', 'extension.js'))) {
  console.error('omp-antigravity-acp: build did not emit lib/extension.js')
  process.exit(1)
}
if (!checkOnly) console.log('omp-antigravity-acp: built lib/')
