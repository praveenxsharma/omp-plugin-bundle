// End-to-end tests of the multi-account runtime against the scripted fake ACP
// agent: quota failover inside one step, cooldowns isolated per model family,
// and an exhausted pool that fails instead of silently succeeding.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'

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
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const finishOf = chunks => chunks.at(-1)
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const assistantFrom = (id, chunks) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block))
/** Open cooldown families of one account, sorted for stable comparisons. */
const cooldownsOf = (runtime, id) => runtime.status().accounts.find(row => row.id === id).cooldowns.map(row => row.family).sort()

test('a quota failure on the chosen account fails the same step over to the next account', async () => {
  const a = account('a')
  const b = account('b')
  const { runtime, adapter, prompts, warnings } = makeRuntime({ accounts: [a, b], quotaAccounts: [a] })
  const base = { provider: 'antigravity', model: 'claude-opus-5-5', sessionId: 'MAC1' }

  const step1 = await collect(adapter.stream({ ...base, messages: [sys, user('u1', 'QUOTA write the weekly report')] }))
  assert.equal(finishOf(step1).reason.kind, 'stop')
  assert.match(textOf(step1), /echo:claude-opus-5-5:high:QUOTA write the weekly report/)

  // Only the account that reported exhaustion is parked, and only for Claude;
  // the healthy account carries the step to completion.
  assert.deepEqual(cooldownsOf(runtime, 'a'), ['claude'])
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])
  assert.equal(runtime.status().lastAccount, 'b')
  assert.ok(warnings.some(message => /account "a" cannot serve claude/.test(message)), 'the failover is logged')

  // The failed attempt hit account a; the retry replayed the same step on b.
  // Session ids are numbered per agent process, so both are its first session.
  const onA = prompts(a)
  const onB = prompts(b)
  assert.equal(onA.length, 1)
  assert.match(onA[0].text, /QUOTA write the weekly report/)
  assert.equal(onB.length, 1)
  assert.match(onB[0].text, /QUOTA write the weekly report/)

  // A later step of the same conversation continues on b with no quota error.
  const history = [sys, user('u1', 'QUOTA write the weekly report'), assistantFrom('a1', step1)]
  const step2 = await collect(adapter.stream({ ...base, messages: [...history, user('u2', 'second question')] }))
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.match(textOf(step2), /second question/)
  assert.equal(prompts(a).length, 1, 'the parked account receives no further traffic')
  assert.equal(prompts(b).length, 2)
  assert.equal(prompts(b)[1].session, prompts(b)[0].session, 'the follow-up reuses the ACP session b opened for the failed-over step')
  assert.equal(runtime.status().lastAccount, 'b')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])
})

test('a quota cooldown is scoped to the model family that reported it', async () => {
  const a = account('a')
  const b = account('b')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a, b], quotaAccounts: [a] })

  // Account a exhausts its Claude window and b serves that step.
  const claude = await collect(adapter.stream({ provider: 'antigravity', model: 'claude-opus-5-5', sessionId: 'MAC2', messages: [sys, user('c1', 'QUOTA plan the migration')] }))
  assert.equal(finishOf(claude).reason.kind, 'stop')
  assert.deepEqual(cooldownsOf(runtime, 'a'), ['claude'])

  // Gemini is a separate window on the same account: a serves it again.
  const gemini = await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'MAC2-gemini', messages: [sys, user('g1', 'summarize this repository')] }))
  assert.equal(finishOf(gemini).reason.kind, 'stop')
  assert.match(textOf(gemini), /echo:gemini-4-argon:high:summarize this repository/)
  assert.equal(runtime.status().lastAccount, 'a')
  assert.deepEqual(cooldownsOf(runtime, 'a'), ['claude'], 'the Gemini step opens no Gemini cooldown')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])
  assert.equal(prompts(a).length, 2)
  assert.match(prompts(a)[1].text, /summarize this repository/)
  assert.doesNotMatch(prompts(a)[1].text, /QUOTA/)
  assert.equal(prompts(b).length, 1, 'b served only the failed-over Claude step')
})

test('an exhausted pool raises a rate-limit failure instead of silently succeeding', async () => {
  const a = account('a')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a], quotaAccounts: [a] })
  await assert.rejects(
    collect(adapter.stream({ provider: 'antigravity', model: 'claude-opus-5-5', sessionId: 'MAC3', messages: [sys, user('u1', 'QUOTA answer now')] })),
    error => {
      assert.ok(error?.code === 'QUOTA' || error?.code === 'RATE_LIMIT', `unexpected failure code ${String(error?.code)}`)
      return true
    },
  )
  assert.deepEqual(cooldownsOf(runtime, 'a'), ['claude'])
  assert.equal(prompts(a).length, 1, 'the only account saw the step exactly once')
})

