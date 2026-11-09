#!/usr/bin/env node
// Scripted stand-in for `agy acp` used by the tests. It speaks ACP v1 over
// stdio, connects to the session's HTTP MCP server like the official agent,
// supports `session/load` resumption across evictions/restarts, and follows
// directives embedded in prompt text:
//   CALL <tool> <json>      report the tool call, ask permission, call one MCP tool
//   GATEDCALL <spec> => <spec> ...  write real gen_metadata before each call; retry in-turn on [HARNESS_GATEKEEPER]
//   PCALL <tool> <json> ;; <tool> <json>   call several tools concurrently
//   SLEEP <ms>              wait before ending the turn
//   MAXTOK                  end the first segment with max_tokens
//   DENYCALL <tool> <json>  native tool whose rawInput merely embeds "mcp_dsh_<tool>"
//   SPOOFCALL <tool> <json> title fakes "mcp_dsh_<tool>" but no structured metadata
//   STALECALL <tool> <json> permission claims structured metadata never reported
//   CONFLICTCALL <a> <json> ;; <b>  reported tool a but permission claims b
//   CROSSCALL <session> <tool> <json>  permission request names another session
//   PROBECALL               MCP loading probe (no tool name, empty input)
//   PROBECALL_ALWAYSONLY    same probe, but the options only offer allow_always
//   STATUSUPDCALL <tool> <json>  report identity, then a status-only tool_call_update
//   CONFLICTUPDCALL <a> <json> ;; <b>  tool_call_update contradicts the reported identity
//   REPLAYCALL <tool> <json>  permission for the previous turn's already reported id
//   CALL_ALWAYSONLY <tool> <json>  reported call whose options only offer allow_always
//   QUOTA                   fail a prompt carrying it with a quota JSON-RPC error
//   RATELIMIT               fail a prompt carrying it with a 429 rate-limit JSON-RPC error stating a retry delay
//
// Plan mode (opt-in through `FAKE_AGY_PLAN`, a JSON array) ignores the prompt
// text: the n-th `session/prompt` of the whole process (across every ACP
// session) answers with the n-th entry, so a test scripts an exact sequence of
// attempts even when the runtime retries the same request in a new session.
// One entry answers one prompt:
//   {"gen": {...}}            write real gen_metadata for this generation first
//   {"thought": "..."}        emit one agent_thought_chunk
//   {"tool": {"name": "bash", "args": {...}}}  report and run one MCP tool call
//   {"text": "..."}           emit one agent_message_chunk
//   {"stop": "end_turn"}      override the stop reason (default end_turn)
// After a tool call the entry's `text` is emitted once the harness has
// delivered the result; without `text` the tool result is echoed like the
// directive modes do. A resumed turn (the harness delivered a tool result
// inside the same prompt) continues with `afterTool`, one more part with the
// same shape, so a test can script a degraded gate that only fires after a
// completed tool step. A plan that runs out falls back to the directive modes.
//
// `FAKE_AGY_LIFECYCLE` names a JSONL file that records session/new,
// session/load, and session/close, so a test can prove an ACP session stayed
// open (no close, no replacement session) across a retried request.
// Both modes are additive: existing directives keep their behavior, and
// neither file nor plan is written unless its environment variable is set.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const req = createRequire(import.meta.url)
const { DatabaseSync } = req('node:sqlite')

const log = process.env.FAKE_AGY_LOG
const initLog = process.env.FAKE_AGY_INIT
const mcpLog = process.env.FAKE_AGY_MCP
const lifecycleLog = process.env.FAKE_AGY_LIFECYCLE
const failMode = process.env.FAKE_AGY_FAIL ?? ''
const omitModels = new Set((process.env.FAKE_AGY_OMIT_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean))
const geminiDirFlag = process.argv.indexOf('--gemini-dir')
const geminiDir = geminiDirFlag >= 0 ? process.argv[geminiDirFlag + 1] : undefined
const persistedFile = geminiDir ? join(geminiDir, 'fake-sessions.json') : undefined

