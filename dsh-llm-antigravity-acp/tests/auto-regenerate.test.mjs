// Contract tests for automatic re-answering of a degraded Argon generation.
//
// A degraded attempt must not be re-rolled inside the plugin any more: the step
// fails with the `DEGRADED_ROUTE` code so DSH's own request-retry layer calls
// `runtime.stream()` again about a second later with the exact same request
// (same message ids). The plugin recognizes that repeat, keeps the ACP session
// open, and asks for a new answer inside it. These tests pin the whole contract
// at the `runtime.stream()` boundary: the failure code and its retry hint, the
// answer that must not leak, the `[HARNESS_NOTICE]` continuation prompt, the
// cold `session/new` case, the per-request retry budget, and the untouched
// non-Argon / non-main-purpose behavior.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)
const runtimes = []

/**
 * Runtime over the scripted fake agent. `plan` is handed to the fake through
 * `FAKE_AGY_PLAN`: the n-th `session/prompt` of the child process answers with
 * the n-th entry, so a test scripts the exact attempt sequence of one request
 * across sessions and retries.
 */
function makeRuntime({ config: configExtra = {}, host = {}, plan, env: envExtra = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-regen-test-'))
  const log = join(home, 'prompts.jsonl')
  const lifecycleFile = join(home, 'lifecycle.jsonl')
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    // The machine account is an ordinary list entry that reuses this Mac's login.
    accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000, ...configExtra,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: {
          ...process.env,
          FAKE_AGY_LOG: log,
          FAKE_AGY_LIFECYCLE: lifecycleFile,
          ...(plan === undefined ? {} : { FAKE_AGY_PLAN: JSON.stringify(plan) }),
          ...envExtra,
        },
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
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
    ...host,
  })
  runtimes.push(runtime)
  const readJsonl = file => existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    home,
    runtime,
    prompts: () => readJsonl(log),
    /** ACP session/new, session/load, and session/close in arrival order. */
    lifecycle: () => readJsonl(lifecycleFile),
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
  }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })
const tool = (id, callId, text) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } })
const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
const readFile = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
/** Collect one step until it fails; the chunks streamed before the failure stay inspectable. */
async function failedStep(iterable) {
  const chunks = []
  try {
    for await (const chunk of iterable) chunks.push(chunk)
  } catch (error) {
    return { chunks, error }
  }
  return { chunks, error: undefined }
}
const finishOf = chunks => chunks.at(-1)
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const reasoningOf = chunks => chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
const assistantFrom = (id, chunks) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** The reroll continuation the plugin sends inside a warm ACP session. */
const NOTICE = '[HARNESS_NOTICE]'
const HISTORY = /<dsh_history>/

// gen_metadata fixtures: a 0-thought fallback answer under high effort (+7:
// shallow thought, block cache, fast decode), a truncated 128K thinking answer
// (+7: context truncation, block cache), a fallback tool step (+3), and two
// healthy answers the fingerprint must never flag.
const DEGRADED_NO_THOUGHT = { cwmEstTokens: 32_736, inputTokens: 3_437, cachedReadTokens: 18_432, outputTokens: 276, thoughtTokens: 0, textOutTokens: 276, ttftSeconds: 2.06, streamSeconds: 1.16 }
const DEGRADED_WITH_THOUGHT = { cwmEstTokens: 378_421, inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 90, thoughtTokens: 1_120, textOutTokens: 75, ttftSeconds: 3.1, streamSeconds: 0.4 }
const DEGRADED_TOOL = { cwmEstTokens: 32_000, inputTokens: 21_451, cachedReadTokens: 0, outputTokens: 73, thoughtTokens: 0, textOutTokens: 73, ttftSeconds: 3.78, streamSeconds: 0.06 }
const HEALTHY_TEXT = { cwmEstTokens: 385_000, inputTokens: 4_999, cachedReadTokens: 380_062, outputTokens: 420, thoughtTokens: 1_102, textOutTokens: 318, ttftSeconds: 13.4, streamSeconds: 6.2 }
const HEALTHY_TOOL = { cwmEstTokens: 32_500, inputTokens: 4_110, cachedReadTokens: 21_453, outputTokens: 180, thoughtTokens: 920, textOutTokens: 40, ttftSeconds: 11.2, streamSeconds: 1.1 }

