// Contract tests for the merged per-step usage path.
//
// One read of `gen_metadata` now both reports a step's TokenUsage and feeds the
// shadow-degradation fingerprint, so one generation is never billed twice; the
// `steps` table is read only for the tail `agy` never billed (once per turn, with a
// `usage-gap` warning) and for an old `agy` whose session DB has no `gen_metadata`
// at all. These tests pin the four cases at the `runtime.stream()` boundary: a
// multi-step turn billed once and equal to the steps totals, a trailing all-zero
// generation row that adds no call, a missing last generation row back-filled once,
// and the legacy steps-only fallback unchanged.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'
import { hasGenMetadata, readGenUsageAfter, readModelStepsAfter, sessionDbPath } from '../lib/usage-db.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)
const runtimes = []

/**
 * Runtime over the scripted fake agent. `plan` is handed to the fake through
 * `FAKE_AGY_PLAN`: the n-th `session/prompt` of the child process answers with the
 * n-th entry, and an entry's `gen` makes the fake write that generation's
 * `gen_metadata` row. Warnings are collected so a test can assert the turn-end
 * `usage-gap` report.
 */
function makeRuntime({ plan } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-usage-merge-'))
  const log = join(home, 'prompts.jsonl')
  const warnings = []
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
    accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: { ...process.env, FAKE_AGY_LOG: log, ...(plan === undefined ? {} : { FAKE_AGY_PLAN: JSON.stringify(plan) }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
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
    runCommand: async (argv) => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: (message) => { warnings.push(message) } },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  const prompts = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    home,
    runtime,
    prompts,
    warnings,
    /** Every `usage-gap` report the runtime logged. */
    gaps: () => warnings.filter(w => w.startsWith('antigravity-acp: usage-gap')),
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
  }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })
const tool = (id, callId, text) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } })
const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const finishOf = chunks => chunks.at(-1)
const usageOf = chunks => chunks.find(c => c.type === 'usage')?.usage
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
const assistantFrom = (id, chunks) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block))
const argonStep = (sessionId, messages) => ({
  provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', sessionId, tools: [bash], messages,
})

// Healthy generations under High effort: neither may trip the degradation
// fingerprint, or the answer would be refused and re-asked instead of billed.
const GEN_TOOL = { cwmEstTokens: 32_500, inputTokens: 4_110, cachedReadTokens: 21_453, outputTokens: 180, thoughtTokens: 920, textOutTokens: 40, ttftSeconds: 11.2, streamSeconds: 1.1 }
const GEN_TEXT = { cwmEstTokens: 385_000, inputTokens: 4_999, cachedReadTokens: 380_062, outputTokens: 420, thoughtTokens: 1_102, textOutTokens: 318, ttftSeconds: 13.4, streamSeconds: 6.2 }
const GEN_ANSWER = { cwmEstTokens: 386_200, inputTokens: 5_101, cachedReadTokens: 381_004, outputTokens: 268, thoughtTokens: 804, textOutTokens: 210, ttftSeconds: 12.1, streamSeconds: 4.4 }

// What DSH must see for one generation, from the same five counters.
const USAGE_TOOL = { inputTokens: 4_110, outputTokens: 180, cacheReadTokens: 21_453, reasoningTokens: 180, totalTokens: 25_743 }
const USAGE_TEXT = { inputTokens: 4_999, outputTokens: 420, cacheReadTokens: 380_062, reasoningTokens: 420, totalTokens: 385_481 }
const USAGE_ANSWER = { inputTokens: 5_101, outputTokens: 268, cacheReadTokens: 381_004, reasoningTokens: 268, totalTokens: 386_373 }

function encodeVarint(value) {
  let n = BigInt.asUintN(64, BigInt(value))
  const out = []
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80)
    n >>= 7n
  }
  out.push(Number(n))
  return out
}

function encodeLengthDelimited(field, bytes) {
  return [...encodeVarint((BigInt(field) << 3n) | 2n), ...encodeVarint(bytes.length), ...bytes]
}