const sessions = new Map()
let nextSession = 1
let pendingGatedStages = []
/** Scripted per-`session/prompt` answers; `undefined` keeps the directive modes. */
const planEntries = readPlan()
let planCursor = 0
function readPlan() {
  const raw = process.env.FAKE_AGY_PLAN
  if (raw === undefined || raw.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}
/** Record one ACP session lifecycle event for tests that prove a session stayed open. */
function noteLifecycle(op, sessionId) {
  if (lifecycleLog === undefined) return
  try { appendFileSync(lifecycleLog, `${JSON.stringify({ op, session: sessionId })}\n`) } catch { /* ignore */ }
}
if (persistedFile && existsSync(persistedFile)) {
  try {
    const saved = JSON.parse(readFileSync(persistedFile, 'utf8'))
    for (const item of saved.sessions ?? []) sessions.set(item.id, item)
    if (typeof saved.nextSession === 'number') nextSession = saved.nextSession
    if (Array.isArray(saved.pendingGatedStages)) pendingGatedStages = saved.pendingGatedStages
  } catch { /* ignore */ }
}
function persistSessions() {
  if (!persistedFile) return
  try {
    mkdirSync(dirname(persistedFile), { recursive: true })
    const serializable = [...sessions.values()].map(s => ({ id: s.id, model: s.model, level: s.level, system: s.system, genIdx: s.genIdx ?? 0 }))
    writeFileSync(persistedFile, JSON.stringify({ nextSession, pendingGatedStages, sessions: serializable }))
  } catch { /* ignore */ }
}

function encodeVarint(num) {
  let v = typeof num === 'bigint' ? num : BigInt(Math.max(0, Math.round(num)))
  const out = []
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return out
}
function encodeLen(field, bytes) {
  return [...encodeVarint((BigInt(field) << 3n) | 2n), ...encodeVarint(bytes.length), ...bytes]
}
function encodeDuration(secFloat) {
  const whole = Math.floor(Math.max(0, secFloat))
  const nanos = Math.round((Math.max(0, secFloat) - whole) * 1_000_000_000)
  const out = []
  if (whole > 0) out.push(...encodeVarint((1n << 3n) | 0n), ...encodeVarint(whole))
  if (nanos > 0) out.push(...encodeVarint((2n << 3n) | 0n), ...encodeVarint(nanos))
  return out
}
function writeGenMetadataRow(sessionId, idx, meta) {
  if (!geminiDir) return
  const dbPath = join(geminiDir, 'agy', 'conversations', `${sessionId}.db`)
  mkdirSync(dirname(dbPath), { recursive: true })
  const usage = [
    ...encodeVarint((1n << 3n) | 0n), ...encodeVarint(meta.modelEnum ?? 1417),
    ...encodeVarint((2n << 3n) | 0n), ...encodeVarint(meta.inputTokens ?? 0),
    ...encodeVarint((3n << 3n) | 0n), ...encodeVarint(meta.outputTokens ?? 0),
    ...encodeVarint((4n << 3n) | 0n), ...encodeVarint(meta.cachedWriteTokens ?? 0),
    ...encodeVarint((5n << 3n) | 0n), ...encodeVarint(meta.cachedReadTokens ?? 0),
    ...encodeVarint((9n << 3n) | 0n), ...encodeVarint(meta.thoughtTokens ?? 0),
    ...encodeVarint((10n << 3n) | 0n), ...encodeVarint(meta.textOutTokens ?? 0),
  ]
  const chat = [
    ...encodeVarint((3n << 3n) | 0n), ...encodeVarint(meta.modelEnum ?? 1417),
    ...encodeLen(4, usage),
    ...(meta.cwmEstTokens !== undefined
      ? encodeLen(9, encodeLen(10, [...encodeVarint((1n << 3n) | 0n), ...encodeVarint(meta.cwmEstTokens)]))
      : []),
    ...encodeLen(11, encodeDuration(meta.ttftSeconds ?? 8)),
    ...encodeLen(12, encodeDuration(meta.streamSeconds ?? 2)),
  ]
  const blob = new Uint8Array(encodeLen(1, chat))
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0)')
    db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(idx, blob, blob.length)
  } finally {
    db.close()
  }
}