const argonStep = (messages, extra = {}) => ({
  provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', messages, ...extra,
})

test('C1 a degraded end_turn fails the step with DEGRADED_ROUTE, holds the answer, and keeps the session open', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: '我明白您的意思了，我将先检查代码中处理额度显示逻辑的相关部分。' },
      { gen: HEALTHY_TEXT, thought: 'Re-read the request and the workspace.', text: 'Quota fix complete.' },
    ],
  })
  const messages = [sys, user('u1', 'fix the quota display')]
  const { chunks, error } = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'C1', tools: [bash] })))

  assert.ok(error !== undefined, 'the degraded attempt must fail the step instead of being re-rolled in place')
  assert.equal(error.code, 'DEGRADED_ROUTE', 'the failure asks the harness retry layer for another request, not a quota story')
  assert.equal(error.failure?.providerRetryAfterMs, 1000, 'the request is retried about a second later')
  assert.ok(error.message.startsWith('[auto re-answer]'), `the message announces the automatic re-answer: ${error.message}`)
  assert.equal(textOf(chunks), '', 'the held answer of the degraded attempt never reaches the transcript')

  await wait(250)
  assert.equal(lifecycle().filter(e => e.op === 'close').length, 0, 'the ACP session must stay open for the re-answer')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'no replacement ACP session is opened')
  assert.equal(prompts().length, 1, 'the plugin must not send its own continuation prompt')
})

test('C1b a degraded end_turn that already streamed reasoning still fails with DEGRADED_ROUTE', { timeout: 60_000 }, async () => {
  const { adapter } = makeRuntime({
    plan: [
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking the quota handler.', text: 'The quota handler is in accounts.ts.' },
    ],
  })
  const { chunks, error } = await failedStep(adapter.stream(argonStep([sys, user('u1', 'where is the quota handler')], { sessionId: 'C1b' })))

  assert.ok(error !== undefined, 'a degraded answer with thinking must fail the step too')
  assert.equal(error.code, 'DEGRADED_ROUTE')
  assert.equal(error.failure?.providerRetryAfterMs, 1000)
  assert.ok(error.message.startsWith('[auto re-answer]'), `the message announces the automatic re-answer: ${error.message}`)
  assert.match(reasoningOf(chunks), /Checking the quota handler\./, 'reasoning streamed before the verdict may stay')
})

test('C2 the retry of the same request re-answers inside the warm ACP session with a HARNESS_NOTICE prompt', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: '我明白您的意思了，我将先检查代码中处理额度显示逻辑的相关部分。' },
      { gen: HEALTHY_TEXT, thought: 'Verified the quota fix end to end.', text: 'Full-intelligence Ultra quota fix complete.' },
    ],
  })
  const messages = [sys, user('u1', 'fix the quota display')]
  const first = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'C2', tools: [bash] })))
  assert.ok(first.error !== undefined, 'the first attempt fails so the harness retries it')
  assert.equal(first.error.code, 'DEGRADED_ROUTE')

  const second = await collect(adapter.stream(argonStep(messages, { sessionId: 'C2', tools: [bash] })))
  assert.equal(finishOf(second).reason.kind, 'stop', 'the re-answer streams as a normal answer')
  assert.equal(textOf(second), 'Full-intelligence Ultra quota fix complete.')

  const turns = prompts()
  assert.equal(turns.length, 2, 'exactly one continuation prompt answers the retry')
  assert.equal(turns[1].session, turns[0].session, 'the re-answer runs in the same ACP session')
  assert.ok(turns[1].text.includes(NOTICE), `the continuation prompt carries the reroll notice: ${turns[1].text}`)
  assert.doesNotMatch(turns[1].text, HISTORY, 'a warm session is never replayed as history')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'the warm retry opens no session/new')
})