/** One `steps.metadata` blob carrying field `9` = the five billed counters. */
function encodeModelStepMetadata(stats) {
  const sub = [
    ...encodeVarint((1n << 3n) | 0n), ...encodeVarint(stats.modelEnum ?? 1417),
    ...encodeVarint((2n << 3n) | 0n), ...encodeVarint(stats.inputTokens ?? 0),
    ...encodeVarint((3n << 3n) | 0n), ...encodeVarint(stats.outputTokens ?? 0),
    ...encodeVarint((4n << 3n) | 0n), ...encodeVarint(stats.cachedWriteTokens ?? 0),
    ...encodeVarint((5n << 3n) | 0n), ...encodeVarint(stats.cachedReadTokens ?? 0),
    ...encodeVarint((9n << 3n) | 0n), ...encodeVarint(stats.thoughtTokens ?? 0),
    ...encodeVarint((10n << 3n) | 0n), ...encodeVarint(stats.textOutTokens ?? 0),
  ]
  return new Uint8Array(encodeLengthDelimited(9, sub))
}

/** One `gen_metadata.data` blob with `f1.4` = the five billed counters. */
function encodeGenMetadata(stats) {
  const usage = [
    ...encodeVarint((1n << 3n) | 0n), ...encodeVarint(stats.modelEnum ?? 1417),
    ...encodeVarint((2n << 3n) | 0n), ...encodeVarint(stats.inputTokens ?? 0),
    ...encodeVarint((3n << 3n) | 0n), ...encodeVarint(stats.outputTokens ?? 0),
    ...encodeVarint((4n << 3n) | 0n), ...encodeVarint(stats.cachedWriteTokens ?? 0),
    ...encodeVarint((5n << 3n) | 0n), ...encodeVarint(stats.cachedReadTokens ?? 0),
    ...encodeVarint((9n << 3n) | 0n), ...encodeVarint(stats.thoughtTokens ?? 0),
    ...encodeVarint((10n << 3n) | 0n), ...encodeVarint(stats.textOutTokens ?? 0),
  ]
  const chat = [...encodeVarint((3n << 3n) | 0n), ...encodeVarint(stats.modelEnum ?? 1417), ...encodeLengthDelimited(4, usage)]
  return new Uint8Array(encodeLengthDelimited(1, chat))
}

const requireSqlite = createRequire(import.meta.url)
const { DatabaseSync } = requireSqlite('node:sqlite')

/** Write one completed model step the way `agy` writes it. */
function writeModelStep(dbPath, idx, stats) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)')
    db.prepare('INSERT OR REPLACE INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)').run(idx, encodeModelStepMetadata(stats))
  } finally {
    db.close()
  }
}

/** Write one `gen_metadata` row, used here for the trailing all-zero generation. */
function writeGenRow(dbPath, idx, stats) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const blob = encodeGenMetadata(stats)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0)')
    db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(idx, blob, blob.length)
  } finally {
    db.close()
  }
}

