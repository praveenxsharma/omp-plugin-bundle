// Unit tests of what a real start does with the configuration: the boot
// write-back of the merged shape, the live account list the scheduler reads,
// and a provider that boots with no account at all.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLayouts, pluginHome, SYSTEM_ACCOUNT_ID } from '../lib/accounts.js'
import { liveAccounts, name as PLUGIN_NAME, writeMigrationBack } from '../lib/index.js'
import { CONFIG_VERSION, migrateConfig } from '../lib/migrate.js'
import { AntigravityRuntime } from '../lib/runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)

const CATALOG = [
  'gemini-4-argon',
  'gemini-3.8-flash',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b-medium',
]

/** The machine account as one entry of an account list. */
const machineAccount = (extra = {}) => ({
  id: SYSTEM_ACCOUNT_ID,
  system: true,
  displayName: '',
  home: '',
  enabled: true,
  env: {},
  contextWindow: 0,
  visibleModels: [],
  priority: 1,
  weight: 1,
  ...extra,
})

/** A declared account as one entry of an account list. */
const account = (id, extra = {}) => ({
  id,
  displayName: '',
  home: '',
  enabled: true,
  env: {},
  contextWindow: 0,
  visibleModels: [],
  priority: 1,
  weight: 1,
  ...extra,
})

/** A stored configuration written before the account list became the only truth. */
const OLD_STORED = { provider: 'antigravity', accounts: [], useSystemAccount: true, configVersion: 0 }

/** Settings service double that records every update. */
function fakeSettings(mode = 'ok') {
  const calls = []
  return {
    writable: true,
    calls,
    async update(ns, values) {
      calls.push({ ns, values })
      if (mode === 'throw') throw new Error('read-only profile')
    },
  }
}

const runtimes = []
after(async () => {
  for (const runtime of runtimes) await runtime.dispose()
})

/**
 * Build a runtime the way the plugin does: the account list is a live view over
 * the stored service, and every account runs the scripted fake CLI.
 */
function makeRuntime(accounts) {
  const home = mkdtempSync(join(tmpdir(), 'agy-acp-boot-'))
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    accounts,
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', data => { stderr += data })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(),
        stderrTail: () => stderr,
      }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  return { home, runtime }
}

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('an older configuration is written back once with its accounts and version together', async () => {
  const migrated = migrateConfig(OLD_STORED, CATALOG)
  assert.equal(migrated.changed, true)
  const settings = fakeSettings()
  const outcome = await writeMigrationBack({
    settings,
    namespace: PLUGIN_NAME,
    migrated,
    accounts: OLD_STORED.accounts,
    configVersion: OLD_STORED.configVersion,
    warn: message => assert.fail(`unexpected warning: ${message}`),
  })

  assert.equal(outcome, 'written')
  assert.equal(settings.calls.length, 1, 'one update carries the whole migration')
  assert.equal(settings.calls[0].ns, PLUGIN_NAME)
  assert.deepEqual(Object.keys(settings.calls[0].values).sort(), ['accounts', 'configVersion'])
  assert.deepEqual(settings.calls[0].values.accounts.map(entry => entry.id), [SYSTEM_ACCOUNT_ID])
  assert.equal(settings.calls[0].values.configVersion, CONFIG_VERSION)
})

test('a configuration that already carries the merged shape is left alone', async () => {
  const migrated = migrateConfig({ accounts: [machineAccount()], configVersion: CONFIG_VERSION }, CATALOG)
  assert.equal(migrated.changed, false)
  const settings = fakeSettings()
  const outcome = await writeMigrationBack({
    settings,
    namespace: PLUGIN_NAME,
    migrated,
    accounts: [machineAccount()],
    configVersion: CONFIG_VERSION,
    warn: () => undefined,
  })

  assert.equal(outcome, 'skipped')
  assert.equal(settings.calls.length, 0)
})