test('C3 a cold ACP session that degrades on its first turn is replaced and re-sent the original input', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      { gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'rm -rf /tmp/wrong' } }, text: '' },
      { gen: HEALTHY_TEXT, thought: 'Listing the workspace from the top.', text: 'Workspace listed.' },
    ],
  })
  const messages = [sys, user('u1', 'list the workspace')]
  const first = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'C3', tools: [bash] })))
  assert.ok(first.error !== undefined, 'a cold first-turn degrade fails the step instead of re-rolling in place')
  assert.equal(first.error.code, 'DEGRADED_ROUTE')
  assert.deepEqual(callsOf(first.chunks), [], 'the degraded tool call never reaches the harness')

  const second = await collect(adapter.stream(argonStep(messages, { sessionId: 'C3', tools: [bash] })))
  assert.equal(finishOf(second).reason.kind, 'stop')

  const turns = prompts()
  assert.equal(turns.length, 2)
  assert.notEqual(turns[1].session, turns[0].session, 'a session that never finished a round cannot be continued')
  assert.ok(turns[1].text.includes('list the workspace'), `the retry re-sends the original user input: ${turns[1].text}`)
  assert.ok(!turns[1].text.includes(NOTICE), 'the cold retry sends the original input, not a reroll notice')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 2, 'the cold retry opens one fresh session/new')
  assert.notEqual(turns[1].system, turns[0].system, 'the replayed system text must break the upstream prefix cache')
  assert.ok(turns[1].system.includes('[reanswer:'), `the replayed system carries the reanswer tag: ${turns[1].system}`)
})

test('C4 a degraded tool gate drops the tool call and re-answers in the warm session', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      { gen: HEALTHY_TEXT, thought: 'Ready to help.', text: 'Ready to help.' },
      { gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'rm -rf /tmp/wrong' } }, text: '' },
      { gen: HEALTHY_TEXT, thought: 'Re-reading the request before acting.', text: 'The workspace holds two files.' },
    ],
  })
  const first = await collect(adapter.stream(argonStep([sys, user('u1', 'say hello')], { sessionId: 'C4', tools: [bash] })))
  assert.equal(finishOf(first).reason.kind, 'stop', 'the warm-up round completes')

  const messages = [sys, user('u1', 'say hello'), assistantFrom('a1', first), user('u2', 'clean the workspace')]
  const gated = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'C4', tools: [bash] })))
  assert.ok(gated.error !== undefined, 'a gatekeeper degrade fails the step instead of retrying in place')
  assert.equal(gated.error.code, 'DEGRADED_ROUTE', 'the tool gate reports the same re-answer code')
  assert.deepEqual(callsOf(gated.chunks), [], 'the harness never sees the degraded tool call')

  const second = await collect(adapter.stream(argonStep(messages, { sessionId: 'C4', tools: [bash] })))
  assert.equal(finishOf(second).reason.kind, 'stop')
  assert.equal(textOf(second), 'The workspace holds two files.')

  const turns = prompts()
  assert.equal(turns.length, 3, 'the retry sends exactly one continuation prompt')
  assert.equal(turns[2].session, turns[1].session, 'the re-answer stays in the warm ACP session')
  assert.ok(turns[2].text.includes(NOTICE), `the continuation prompt carries the reroll notice: ${turns[2].text}`)
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'the warm retry opens no session/new')
})