test('merged gen_metadata usage bills every step once and equals the steps totals', async () => {
  const { home, adapter, prompts, gaps, warnings } = makeRuntime({
    plan: [{
      gen: GEN_TOOL, thought: 'Inspecting the workspace.', tool: { name: 'bash', args: { command: 'pwd' } }, text: '',
      afterTool: { gen: GEN_TEXT, thought: 'Reading the listing.', text: 'The workspace holds two files.' },
    }],
  })
  const dbPath = () => sessionDbPath(home, prompts()[0].session)

  // Step 1 ends with the tool call, the way agy bills it: one generation row, one step row.
  const step1 = []
  for await (const chunk of adapter.stream(argonStep('M1', [sys, user('u1', 'list the workspace')]))) {
    step1.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') writeModelStep(dbPath(), 0, GEN_TOOL)
  }
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const u1 = usageOf(step1)
  assert.deepEqual(u1, USAGE_TOOL, 'the tool step reports its generation exactly once')

  const [call] = callsOf(step1)
  const history = [sys, user('u1', 'list the workspace'), assistantFrom('a1', step1), tool('t1', call.id, 'two files')]
  const step2 = []
  for await (const chunk of adapter.stream(argonStep('M1', history))) {
    step2.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') writeModelStep(dbPath(), 1, GEN_TEXT)
  }
  assert.equal(finishOf(step2).reason.kind, 'stop')
  const u2 = usageOf(step2)
  assert.deepEqual(u2, USAGE_TEXT, 'the answering step reports its generation exactly once')

  // The two must equal the steps table, never the sum of both tables.
  const steps = readModelStepsAfter(dbPath(), -1)
  assert.equal(steps?.calls, 2)
  assert.equal(u1.totalTokens + u2.totalTokens, steps.usage.totalTokens)
  assert.equal(
    u1.inputTokens + u2.inputTokens,
    steps.usage.inputTokens,
    'a generation billed by both tables would double the uncached input',
  )

  // Every generation was billed, so nothing is back-filled and nothing is logged.
  assert.equal(readGenUsageAfter(dbPath(), -1)?.calls, 2)
  assert.deepEqual(gaps(), [])
  assert.deepEqual(warnings, [])
})

test('a trailing all-zero gen_metadata row reports no extra call', async () => {
  const { home, adapter, prompts, gaps } = makeRuntime({
    plan: [{
      gen: GEN_TOOL, thought: 'Inspecting the workspace.', tool: { name: 'bash', args: { command: 'ls' } }, text: '',
      afterTool: { gen: GEN_TEXT, thought: 'Reading the listing.', text: 'Two files listed.' },
    }],
  })
  const dbPath = () => sessionDbPath(home, prompts()[0].session)
  // Deliberately different from the generations: once a session DB carries
  // `gen_metadata`, the merged path must report the generation, never the step row.
  const stepRow0 = { inputTokens: 7, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 7, thoughtTokens: 0 }
  const stepRow1 = { inputTokens: 9, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 9, thoughtTokens: 0 }

  const step1 = []
  for await (const chunk of adapter.stream(argonStep('M2', [sys, user('u1', 'list the workspace')]))) {
    step1.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') writeModelStep(dbPath(), 0, stepRow0)
  }
  assert.deepEqual(usageOf(step1), USAGE_TOOL, 'the tool step is billed from its generation')

  const [call] = callsOf(step1)
  const history = [sys, user('u1', 'list the workspace'), assistantFrom('a1', step1), tool('t1', call.id, 'two files')]
  const step2 = []
  for await (const chunk of adapter.stream(argonStep('M2', history))) {
    step2.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      writeModelStep(dbPath(), 1, stepRow1)
      // agy also commits a row for a request upstream refused: no step, no tokens.
      writeGenRow(dbPath(), 9, { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 })
    }
  }
  assert.equal(finishOf(step2).reason.kind, 'stop')

  const gen = readGenUsageAfter(dbPath(), -1)
  assert.equal(gen?.rows, 3, 'the zero row is read')
  assert.equal(gen?.calls, 2, 'but it counts as no generation')

  // A zero row counted as a call would halve the prompt buckets of the answer.
  assert.deepEqual(usageOf(step2), USAGE_TEXT, 'the answering step is billed from its generation')
  assert.deepEqual(gaps(), [], 'the carried-over zero row is not a missing step')
})