const rl = createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
const ALL_MODELS = [
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]
const offeredModels = () => ALL_MODELS.filter(m => !omitModels.has(m.value))
const availableModels = () => [
  ...['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5']
    .filter(id => !omitModels.has(id))
    .flatMap(id => ['low', 'medium', 'high'].map(level => ({ modelId: `${id}-${level}`, name: `${id} (${level})` }))),
  ...(omitModels.has('gpt-oss-120b-medium') ? [] : [{ modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }]),
]
const configOptions = (s) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: offeredModels() },
  { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: s.level, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
]
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })

async function mcp(server, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const h of server.headers) headers[h.name.toLowerCase()] = h.value
  const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const events = text.split('\n\n').map(e => e.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)))
    return events.find(e => e.id === body.id)
  }
  return text ? JSON.parse(text) : undefined
}

let rpcId = 100
let toolCallSeq = 0

function askPermission(s, toolCall, sessionIdOverride, optionsMode) {
  return new Promise((resolve) => {
    const id = ++rpcId
    const handler = (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id === id && msg.method === undefined) {
        rl.off('line', handler)
        resolve(msg.result?.outcome)
      }
    }
    rl.on('line', handler)
    const options = optionsMode === 'always-only'
      ? [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }]
      : [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ]
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sessionIdOverride ?? s.id, toolCall, options } })
  })
}

async function runToolCall(s, name, args, opts = {}) {
  const toolCallId = opts.reuseId ?? `tc${++toolCallSeq}`
  s.lastToolCallId = toolCallId
  const toolCall = {
    toolCallId,
    title: opts.title ?? `mcp_dsh_${name}`,
    kind: opts.kind ?? 'other',
    rawInput: opts.rawInput ?? args,
  }
  const reportStructured = opts.structured === undefined ? { server: 'dsh', tool: name } : opts.structured
  if (!opts.noReport) {
    update(s.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: toolCall.title,
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      ...(reportStructured ? { mcpServerName: reportStructured.server, mcpToolName: reportStructured.tool } : {}),
    })
  }
  if (opts.statusOnlyUpdate) update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'pending' })
  if (opts.conflictUpdateWith !== undefined) {
    update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'pending', mcpServerName: 'dsh', mcpToolName: opts.conflictUpdateWith })
  }
  if (!opts.noPermission) {
    const outcome = await askPermission(s, {
      ...toolCall,
      ...(opts.claim ? { mcpServerName: opts.claim.server, mcpToolName: opts.claim.tool } : {}),
    }, opts.sessionIdOverride, opts.alwaysOnly ? 'always-only' : undefined)
    const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
    if (!selected.startsWith('allow')) {
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'refused' })
      return `PERMISSION_${selected.startsWith('reject') ? 'REJECTED' : 'CANCELLED'}`
    }
  }
  const res = await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args, _meta: { progressToken: `p${rpcId}`, 'antigravity.google/conversation_id': s.id } } })
  let text = res.result.content.map(c => c.text ?? `[${c.type}]`).join('')
  for (let hop = 0; hop < 20; hop++) {
    const match = /dsh_await_result with \{"call_id":"([^"]+)"\}/.exec(text)
    if (match === null) break
    s.relays = (s.relays ?? 0) + 1
    const next = await runToolCall(s, 'dsh_await_result', { call_id: match[1] })
    text = next
  }
  return text
}

/** Write one plan part's gen_metadata and thought chunk, in that order. */
function beginPlanPart(s, part) {
  if (part.gen) {
    const gIdx = s.genIdx ?? 0
    s.genIdx = gIdx + 1
    persistSessions()
    writeGenMetadataRow(s.id, gIdx, part.gen)
  }
  if (typeof part.thought === 'string' && part.thought.length > 0) {
    update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.thought } })
  }
}