test('C4b a degraded gate after a completed tool step re-answers without replaying history', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      {
        gen: HEALTHY_TOOL, thought: 'Inspecting the workspace.', tool: { name: 'bash', args: { command: 'ls' } }, text: '',
        afterTool: { gen: DEGRADED_TOOL, tool: { name: 'read_file', args: { path: '/etc/hosts' } }, text: '' },
      },
      { gen: HEALTHY_TEXT, thought: 'Re-reading the tool result before answering.', text: 'The file lists two hosts.' },
    ],
  })
  const messages = [sys, user('u1', 'inspect the workspace')]
  const step1 = await collect(adapter.stream(argonStep(messages, { sessionId: 'C4b', tools: [bash, readFile] })))
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  const withResult = [...messages, assistantFrom('a1', step1), tool('t1', call.id, 'hosts')]

  const gated = await failedStep(adapter.stream(argonStep(withResult, { sessionId: 'C4b', tools: [bash, readFile] })))
  assert.ok(gated.error !== undefined, 'the gate after a tool step fails the step')
  assert.equal(gated.error.code, 'DEGRADED_ROUTE')
  assert.deepEqual(callsOf(gated.chunks), [], 'the degraded tool call never reaches the harness')

  const second = await collect(adapter.stream(argonStep(withResult, { sessionId: 'C4b', tools: [bash, readFile] })))
  assert.equal(finishOf(second).reason.kind, 'stop')
  assert.equal(textOf(second), 'The file lists two hosts.')

  const turns = prompts()
  assert.equal(turns.length, 2, 'the tool result resumed the turn in place; the retry sends one prompt')
  assert.equal(turns[1].session, turns[0].session, 'the tool-result retry stays in the same ACP session')
  assert.ok(turns[1].text.includes(NOTICE), `the retry sends the continuation notice: ${turns[1].text}`)
  assert.doesNotMatch(turns[1].text, HISTORY, 'the tool results are not replayed as history')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'the tool-result retry opens no session/new')
})

test('C5 after two automatic re-answers a degraded text answer is delivered and the session is marked degraded', { timeout: 90_000 }, async () => {
  const { adapter, prompts, runtime } = makeRuntime({
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: '第一次降智回答。' },
      { gen: DEGRADED_NO_THOUGHT, text: '第二次降智回答。' },
      { gen: DEGRADED_NO_THOUGHT, text: '第三次降智仍然要交出的回答。' },
    ],
  })
  const messages = [sys, user('u1', 'fix the quota display')]
  const attempt = () => adapter.stream(argonStep(messages, { sessionId: 'C5', tools: [bash] }))

  const first = await failedStep(attempt())
  assert.ok(first.error !== undefined, 'the first degraded attempt fails the step')
  assert.equal(first.error.code, 'DEGRADED_ROUTE')
  const second = await failedStep(attempt())
  assert.ok(second.error !== undefined, 'the second degraded attempt fails the step too')
  assert.equal(second.error.code, 'DEGRADED_ROUTE')

  const third = await collect(attempt())
  assert.equal(finishOf(third).reason.kind, 'stop', 'the third attempt is delivered instead of retried again')
  assert.equal(textOf(third), '第三次降智仍然要交出的回答。', 'the exhausted re-answer reaches the transcript')
  assert.equal(prompts().length, 3, 'one prompt per attempt is all the plugin sends')
  assert.equal(runtime.sessionHealthFor('C5')?.degraded, true, 'the session reports its degraded health')
})

