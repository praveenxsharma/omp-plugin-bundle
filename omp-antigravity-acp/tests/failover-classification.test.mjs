// End-to-end tests of how `AntigravityRuntime.stream()` classifies a failure
// before parking an account: a hard quota window still parks the account for
// the reported reset, a transient 429 cools it briefly (or asks the harness
// retry layer to try upstream again), and the gatekeeper's degraded-pool abort
// never parks a healthy account at all.
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
 * CLI reports for an exhausted weekly window. Accounts listed in
 * `ratelimitAccounts` get `FAKE_AGY_FAIL=ratelimit`, so a prompt carrying the
 * fake's `RATELIMIT` directive answers with a transient 429. Other accounts
 * stay healthy.
 */
function makeRuntime({ accounts = [], quotaAccounts = [], ratelimitAccounts = [], omitArgonAccounts = [], usageByHome = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-failover-class-test-'))
  const armedHomes = new Set(quotaAccounts.map(entry => entry.homeDir))
  const throttledHomes = new Set(ratelimitAccounts.map(entry => entry.homeDir))
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
      if (env?.HOME !== undefined && throttledHomes.has(env.HOME)) childEnv.FAKE_AGY_FAIL = 'ratelimit'
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
    degradeRetryDelayMs: 15,
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
/** Open cooldown families of one account, sorted for stable comparisons. */
const cooldownsOf = (runtime, id) => runtime.status().accounts.find(row => row.id === id).cooldowns.map(row => row.family).sort()

const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }

/** Run one step and return the rejection it must raise. */
async function rejectionOf(iterable) {
  try {
    await collect(iterable)
  } catch (error) {
    return error
  }
  assert.fail('the step resolved instead of failing')
}

test('a transient rate limit on the only account is rethrown with the upstream delay and parks nothing', async () => {
  const a = account('a')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a], ratelimitAccounts: [a] })

  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'RFC1',
    messages: [sys, user('u1', 'RATELIMIT hi')],
  }))

  assert.equal(error.code, 'RATE_LIMIT', 'the failure keeps the rate-limit code')
  assert.match(error.message, /429 Too Many Requests/, 'the upstream wording reaches the caller')
  assert.doesNotMatch(error.message, /No Antigravity account/, 'a transient 429 is not a pool exhaustion')
  assert.equal(error.failure.providerRetryAfterMs, 2000, 'the stated `retry in 2s` becomes the harness retry delay')
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'a transient 429 must not park the account')
  assert.equal(prompts(a).length, 1, 'the account saw the step exactly once; the harness retry layer drives the retry')
})

test('a transient rate limit fails the same step over to a healthy account with a short cooldown', async () => {
  const a = account('a')
  const b = account('b')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a, b], ratelimitAccounts: [a] })

  const step = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'RFC2',
    messages: [sys, user('u1', 'RATELIMIT write the weekly report')],
  }))

  assert.equal(finishOf(step).reason.kind, 'stop', 'the healthy account carries the step')
  assert.match(textOf(step), /echo:gemini-3\.8-flash:high:RATELIMIT write the weekly report/)
  assert.equal(runtime.status().lastAccount, 'b')

  const parked = runtime.status().accounts.find(row => row.id === 'a').cooldowns
  assert.equal(parked.length, 1, 'the throttled account is cooled down, not exempt')
  const remaining = Date.parse(parked[0].until) - Date.now()
  assert.ok(remaining > 0, `the cooldown is still open (${remaining}ms)`)
  assert.ok(remaining <= 60_000, `a transient cooldown stays under a minute (${remaining}ms)`)
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])

  assert.equal(prompts(a).length, 1)
  assert.equal(prompts(b).length, 1)
})

test('a degraded route fails the step without cooling the account down or failing it over', async () => {
  const a = account('a')
  const b = account('b')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a, b] })

  const degradedText = {
    text: '我明白您的意思了，我将先检查代码中处理额度显示逻辑的相关部分。',
    gen: { cwmEstTokens: 32_736, inputTokens: 3_437, cachedReadTokens: 18_432, outputTokens: 276, thoughtTokens: 0, textOutTokens: 276, ttftSeconds: 2.06, streamSeconds: 1.16 },
  }
  const degradedTool = {
    tool: 'bash',
    args: { command: 'rm -rf /tmp/wrong' },
    gen: { cwmEstTokens: 320_000, inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 45, thoughtTokens: 0, textOutTokens: 45, ttftSeconds: 1.8, streamSeconds: 0.2 },
  }

  // A degraded text answer asks the harness retry layer for the same request
  // again (`DEGRADED_ROUTE`); it is not upstream quota, so nothing is parked.
  const textError = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'RFC3',
    tools: [bash],
    messages: [sys, user('u1', `GATEDCALL ${JSON.stringify(degradedText)}`)],
  }))
  assert.equal(textError.code, 'DEGRADED_ROUTE', 'the degraded answer reports the re-answer code')
  assert.match(textError.message, /auto re-answer/, 'the caller is told this was an automatic re-answer')
  assert.doesNotMatch(textError.message, /No Antigravity account/)
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'the account serving the degraded route stays usable')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [], 'no healthy account is cooled down either')
  assert.equal(runtime.status().lastAccount, 'a', 'the step never moves to another account')
  assert.equal(prompts(a).length, 1, 'the account saw the degraded attempt exactly once')
  assert.equal(prompts(b).length, 0, 'the other account was never asked')
  const afterText = prompts(a).length

  // A degraded tool gate that survives both automatic re-answers aborts with
  // its own code, which the retry layer does not treat as a quota failure.
  const toolPrompt = `GATEDCALL ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)}`
  const request = () => adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'RFC3b',
    tools: [bash],
    messages: [sys, user('u1', toolPrompt)],
  })
  const first = await rejectionOf(request())
  assert.equal(first.code, 'DEGRADED_ROUTE', 'the first gate degrade asks for a re-answer')
  const second = await rejectionOf(request())
  assert.equal(second.code, 'DEGRADED_ROUTE', 'the second gate degrade asks for one more re-answer')
  const third = await rejectionOf(request())
  assert.equal(third.code, 'DEGRADED_ROUTE_EXHAUSTED', 'the exhausted re-answer keeps its own documented code')
  assert.match(third.message, /degraded route/, 'the caller sees the real cause, not a quota story')
  assert.doesNotMatch(third.message, /No Antigravity account/)
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'the abort parks nothing on the first account')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [], 'the abort parks nothing on the second account')
  // A new conversation may be balanced onto either account; all three of its
  // attempts must still run on the one account it was given.
  const servedA = prompts(a).length - afterText
  const servedB = prompts(b).length
  assert.ok(
    (servedA === 3 && servedB === 0) || (servedA === 0 && servedB === 3),
    `each attempt ran one session/prompt on the conversation's own account (a: ${servedA}, b: ${servedB})`,
  )
  assert.equal(runtime.status().lastAccount, servedA === 3 ? 'a' : 'b', 'the abort never fails over to another account')
})