test('an unentitled secondary account failing select() with UNKNOWN_MODEL fails over pre-output to an Argon-entitled account', async () => {
  const freeAcc = account('free-secondary')
  const ultraAcc = account('ultra-primary')
  const { runtime, adapter, prompts, warnings } = makeRuntime({
    accounts: [freeAcc, ultraAcc],
    omitArgonAccounts: [freeAcc],
  })

  const step1 = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'MAC-ARGON-FAILOVER',
    messages: [sys, user('u1', 'solve complex architecture bug')],
  }))
  assert.equal(finishOf(step1).reason.kind, 'stop')
  assert.match(textOf(step1), /echo:gemini-4-argon:high:solve complex architecture bug/)
  assert.equal(runtime.status().lastAccount, 'ultra-primary')
  assert.equal(prompts(freeAcc).length, 0, 'unentitled account never receives the Argon prompt')
  assert.equal(prompts(ultraAcc).length, 1)
  assert.ok(warnings.some(m => /account "free-secondary" is not entitled to gemini-4-argon/.test(m)))
})

test('the quota pill reads the account that serves the model, not the account that ran last', async () => {
  const ultra = account('ultra', { displayName: 'Ultra plan', priority: 2 })
  const pro = account('pro', { displayName: 'Pro plan', priority: 1 })
  const reset = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const usageByHome = {
    [ultra.homeDir]: [
      { name: 'Gemini 4 Argon / 3.8', buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.98, reset_time: reset }] },
      { name: 'Gemini 3.8 Flash', buckets: [{ id: 'gemini-flash-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.77, reset_time: reset }] },
    ],
    [pro.homeDir]: [
      { name: 'Gemini 3.8 Flash', buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset }] },
      { name: 'Claude 4.6 / GPT', buckets: [{ id: '3p-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset }] },
    ],
  }
  const { runtime, adapter } = makeRuntime({ accounts: [ultra, pro], omitArgonAccounts: [pro], usageByHome })

  // A Flash turn lands on the Pro account (priority 1). That is the state that
  // used to paint its untouched Gemini pool beside an Argon model.
  const step = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'MAC-QUOTA-FOCUS',
    messages: [sys, user('u1', 'write the weekly report')],
  }))
  assert.equal(finishOf(step).reason.kind, 'stop')
  assert.equal(runtime.status().lastAccount, 'pro')

  const argon = await runtime.quotaForModel('gemini-4-argon')
  assert.equal(argon.model, 'gemini-4-argon', 'the resolved model is echoed back')
  assert.equal(argon.accountId, 'ultra', 'Argon is read from the account that can spend it')
  assert.equal(argon.accountLabel, 'Ultra plan')
  assert.equal(argon.focus.entitled, true)
  assert.equal(argon.focus.family, 'argon')
  assert.equal(argon.focus.group.buckets[0].remainingFraction, 0.98, 'the Ultra window, never the Pro 100%')

  const flash = await runtime.quotaForModel('gemini-3.8-flash')
  assert.equal(flash.accountId, 'pro')
  assert.equal(flash.focus.entitled, true)
  assert.equal(flash.focus.group.buckets[0].remainingFraction, 1)

  // The old call shape — "whoever served last" — answers with the Pro pool,
  // which is exactly what used to leak into the Argon reading.
  const byLast = await runtime.quotaFor(undefined)
  assert.equal(byLast.groups[0].name, 'Gemini 3.8 Flash')
  assert.equal(runtime.status().lastAccount, 'pro')

  // A conversation already pinned to the Ultra account keeps that
  // subscription's numbers even when the pool would pick the Pro account next.
  const argonTurn = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'MAC-ARGON-BIND',
    messages: [sys, user('u2', 'solve the architecture bug')],
  }))
  assert.equal(finishOf(argonTurn).reason.kind, 'stop')
  const proTurn = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'MAC-FLASH-T',
    messages: [sys, user('u3', 'write the report')],
  }))
  assert.equal(finishOf(proTurn).reason.kind, 'stop')
  assert.equal(runtime.status().lastAccount, 'pro')

  const pooled = await runtime.quotaForModel('gemini-3.8-flash')
  assert.equal(pooled.accountId, 'pro', 'a fresh conversation follows the pool pick')
  assert.equal(pooled.focus.group.buckets[0].remainingFraction, 1)
  const bound = await runtime.quotaForModel('gemini-3.8-flash', false, 'MAC-ARGON-BIND')
  assert.equal(bound.accountId, 'ultra', 'a pinned conversation keeps its own subscription')
  assert.equal(bound.focus.group.buckets[0].remainingFraction, 0.77)
})

test('a Pro account without Argon reports no entitlement for it instead of a Gemini percentage', async () => {
  const pro = account('pro-only', { displayName: 'Pro plan', priority: 1 })
  const reset = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const usageByHome = {
    [pro.homeDir]: [
      { name: 'Gemini 3.8 Flash', buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset }] },
      { name: 'Claude 4.6 / GPT', buckets: [{ id: '3p-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset }] },
    ],
  }
  const { runtime, adapter } = makeRuntime({ accounts: [pro], omitArgonAccounts: [pro], usageByHome })

  const step = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'MAC-PRO-ONLY',
    messages: [sys, user('u1', 'hello')],
  }))
  assert.equal(finishOf(step).reason.kind, 'stop')
  assert.equal(runtime.status().lastAccount, 'pro-only')

  const argon = await runtime.quotaForModel('gemini-4-argon')
  assert.equal(argon.accountId, 'pro-only')
  assert.equal(argon.focus.entitled, false, 'no Argon windows on this plan')
  assert.equal(argon.focus.reason, 'model-not-entitled')
  assert.equal(argon.focus.group, undefined)
})