test('a refused write logs a warning and leaves the start working', async () => {
  const migrated = migrateConfig(OLD_STORED, CATALOG)
  const settings = fakeSettings('throw')
  const warnings = []
  const outcome = await writeMigrationBack({
    settings,
    namespace: PLUGIN_NAME,
    migrated,
    accounts: OLD_STORED.accounts,
    configVersion: OLD_STORED.configVersion,
    warn: message => warnings.push(message),
  })

  assert.equal(outcome, 'failed')
  assert.equal(settings.calls.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /antigravity-acp: could not store the migrated configuration/)
})

test('the live account list reflects an edit on the next read, merged and without resurrecting a removed machine account', () => {
  let stored = [machineAccount()]
  const config = {
    accounts: { get: () => stored },
    configVersion: { get: () => CONFIG_VERSION },
    visibleModels: { get: () => [] },
  }
  const view = liveAccounts(config, CATALOG)

  assert.deepEqual(view.get().map(entry => entry.id), [SYSTEM_ACCOUNT_ID])
  stored = [...stored, account('acc-1')]
  assert.deepEqual(view.get().map(entry => entry.id), [SYSTEM_ACCOUNT_ID, 'acc-1'])

  // Version 2 keeps the list as the only truth: a removed machine account stays removed.
  stored = [account('acc-1')]
  assert.deepEqual(view.get().map(entry => entry.id), ['acc-1'])

  // A retired per-account family gate is folded into visibleModels on every read.
  stored = [account('acc-1', { families: ['claude'] })]
  assert.deepEqual(view.get()[0].visibleModels, ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.equal(Object.hasOwn(view.get()[0], 'families'), false)
})

test('an account added to the live list reaches the account pool on the next apply', () => {
  let stored = [machineAccount()]
  const view = liveAccounts({
    accounts: { get: () => stored },
    configVersion: { get: () => CONFIG_VERSION },
    visibleModels: { get: () => [] },
  }, CATALOG)
  const { runtime } = makeRuntime(view)
  assert.deepEqual(runtime.status().accounts.map(row => row.id), [SYSTEM_ACCOUNT_ID])

  stored = [...stored, account('acc-1')]
  const status = runtime.configure({ accounts: view.get() })
  assert.deepEqual(status.accounts.map(row => row.id), [SYSTEM_ACCOUNT_ID, 'acc-1'])
  assert.deepEqual(buildLayouts({ home: '', accounts: view.get() }).map(layout => layout.id), [SYSTEM_ACCOUNT_ID, 'acc-1'])
})

test('an empty account list boots with a normal status and no account rows', () => {
  const { home, runtime } = makeRuntime([])
  const status = runtime.status()
  assert.equal(status.state, 'idle')
  assert.deepEqual(status.accounts, [])
  assert.equal(pluginHome(home), home)
  assert.deepEqual(buildLayouts({ home, accounts: [] }), [])
})

test('a request with no account fails with AUTH and a message that says what to do', async () => {
  const { runtime } = makeRuntime([])
  await assert.rejects(
    collect(runtime.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'S-empty', messages: [sys, user('u1', 'hello')] })),
    error => {
      assert.equal(error.code, 'AUTH')
      assert.equal(error.message, '[not signed in] No Antigravity account is available. Run /agy-login or /agy-accounts add <id>.')
      return true
    },
  )
})

test('adding an account through configure makes the provider serve requests again', async () => {
  const { home, runtime } = makeRuntime([])
  await assert.rejects(collect(runtime.stream({ provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'S1', messages: [sys, user('u1', 'hello')] })))

  runtime.configure({ accounts: [account('acc-1')] })
  assert.deepEqual(runtime.status().accounts.map(row => row.id), ['acc-1'])

  const chunks = await collect(runtime.stream({ provider: 'antigravity', model: 'gemini-3.8-flash', reasoningEffort: 'low', sessionId: 'S2', messages: [sys, user('u2', 'hello')] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /^echo:gemini-3\.8-flash:low:/)

  // The plugin's own data (session index, catalog cache) stays in the plugin
  // home of an empty start; the account keeps only its isolated sandbox.
  assert.ok(existsSync(join(home, 'session-index.json')))
  assert.ok(existsSync(join(home, 'catalog.json')))
  assert.equal(existsSync(join(home, 'accounts', 'acc-1', 'gemini', 'catalog.json')), false)
})