test('C5 a degraded tool gate that survives two re-answers fails with DEGRADED_ROUTE_EXHAUSTED', { timeout: 90_000 }, async () => {
  const { adapter, prompts } = makeRuntime({
    plan: [
      { gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'rm -rf /tmp/wrong' } }, text: '' },
      { gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'rm -rf /tmp/wrong' } }, text: '' },
      { gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'rm -rf /tmp/wrong' } }, text: '' },
    ],
  })
  const messages = [sys, user('u1', 'clean the workspace')]
  const attempt = () => adapter.stream(argonStep(messages, { sessionId: 'C5t', tools: [bash] }))

  const first = await failedStep(attempt())
  assert.equal(first.error?.code, 'DEGRADED_ROUTE', 'the first gate degrade asks for a re-answer')
  const second = await failedStep(attempt())
  assert.equal(second.error?.code, 'DEGRADED_ROUTE', 'the second gate degrade asks for one more re-answer')

  const third = await failedStep(attempt())
  assert.ok(third.error !== undefined, 'the exhausted gate fails the step')
  assert.equal(third.error.code, 'DEGRADED_ROUTE_EXHAUSTED', 'an unverified tool call is never handed to the harness')
  assert.ok(third.error.message.startsWith('[degraded route]'), `the message states the abort: ${third.error.message}`)
  assert.deepEqual(callsOf(third.chunks), [], 'no tool call reached the harness')
  assert.equal(prompts().length, 3, 'the plugin stops asking after two re-answers')
})

test('C6 a new user message after a failed attempt is sent incrementally instead of as a re-answer', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle } = makeRuntime({
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: '我明白您的意思了，我将先检查代码中处理额度显示逻辑的相关部分。' },
      { gen: HEALTHY_TEXT, thought: 'Renaming the field.', text: 'Field renamed.' },
    ],
  })
  const first = await failedStep(adapter.stream(argonStep([sys, user('u1', 'fix the quota display')], { sessionId: 'C6', tools: [bash] })))
  assert.equal(first.error?.code, 'DEGRADED_ROUTE')

  const second = await collect(adapter.stream(argonStep([
    sys, user('u1', 'fix the quota display'), user('u2', 'also rename the field'),
  ], { sessionId: 'C6', tools: [bash] })))
  assert.equal(finishOf(second).reason.kind, 'stop', 'the new message streams a normal answer')
  assert.equal(textOf(second), 'Field renamed.')

  const turns = prompts()
  assert.equal(turns.length, 2)
  assert.equal(turns[1].session, turns[0].session, 'a new user message keeps the ACP session')
  assert.ok(turns[1].text.includes('also rename the field'), 'the new user message is what gets sent')
  assert.ok(!turns[1].text.includes(NOTICE), 'a new user message is not a re-answer')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'no session/new for a plain follow-up')
})

test('C7 the adapter retries DEGRADED_ROUTE with the normal budget and keeps the default codes', { timeout: 30_000 }, async () => {
  const { adapter } = makeRuntime()
  const policy = adapter.providerRetryPolicy('antigravity')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 4)
  for (const code of ['DEGRADED_ROUTE', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), `retryableCodes must include ${code}`)
  }
})

test('C9 non-Argon models and non-main purposes keep their answer instead of re-answering', { timeout: 60_000 }, async () => {
  const { adapter, prompts } = makeRuntime({
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: 'Flash answer kept as is.' },
      { gen: DEGRADED_NO_THOUGHT, text: 'Subagent answer kept as is.' },
    ],
  })
  const flash = await collect(adapter.stream({
    provider: 'antigravity', model: 'gemini-3.8-flash', reasoningEffort: 'high', sessionId: 'C9a', tools: [bash],
    messages: [sys, user('u1', 'summarize the diff')],
  }))
  assert.equal(finishOf(flash).reason.kind, 'stop')
  assert.equal(textOf(flash), 'Flash answer kept as is.', 'a non-Argon answer is never held back')

  const auxiliary = await collect(adapter.stream({
    provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', sessionId: 'C9b', tools: [bash], purpose: 'subagent',
    messages: [sys, user('u2', 'summarize the diff')],
  }))
  assert.equal(finishOf(auxiliary).reason.kind, 'stop')
  assert.equal(textOf(auxiliary), 'Subagent answer kept as is.', 'a non-main purpose is never held back')

  const turns = prompts()
  assert.equal(turns.length, 2, 'one prompt per step: no automatic re-answer anywhere')
  assert.ok(turns.every(turn => !turn.text.includes(NOTICE)), 'no continuation notice is sent')
})
