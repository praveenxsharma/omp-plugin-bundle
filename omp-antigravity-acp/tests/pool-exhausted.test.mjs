// End-to-end tests of the pool-exhaustion failure: every configured account is
// named with the reason it cannot serve the requested model, the upstream error
// that parked a bucket survives as the cooldown's reason, and the failure tells
// the harness retry layer when the nearest window reopens.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'
import { AccountPool, buildLayouts } from '../lib/accounts.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
const runtimes = []

/** One declared account with its own isolated root and sandbox `$HOME`. */
function account(id, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), `agy-macc-${id}-`))
  return {
    root,
    homeDir: join(root, 'home'),
    profile: { id, displayName: `${id} account`, home: root, enabled: true, env: {}, ...extra },
  }
}

/**
 * Runtime over the fake agent. Accounts listed in `quotaAccounts` get the
 * `FAKE_AGY_FAIL=quota` marker in their ACP process environment, so a prompt
 * carrying the fake's `QUOTA` directive answers with the quota error the real
 * CLI reports for an exhausted weekly window. The other accounts stay healthy.
 */
function makeRuntime({ accounts = [], quotaAccounts = [], omitArgonAccounts = [], usageByHome = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-multi-account-test-'))
  const armedHomes = new Set(quotaAccounts.map(entry => entry.homeDir))
  const noArgonHomes = new Set(omitArgonAccounts.map(entry => entry.homeDir))
  const warnings = []
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    accounts: accounts.map(entry => entry.profile),
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd, env) => {
      const childEnv = { ...process.env, ...env }
      delete childEnv.FAKE_AGY_FAIL
      delete childEnv.FAKE_AGY_OMIT_MODELS
      childEnv.FAKE_AGY_LOG = join(env?.HOME ?? home, 'prompts.jsonl')
      if (env?.HOME !== undefined && armedHomes.has(env.HOME)) childEnv.FAKE_AGY_FAIL = 'quota'
      if (env?.HOME !== undefined && noArgonHomes.has(env.HOME)) childEnv.FAKE_AGY_OMIT_MODELS = 'gemini-4-argon'
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(),
        stderrTail: () => stderr,
      }
    },
    // `agy -p /usage` answers per account: the scripted windows are keyed by the
    // sandbox `$HOME` of the account the read runs under, so one account's plan
    // can never answer for another.
    runCommand: async (argv, _timeoutMs, env) => {
      if (argv.includes('--version')) return { code: 0, stdout: 'fake-agy 0.0.1', stderr: '' }
      const groups = env?.HOME !== undefined ? usageByHome[env.HOME] : undefined
      if (argv.includes('/usage') && groups !== undefined) {
        return { code: 0, stdout: JSON.stringify({ command: { data: { groups } } }), stderr: '' }
      }
      return { code: 0, stdout: '{}', stderr: '' }
    },
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: message => { warnings.push(message) } },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  /** Prompts one account's own ACP process received. */
  const prompts = (entry) => {
    const file = join(entry.homeDir, 'prompts.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  return { runtime, warnings, prompts, adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true) }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Run one step and return the rejection it must raise. */
async function rejectionOf(iterable) {
  try {
    await collect(iterable)
  } catch (error) {
    return error
  }
  assert.fail('the step resolved instead of failing')
}

test('a single exhausted account is named with its cooldown, upstream error, and retry delay', async () => {
  const a = account('a')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a], quotaAccounts: [a] })

  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'claude-opus-5-5',
    sessionId: 'PE1',
    messages: [sys, user('u1', 'QUOTA answer now')],
  }))

  assert.equal(error.code, 'RATE_LIMIT', 'exhausting the pool is a rate-limit failure')
  assert.match(error.message, /No Antigravity account can serve claude-opus-5-5/, 'the message names the requested model, not the family')
  assert.match(error.message, /a parked 10m \(last error: .*weekly limit reached/, 'the parked account carries its upstream error')
  assert.match(error.message, /failed this step/, 'the account that was tried is marked')
  assert.ok(error.failure.providerRetryAfterMs > 10_000, `the retry delay exceeds the 10s cutoff (${String(error.failure.providerRetryAfterMs)})`)
  assert.equal(prompts(a).length, 1, 'the only account saw the step exactly once')
})

test('an account without entitlement is named as such while the exhausted account shows its cooldown', async () => {
  const a = account('a', { visibleModels: ['gemini-3.8-flash'] })
  const b = account('b')
  const { runtime, adapter } = makeRuntime({ accounts: [a, b], quotaAccounts: [b] })

  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'PE2',
    messages: [sys, user('u1', 'QUOTA plan')],
  }))

  assert.equal(error.code, 'RATE_LIMIT')
  assert.match(error.message, /No Antigravity account can serve gemini-4-argon/)
  assert.match(error.message, /a not entitled to gemini-4-argon/, 'the narrowed account is explained, not left blank')
  assert.match(error.message, /b parked \d+m/, 'the quota account shows its Argon cooldown')
})

test('the pool keeps each cooldown reason until the cooldown expires or is cleared', () => {
  const layouts = buildLayouts({
    home: '/base',
    accounts: [{ id: 'a', displayName: '', home: '/base/a', enabled: true, env: {} }],
  })
  const pool = new AccountPool(layouts)

  const until = Date.now() + 60_000
  pool.exhaust('a', 'claude', until, 'QUOTA: weekly limit reached')
  assert.equal(pool.cooldownReason('a', 'claude'), 'QUOTA: weekly limit reached')
  assert.equal(pool.cooldownReason('a', 'claude', until + 1), undefined, 'an expired cooldown forgets its reason')

  pool.exhaust('a', 'claude', Date.now() + 60_000, 'again')
  assert.equal(pool.cooldownReason('a', 'claude'), 'again')
  pool.clear('a')
  assert.equal(pool.cooldownReason('a', 'claude'), undefined, 'clearing the account drops the reason')
  assert.equal(pool.cooldownMs('a', 'claude'), 0)

  // The old three-argument call shape keeps working, and a re-park without a
  // reason must not resurrect the previous one.
  pool.exhaustFor('a', 'claude', undefined)
  assert.ok(pool.cooldownMs('a', 'claude') > 0, 'the legacy call still parks the account')
  assert.equal(pool.cooldownReason('a', 'claude'), undefined, 'no reason was recorded')

  pool.exhaust('a', 'claude', Date.now() + 60_000, 'stale')
  pool.exhaust('a', 'claude', Date.now() + 60_000)
  assert.equal(pool.cooldownReason('a', 'claude'), undefined, 'a reasonless re-park clears the old reason')
})