test('a step gen_metadata never billed is back-filled once at turn end with a usage-gap warning', async () => {
  const { home, adapter, prompts, gaps } = makeRuntime({
    plan: [
      {
        gen: GEN_TOOL, thought: 'Inspecting the workspace.', tool: { name: 'bash', args: { command: 'pwd' } }, text: '',
        afterTool: { thought: 'Reading the listing.', text: 'The workspace holds two files.' },
      },
      { gen: GEN_ANSWER, thought: 'Renaming the file.', text: 'Renamed.' },
    ],
  })
  const dbPath = () => sessionDbPath(home, prompts()[0].session)

  const step1 = []
  for await (const chunk of adapter.stream(argonStep('M3', [sys, user('u1', 'list the workspace')]))) {
    step1.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') writeModelStep(dbPath(), 0, GEN_TOOL)
  }
  assert.deepEqual(usageOf(step1), USAGE_TOOL)

  // The answering generation is completed but never billed in gen_metadata.
  const [call] = callsOf(step1)
  const history = [sys, user('u1', 'list the workspace'), assistantFrom('a1', step1), tool('t1', call.id, 'two files')]
  const step2 = []
  for await (const chunk of adapter.stream(argonStep('M3', history))) {
    step2.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') writeModelStep(dbPath(), 1, GEN_TEXT)
  }
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.deepEqual(usageOf(step2), USAGE_TEXT, 'the missing generation is back-filled from its completed step')

  const reports = gaps()
  assert.equal(reports.length, 1, 'one turn reports its gap exactly once')
  assert.match(reports[0], new RegExp(`${prompts()[0].session}\\.db`), 'the report names the session DB')
  assert.match(reports[0], new RegExp(`${USAGE_TEXT.totalTokens} tokens`), 'the report states the back-filled token delta')

  // The next turn bills its own generation and must not repeat the report.
  const followUp = [...history, assistantFrom('a2', step2), user('u2', 'rename it')]
  const next = []
  for await (const chunk of adapter.stream(argonStep('M3', followUp))) {
    next.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') writeModelStep(dbPath(), 2, GEN_ANSWER)
  }
  assert.equal(finishOf(next).reason.kind, 'stop')
  assert.deepEqual(usageOf(next), USAGE_ANSWER, 'the next turn is billed its own generation, never the back-filled one again')
  assert.equal(gaps().length, 1, 'the same gap is never reported twice')
})

test('a session DB without gen_metadata keeps reading steps as before', async () => {
  const { home, adapter, prompts, gaps } = makeRuntime({
    plan: [{
      thought: 'Inspecting the workspace.', tool: { name: 'bash', args: { command: 'pwd' } }, text: '',
      afterTool: { thought: 'Reading the listing.', text: 'The workspace holds two files.' },
    }],
  })
  const dbPath = () => sessionDbPath(home, prompts()[0].session)
  const first = { inputTokens: 420, cachedReadTokens: 150, cachedWriteTokens: 0, outputTokens: 18, thoughtTokens: 6 }
  const second = { inputTokens: 2_100, cachedReadTokens: 13_200, cachedWriteTokens: 0, outputTokens: 220, thoughtTokens: 80 }

  const step1 = []
  for await (const chunk of adapter.stream(argonStep('M4', [sys, user('u1', 'list the workspace')]))) {
    step1.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') writeModelStep(dbPath(), 0, first)
  }
  assert.deepEqual(usageOf(step1), { inputTokens: 420, outputTokens: 18, cacheReadTokens: 150, reasoningTokens: 6, totalTokens: 588 })

  const [call] = callsOf(step1)
  const history = [sys, user('u1', 'list the workspace'), assistantFrom('a1', step1), tool('t1', call.id, 'two files')]
  const step2 = []
  for await (const chunk of adapter.stream(argonStep('M4', history))) {
    step2.push(chunk)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') writeModelStep(dbPath(), 1, second)
  }
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.deepEqual(usageOf(step2), { inputTokens: 2_100, outputTokens: 220, cacheReadTokens: 13_200, reasoningTokens: 80, totalTokens: 15_520 })

  // An old agy writes no gen_metadata at all: the fallback never invents a gap.
  assert.equal(existsSync(dbPath()), true)
  assert.equal(hasGenMetadata(dbPath()), false)
  assert.deepEqual(gaps(), [])
})