/**
 * Answer one `session/prompt` from the scripted plan entry: write gen_metadata
 * first (so the runtime's degrade fingerprint sees it), then a thought chunk,
 * a tool call, and the visible text. A resumed ACP turn (the harness delivered
 * a tool result inside the same prompt) continues with `afterTool`, so a test
 * can script a degraded gate that only fires after a completed tool step.
 * @param s - the ACP session the prompt runs on.
 * @param stage - the plan entry for this prompt ordinal.
 * @returns the ACP prompt result.
 */
async function runPlanStage(s, stage) {
  const parts = stage.tool !== undefined && stage.afterTool !== undefined ? [stage, stage.afterTool] : [stage]
  let text = ''
  for (const part of parts) {
    beginPlanPart(s, part)
    if (part.tool !== undefined) {
      const result = await runToolCall(s, part.tool.name, part.tool.args ?? {})
      if (s.cancelled) return { stopReason: 'cancelled' }
      if (part.text === undefined) text += `RESULT(${part.tool.name})=${result}`
    }
    if (typeof part.text === 'string') text += part.text
  }
  if (text.length > 0) {
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  const g = stage.gen ?? {}
  return {
    stopReason: stage.stop ?? 'end_turn',
    usage: {
      inputTokens: g.inputTokens ?? 600,
      outputTokens: g.outputTokens ?? 50,
      cachedReadTokens: g.cachedReadTokens ?? 0,
      cachedWriteTokens: 0,
      thoughtTokens: g.thoughtTokens ?? 0,
      totalTokens: (g.inputTokens ?? 600) + (g.cachedReadTokens ?? 0) + (g.outputTokens ?? 50),
    },
  }
}

async function runPrompt(s, text) {
  const lines = text.split('\n')
  const gatedLine = lines.find(l => l.startsWith('GATEDCALL '))
  if (pendingGatedStages.length > 0 || gatedLine !== undefined) {
    if (pendingGatedStages.length === 0 && gatedLine !== undefined) {
      pendingGatedStages = gatedLine.slice(10).split(' => ').map(part => JSON.parse(part.trim()))
    }
    const output = []
    while (pendingGatedStages.length > 0) {
      const stage = pendingGatedStages.shift()
      const gIdx = s.genIdx ?? 0
      s.genIdx = gIdx + 1
      persistSessions()
      if (stage.gen) writeGenMetadataRow(s.id, gIdx, stage.gen)
      const thought = stage.thought !== undefined
        ? stage.thought
        : (stage.gen?.thoughtTokens === 0 ? '' : `thinking(${s.level})`)
      if (thought.length > 0) {
        update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: thought } })
      }
      if (stage.tool) {
        const result = await runToolCall(s, stage.tool, stage.args ?? {})
        if (s.cancelled) return { stopReason: 'cancelled' }
        if (result.includes('[HARNESS_GATEKEEPER]')) continue
        pendingGatedStages = []
        persistSessions()
        output.push(`RESULT(${stage.tool})=${result}`)
        break
      }
      if (stage.text !== undefined) {
        update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: stage.text } })
        const g = stage.gen ?? {}
        return {
          stopReason: 'end_turn',
          usage: {
            inputTokens: g.inputTokens ?? 600,
            outputTokens: g.outputTokens ?? 50,
            cachedReadTokens: g.cachedReadTokens ?? 0,
            cachedWriteTokens: 0,
            thoughtTokens: g.thoughtTokens ?? 0,
            totalTokens: (g.inputTokens ?? 600) + (g.cachedReadTokens ?? 0) + (g.outputTokens ?? 50),
          },
        }
      }
    }
    if (s.cancelled) return { stopReason: 'cancelled' }
    const reply = output.join(' | ')
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
    return { stopReason: 'end_turn', usage: { inputTokens: 600, outputTokens: 50, cachedReadTokens: 400, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 1050 } }
  }

  update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `thinking(${s.level})` } })
  if (text.includes('NOTICE')) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ API error (attempt 1): request failed: EOF\n' } })
  if (text.includes('OUTLIMIT')) {
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ Your previous response was cut off because it exceeded the output token limit\n' } })
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Please continue from where you left off, keeping your response shorter\nRetries remaining: 3\n' } })
  }
  const output = []
  for (const line of lines) {
    if (line.startsWith('CALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')))
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('DENYCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { structured: null, title: name, rawInput: { cmd: `mcp_dsh_${name}` } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('SPOOFCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { structured: null })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('STALECALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { noReport: true, claim: { server: 'dsh', tool: name } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CONFLICTCALL ')) {
      const [head, other] = line.slice(13).split(' ;; ')
      const [name, ...rest] = head.trim().split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { claim: { server: 'dsh', tool: other.trim() } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CROSSCALL ')) {
      const [, target, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { sessionIdOverride: target })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('PROBECALL_ALWAYSONLY')) {
      const toolCallId = `tc${++toolCallSeq}`
      const outcome = await askPermission(s, { toolCallId, title: 'probe', kind: 'other', rawInput: {} }, undefined, 'always-only')
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      output.push(selected.startsWith('allow') ? `PROBE_OK:${selected}` : `PROBE_DENIED:${selected}`)
    } else if (line.startsWith('PROBECALL')) {
      const toolCallId = `tc${++toolCallSeq}`
      const outcome = await askPermission(s, { toolCallId, title: 'probe', kind: 'other', rawInput: {} })
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      output.push(selected.startsWith('allow') ? `PROBE_OK:${selected}` : `PROBE_DENIED:${selected}`)
    } else if (line.startsWith('STATUSUPDCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { statusOnlyUpdate: true })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CONFLICTUPDCALL ')) {
      const [head, other] = line.slice(15).split(' ;; ')
      const [name, ...rest] = head.trim().split(' ')
      const conflicting = other.trim()
      const args = JSON.parse(rest.join(' '))
      const result = await runToolCall(s, name, args, { conflictUpdateWith: conflicting })
      const outcome = await askPermission(s, { toolCallId: s.lastToolCallId, title: `mcp_dsh_${conflicting}`, kind: 'other', rawInput: args, mcpServerName: 'dsh', mcpToolName: conflicting })
      const selected = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
      const second = selected.startsWith('allow') ? `CONFLICT_CLAIM_${conflicting}_ALLOWED:${selected}` : `CONFLICT_CLAIM_${conflicting}_DENIED`
      output.push(`RESULT(${name})=${result} ${second}`)
    } else if (line.startsWith('REPLAYCALL ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { noReport: true, reuseId: s.lastToolCallId, claim: { server: 'dsh', tool: name } })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('CALL_ALWAYSONLY ')) {
      const [, name, ...rest] = line.split(' ')
      const result = await runToolCall(s, name, JSON.parse(rest.join(' ')), { alwaysOnly: true })
      output.push(`RESULT(${name})=${result}`)
    } else if (line.startsWith('PCALL ')) {
      const calls = line.slice(6).split(' ;; ').map(part => { const [name, ...rest] = part.trim().split(' '); return [name, JSON.parse(rest.join(' '))] })
      const results = await Promise.all(calls.map(([name, args]) => runToolCall(s, name, args)))
      output.push(...results.map((r, i) => `RESULT(${calls[i][0]})=${r}`))
    } else if (line.startsWith('SLEEP ')) {
      await new Promise(r => setTimeout(r, Number(line.slice(6))))
    }
  }
  if (s.cancelled) return { stopReason: 'cancelled' }
  if (text.includes('MAXTOK') && !s.continued) {
    s.continued = true
    update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part-one ' } })
    return { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  }
  const reply = output.length > 0 ? output.join(' | ') : `echo:${s.model}:${s.level}:${text.slice(-40)}`
  update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
  return { stopReason: 'end_turn', usage: { inputTokens: 600, outputTokens: 50, cachedReadTokens: 400, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 1050 } }
}

rl.on('line', async (line) => {
  const msg = JSON.parse(line)
  const { id, method, params } = msg
  if (method === undefined) return
  try {
    if (method === 'initialize') {
      if (initLog) appendFileSync(initLog, `${JSON.stringify({ clientInfo: params?.clientInfo })}\n`)
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agy', version: '0.0.1' } } })
    }
    if (method === 'session/new') {
      const defaultModel = offeredModels()[0]?.value ?? 'gemini-3.8-flash'
      const s = { id: `s${nextSession++}`, model: defaultModel, level: 'medium', mcp: params.mcpServers?.[0], system: params._meta?.antigravity?.systemPrompt?.append ?? '', tools: [], genIdx: 0 }
      sessions.set(s.id, s)
      noteLifecycle('new', s.id)
      persistSessions()
      if (s.mcp && !process.env.FAKE_AGY_NO_HANDSHAKE) {
        await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } })
        s.tools = (await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).result.tools.map(t => t.name)
      }
      if (mcpLog) {
        appendFileSync(mcpLog, `${JSON.stringify({ op: 'new', session: s.id, url: s.mcp?.url, authorization: s.mcp?.headers?.find(h => h.name.toLowerCase() === 'authorization')?.value })}\n`)
      }
      return send({ jsonrpc: '2.0', id, result: { sessionId: s.id, configOptions: configOptions(s), models: { availableModels: availableModels(), currentModelId: `${s.model}-${s.level}` } } })
    }
    if (method === 'session/load') {
      const s = sessions.get(params?.sessionId)
      if (!s) {
        return send({ jsonrpc: '2.0', id, error: { code: -32004, message: `Session "${params?.sessionId}" not found` } })
      }
      noteLifecycle('load', s.id)
      s.mcp = params.mcpServers?.[0]
      if (params._meta?.antigravity?.systemPrompt?.append !== undefined) {
        s.system = params._meta.antigravity.systemPrompt.append
      }
      if (s.mcp && !process.env.FAKE_AGY_NO_HANDSHAKE) {
        await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } })
        s.tools = (await mcp(s.mcp, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).result.tools.map(t => t.name)
      }
      if (mcpLog) {
        appendFileSync(mcpLog, `${JSON.stringify({ op: 'load', session: s.id, url: s.mcp?.url, authorization: s.mcp?.headers?.find(h => h.name.toLowerCase() === 'authorization')?.value })}\n`)
      }
      return send({ jsonrpc: '2.0', id, result: { sessionId: s.id, configOptions: configOptions(s), models: { availableModels: availableModels(), currentModelId: `${s.model}-${s.level}` } } })
    }
    const s = sessions.get(params?.sessionId)
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') s.model = params.value
      if (params.configId === 'thought_level') {
        if (s.model.startsWith('gpt-oss')) {
          return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Thinking level "${params.value}" is not offered for model "${s.model}"` } })
        }
        s.level = params.value
      }
      persistSessions()
      return send({ jsonrpc: '2.0', id, result: { configOptions: configOptions(s) } })
    }
    if (method === 'session/prompt') {
      const text = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('')
      if (log) appendFileSync(log, `${JSON.stringify({ session: s.id, text, images: params.prompt.filter(b => b.type === 'image').length, tools: s.tools, model: s.model, level: s.level, system: s.system })}\n`)
      s.cancelled = false
      if (failMode === 'quota' && text.includes('QUOTA')) {
        return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'QUOTA: Claude and GPT models weekly limit reached' } })
      }
      if (failMode === 'ratelimit' && text.includes('RATELIMIT')) {
        return send({ jsonrpc: '2.0', id, error: { code: -32000, message: '429 Too Many Requests: model is overloaded, please retry in 2s' } })
      }
      const result = planEntries !== undefined && planCursor < planEntries.length
        ? await runPlanStage(s, planEntries[planCursor++])
        : await runPrompt(s, text)
      return send({ jsonrpc: '2.0', id, result })
    }
    if (method === 'session/close') {
      noteLifecycle('close', params?.sessionId)
      // Match real `agy acp --process-per-session`: closing a live worker frees memory
      // while keeping the conversation record loadable via `session/load`.
      return send({ jsonrpc: '2.0', id, result: {} })
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown ${method}` } })
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } })
  }
})
rl.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'session/cancel') { const s = sessions.get(msg.params.sessionId); if (s) s.cancelled = true }
})
