/**
 * Read per-step model token usage, timing, and pre-send context estimates
 * written by `agy` into its local SQLite conversation store
 * (`$home/agy/conversations/<sessionId>.db`, tables `steps` and `gen_metadata`),
 * and evaluate the 5-dimensional shadow-degradation fingerprint.
 * @module omp-antigravity-acp/usage-db
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { AcpPromptResult } from './acp-process.ts'

type DatabaseSync = new (
  path: string,
  options?: { readOnly?: boolean; timeout?: number },
) => {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Record<string, unknown>[]
  }
  close(): void
}

let cachedDatabaseSync: DatabaseSync | null | undefined

function loadDatabaseSync(): DatabaseSync | undefined {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync ?? undefined
  try {
    const req = createRequire(import.meta.url)
    const sqlite = req('node:sqlite') as { DatabaseSync?: DatabaseSync }
    cachedDatabaseSync = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null
  } catch {
    cachedDatabaseSync = null
  }
  return cachedDatabaseSync ?? undefined
}

/** Decoded `ModelUsageStats` submessage from `steps.metadata` field `9` or `gen_metadata` `f1.4`. */
export interface DecodedModelUsage {
  inputTokens: number
  outputTokens: number
  cachedWriteTokens: number
  cachedReadTokens: number
  thoughtTokens: number
}

/** Full per-step metrics decoded from one `steps.metadata` row (`step_type = 15, status = 3`). */
export interface DecodedStepRecord extends DecodedModelUsage {
  idx: number
  textOutTokens: number
  modelEnum?: number
  ttftSeconds: number
  streamSeconds: number
  wallSeconds: number
}

/** Usage of the model steps one read returned, as reported for one DSH step. */
export interface StepUsageSample {
  /** Billed model steps read. */
  calls: number
  /** Summed usage, `totalTokens = input + cachedRead + cachedWrite + output`. */
  usage: NonNullable<AcpPromptResult['usage']>
  /** Per-model-step billed counters, oldest first. */
  steps: DecodedModelUsage[]
}

/** Aggregated model-step usage and per-step records read after a step cursor. */
export interface StepUsageBatch extends StepUsageSample {
  maxIdx: number
  steps: DecodedStepRecord[]
}

/** Aggregated `gen_metadata` usage read after a generation cursor. */
export interface GenUsageBatch extends StepUsageSample {
  /** Highest `gen_metadata.idx` read — zero rows included — so the cursor never re-reads them. */
  maxIdx: number
  /** Rows decoded after the cursor, including the all-zero (failed or refused) ones. */
  rows: number
  /** The billed rows only, oldest first. */
  steps: DecodedGenMetadataRecord[]
}

/** Real-time generation billing and pre-send context estimate decoded from one `gen_metadata` row. */
export interface DecodedGenMetadataRecord extends DecodedStepRecord {
  /** Pre-send local context token estimate (`f1.9.10.1`). */
  cwmEstTokens?: number
}

/** Batch of `gen_metadata` rows read after a cursor. */
export interface GenMetadataBatch {
  maxIdx: number
  records: DecodedGenMetadataRecord[]
}

/** Identifier for each orthogonal signal in the composite shadow-degradation fingerprint. */
export type DegradeSignalKind =
  | 'context_truncated'
  | 'cache_cliff'
  | 'fast_decode'
  | 'block_cache'
  | 'shallow_thought'

/** One matched signal contributing points toward shadow-degradation diagnosis. */
export interface DegradeSignal {
  kind: DegradeSignalKind
  points: number
  detail: string
  cwmEstTokens?: number
  droppedTokens?: number
  streamTps?: number
  wallTps?: number
  cachedReadTokens?: number
  consecutiveBlocks?: number
  thoughtTokens?: number
  ttftSeconds?: number
}

/** Inputs required to evaluate the 5-dimensional fingerprint on one model step. */
export interface DegradeFingerprintInput {
  model: string
  effort: string
  step: Pick<
    DecodedStepRecord,
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedReadTokens'
    | 'thoughtTokens'
    | 'textOutTokens'
    | 'ttftSeconds'
    | 'streamSeconds'
    | 'wallSeconds'
  >
  /** Pre-send local context token estimate (`gen_metadata` `f1.9.10.1`). */
  cwmEstTokens?: number
  /** Whether the step is currently attempting to invoke an external tool. */
  isToolStep?: boolean
  /** Previous step's `cachedReadTokens` in the same unbroken ACP session. */
  prevCacheRead?: number
  /** Previous step's `inputTokens + cachedReadTokens` in the same unbroken ACP session. */
  prevTotalInput?: number
  /** Consecutive immediately preceding steps with `cachedReadTokens >= 4096` divisible by `2048`. */
  priorBlockAlignedCount?: number
}

/** Scored verdict of the 5-dimensional composite shadow-degradation evaluator. */
export interface DegradeFingerprintResult {
  evaluated: boolean
  degraded: boolean
  score: number
  signals: DegradeSignal[]
  streamTps: number
  wallTps: number
  ttftSeconds: number
  thoughtTokens: number
  contextTokens: number
  blockAlignedCache: boolean
  exactPrefixCache: boolean
}

/**
 * Resolve the SQLite conversation DB path for one ACP session.
 * @param home - isolated Antigravity home directory.
 * @param sessionId - ACP session id.
 * @returns absolute path to `<sessionId>.db`.
 */
export function sessionDbPath(home: string, sessionId: string): string {
  return join(home, 'agy', 'conversations', `${sessionId}.db`)
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n
  let shift = 0n
  for (let i = 0; i < 10; i++) {
    const byte = buf[offset + i]
    if (byte === undefined) return undefined
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 }
    shift += 7n
  }
  return undefined
}

function toNonNegativeCount(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw)
  if (signed <= 0n) return 0
  if (signed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(signed)
}

interface InternalUsageDecode extends DecodedModelUsage {
  textOutTokens: number
  modelEnum?: number
}

/** Visitor verdict for one decoded field: keep walking, stop on a found value, or reject the blob. */
type ProtoVisit = 'next' | 'stop' | 'invalid'

/** One top-level field of a Protobuf message: a varint value or a length-delimited payload. */
type ProtoField =
  | { field: number; wire: 0; value: bigint }
  | { field: number; wire: 2; bytes: Uint8Array }
  | { field: number; wire: 1 | 5 }

/**
 * Walk the top-level fields of one Protobuf message, validating every tag, wire type and length
 * prefix and skipping fields the visitor does not consume.
 * @param buf - raw message bytes.
 * @param visit - per-field handler; `'stop'` ends the walk successfully, `'invalid'` rejects the blob.
 * @returns `false` when the blob is malformed, `true` when the walk completed or was stopped.
 */
function walkProtoFields(buf: Uint8Array, visit: (entry: ProtoField) => ProtoVisit): boolean {
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === undefined) return false
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (field <= 0) return false
    let outcome: ProtoVisit
    if (wire === 0) {
      const val = readVarint(buf, pos)
      if (val === undefined) return false
      pos = val.next
      outcome = visit({ field, wire: 0, value: val.value })
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (len === undefined) return false
      const byteLen = Number(len.value)
      if (len.value < 0n || !Number.isSafeInteger(byteLen) || len.next + byteLen > buf.length) return false
      const bytes = buf.subarray(len.next, len.next + byteLen)
      pos = len.next + byteLen
      outcome = visit({ field, wire: 2, bytes })
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4
      if (pos + width > buf.length) return false
      pos += width
      outcome = visit({ field, wire })
    } else {
      return false
    }
    if (outcome === 'stop') return true
    if (outcome === 'invalid') return false
  }
  return true
}

function parseModelUsageSubmessage(buf: Uint8Array, target: InternalUsageDecode): boolean {
  return walkProtoFields(buf, (entry) => {
    if (entry.wire !== 0) return 'next'
    const { field, value } = entry
    const count = toNonNegativeCount(value)
    if (field === 1) target.modelEnum = count
    else if (field === 2) target.inputTokens = count
    else if (field === 3) target.outputTokens = count
    else if (field === 4) target.cachedWriteTokens = count
    else if (field === 5) target.cachedReadTokens = count
    else if (field === 9) target.thoughtTokens = count
    else if (field === 10) target.textOutTokens = count
    return 'next'
  })
}

function parseSecondsAndNanos(buf: Uint8Array, requirePositiveSeconds: boolean): number | undefined {
  let seconds = 0
  let nanos = 0
  let sawSeconds = false
  let sawAny = false
  const ok = walkProtoFields(buf, (entry) => {
    if (entry.wire !== 0) return 'next'
    const { field, value } = entry
    const num = toNonNegativeCount(value)
    if (field === 1) {
      seconds = num
      sawSeconds = true
      sawAny = true
    } else if (field === 2) {
      nanos = num
      sawAny = true
    }
    return 'next'
  })
  if (!ok) return undefined
  if (requirePositiveSeconds) {
    return sawSeconds && seconds > 0 ? seconds + nanos / 1_000_000_000 : undefined
  }
  return sawAny ? seconds + nanos / 1_000_000_000 : 0
}

function parseFirstField1Varint(buf: Uint8Array): number | undefined {
  let found: number | undefined
  const ok = walkProtoFields(buf, (entry) => {
    if (entry.wire !== 0 || entry.field !== 1) return 'next'
    found = toNonNegativeCount(entry.value)
    return 'stop'
  })
  return ok ? found : undefined
}

function parseChatStartCwmTokens(buf: Uint8Array): number | undefined {
  let cwm: number | undefined
  const ok = walkProtoFields(buf, (entry) => {
    if (entry.wire !== 2 || entry.field !== 10) return 'next'
    const first = parseFirstField1Varint(entry.bytes)
    if (first === undefined) return 'next'
    cwm = first
    return 'stop'
  })
  return ok ? cwm : undefined
}

function parseGenChatSubmessage(buf: Uint8Array): Omit<DecodedGenMetadataRecord, 'idx'> | undefined {
  let sawUsage = false
  let chatModelEnum: number | undefined
  let cwmEstTokens: number | undefined
  let ttftSeconds = 0
  let streamSeconds = 0
  const stats: InternalUsageDecode = {
    inputTokens: 0,
    outputTokens: 0,
    cachedWriteTokens: 0,
    cachedReadTokens: 0,
    thoughtTokens: 0,
    textOutTokens: 0,
  }
  const ok = walkProtoFields(buf, (entry) => {
    if (entry.wire === 0) {
      if (entry.field === 3) chatModelEnum = toNonNegativeCount(entry.value)
      return 'next'
    }
    if (entry.wire !== 2) return 'next'
    const { field, bytes } = entry
    if (field === 4) {
      if (!parseModelUsageSubmessage(bytes, stats)) return 'invalid'
      sawUsage = true
    } else if (field === 9) {
      const est = parseChatStartCwmTokens(bytes)
      if (est !== undefined && est > 0) cwmEstTokens = est
    } else if (field === 11) {
      const dur = parseSecondsAndNanos(bytes, false)
      if (dur !== undefined) ttftSeconds = dur
    } else if (field === 12) {
      const dur = parseSecondsAndNanos(bytes, false)
      if (dur !== undefined) streamSeconds = dur
    }
    return 'next'
  })
  if (!ok) return undefined
  if (!sawUsage && cwmEstTokens === undefined) return undefined
  const modelEnum = stats.modelEnum ?? chatModelEnum
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cachedWriteTokens: stats.cachedWriteTokens,
    cachedReadTokens: stats.cachedReadTokens,
    thoughtTokens: stats.thoughtTokens,
    textOutTokens: stats.textOutTokens,
    ...(modelEnum !== undefined ? { modelEnum } : {}),
    ...(cwmEstTokens !== undefined ? { cwmEstTokens } : {}),
    ttftSeconds,
    streamSeconds,
    wallSeconds: ttftSeconds + streamSeconds,
  }
}

/**
 * Decode full per-step token counts and timing (`f1`, `f6`, `f7`, `f9`) from `steps.metadata`.
 * @param metadata - raw Protobuf bytes from `steps.metadata`.
 * @returns decoded step metrics, or `undefined` if field `9` is absent or malformed.
 */
export function decodeStepMetadata(metadata: Uint8Array): Omit<DecodedStepRecord, 'idx'> | undefined {
  let found = false
  let startSec: number | undefined
  let firstSec: number | undefined
  let endSec: number | undefined
  const stats: InternalUsageDecode = {
    inputTokens: 0,
    outputTokens: 0,
    cachedWriteTokens: 0,
    cachedReadTokens: 0,
    thoughtTokens: 0,
    textOutTokens: 0,
  }
  const ok = walkProtoFields(metadata, (entry) => {
    if (entry.wire !== 2) return 'next'
    const { field, bytes } = entry
    if (field === 1) startSec = parseSecondsAndNanos(bytes, true)
    else if (field === 6) firstSec = parseSecondsAndNanos(bytes, true)
    else if (field === 7) endSec = parseSecondsAndNanos(bytes, true)
    else if (field === 9) {
      if (!parseModelUsageSubmessage(bytes, stats)) return 'invalid'
      found = true
    }
    return 'next'
  })
  if (!ok || !found) return undefined
  const ttftSeconds = startSec !== undefined && firstSec !== undefined && firstSec >= startSec ? firstSec - startSec : 0
  const streamSeconds = firstSec !== undefined && endSec !== undefined && endSec >= firstSec ? endSec - firstSec : 0
  const wallSeconds = startSec !== undefined && endSec !== undefined && endSec >= startSec ? endSec - startSec : 0
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cachedWriteTokens: stats.cachedWriteTokens,
    cachedReadTokens: stats.cachedReadTokens,
    thoughtTokens: stats.thoughtTokens,
    textOutTokens: stats.textOutTokens,
    ...(stats.modelEnum !== undefined ? { modelEnum: stats.modelEnum } : {}),
    ttftSeconds,
    streamSeconds,
    wallSeconds,
  }
}

/**
 * Decode real-time generation billing (`f1.4`), pre-send context estimate (`f1.9.10.1`),
 * and streaming durations (`f1.11`, `f1.12`) from a `gen_metadata.data` Protobuf blob.
 * Committed by `agy` immediately when model generation finishes, before MCP tool execution.
 * @param data - raw Protobuf bytes from `gen_metadata.data`.
 * @returns decoded generation record, or `undefined` when `f1` is absent or malformed.
 */
export function decodeGenMetadata(data: Uint8Array): Omit<DecodedGenMetadataRecord, 'idx'> | undefined {
  let decoded: Omit<DecodedGenMetadataRecord, 'idx'> | undefined
  const ok = walkProtoFields(data, (entry) => {
    if (entry.wire !== 2 || entry.field !== 1) return 'next'
    decoded = parseGenChatSubmessage(entry.bytes)
    return 'next'
  })
  return ok ? decoded : undefined
}

/**
 * Read the current maximum completed model-step index (`step_type = 15, status = 3`).
 * @param dbPath - path to `<sessionId>.db`.
 * @returns maximum step `idx`, or `-1` when absent or empty.
 */
export function peekMaxModelStepIdx(dbPath: string): number {
  if (!existsSync(dbPath)) return -1
  const Database = loadDatabaseSync()
  if (Database === undefined) return -1
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE step_type = 15 AND status = 3').get()
      const raw = row?.['maxIdx']
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'bigint') return Number(raw)
      return -1
    } finally {
      db.close()
    }
  } catch {
    return -1
  }
}

/**
 * Read the current maximum `gen_metadata` row index.
 * @param dbPath - path to `<sessionId>.db`.
 * @returns maximum `gen_metadata.idx`, or `-1` when absent or empty.
 */
export function peekMaxGenMetadataIdx(dbPath: string): number {
  if (!existsSync(dbPath)) return -1
  const Database = loadDatabaseSync()
  if (Database === undefined) return -1
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata').get()
      const raw = row?.['maxIdx']
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'bigint') return Number(raw)
      return -1
    } finally {
      db.close()
    }
  } catch {
    return -1
  }
}

function asBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return undefined
}

function asIndex(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'bigint') return Number(raw)
  return undefined
}

/**
 * Read all `gen_metadata` rows after `afterIdx` and decode their real-time billing records.
 * @param dbPath - path to `<sessionId>.db`.
 * @param afterIdx - exclusive lower-bound `gen_metadata.idx`.
 * @returns batch of generation records, or `undefined` when none exist.
 */
export function readGenMetadataAfter(dbPath: string, afterIdx: number): GenMetadataBatch | undefined {
  if (!existsSync(dbPath)) return undefined
  const Database = loadDatabaseSync()
  if (Database === undefined) return undefined
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC').all(afterIdx)
      let maxIdx = afterIdx
      const records: DecodedGenMetadataRecord[] = []
      for (const row of rows) {
        const idx = asIndex(row['idx'])
        const bytes = asBytes(row['data'])
        if (idx === undefined || bytes === undefined) continue
        if (idx > maxIdx) maxIdx = idx
        const decoded = decodeGenMetadata(bytes)
        if (decoded !== undefined) records.push({ idx, ...decoded })
      }
      return records.length > 0 ? { maxIdx, records } : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** Five counters `agy` bills for one generation. */
function billedTokenTotal(step: DecodedModelUsage): number {
  return step.inputTokens + step.outputTokens + step.cachedReadTokens + step.cachedWriteTokens + step.thoughtTokens
}

/** Sum decoded model steps into the usage reported for one DSH step. */
function sumDecodedUsage(steps: readonly DecodedModelUsage[]): NonNullable<AcpPromptResult['usage']> {
  let inputTokens = 0
  let outputTokens = 0
  let cachedReadTokens = 0
  let cachedWriteTokens = 0
  let thoughtTokens = 0
  for (const step of steps) {
    inputTokens += step.inputTokens
    outputTokens += step.outputTokens
    cachedReadTokens += step.cachedReadTokens
    cachedWriteTokens += step.cachedWriteTokens
    thoughtTokens += step.thoughtTokens
  }
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    thoughtTokens,
    totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
  }
}

/** Completed model steps in one session DB, the only rows that carry billing. */
const MODEL_STEP_ROWS = 'SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3'

/** Decode and aggregate raw `steps` rows; undecodable rows are skipped, not counted. */
function stepBatchFrom(rows: readonly Record<string, unknown>[], afterIdx: number): StepUsageBatch | undefined {
  let maxIdx = afterIdx
  const steps: DecodedStepRecord[] = []
  for (const row of rows) {
    const idx = asIndex(row['idx'])
    const bytes = asBytes(row['metadata'])
    if (idx === undefined || bytes === undefined) continue
    const decoded = decodeStepMetadata(bytes)
    if (decoded === undefined) continue
    if (idx > maxIdx) maxIdx = idx
    steps.push({ idx, ...decoded })
  }
  if (steps.length === 0) return undefined
  return { maxIdx, calls: steps.length, usage: sumDecodedUsage(steps), steps }
}

/**
 * Whether one session DB carries real-time generation billing rows.
 * An old `agy` has no `gen_metadata` table at all, so its steps stay the only usage source.
 * @param dbPath - path to `<sessionId>.db`.
 * @returns true only when the table exists and holds at least one row.
 */
export function hasGenMetadata(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  const Database = loadDatabaseSync()
  if (Database === undefined) return false
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      return db.prepare('SELECT 1 AS present FROM gen_metadata LIMIT 1').get() !== undefined
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/**
 * Read per-step usage from `gen_metadata` after `afterIdx`, dropping the rows whose five
 * token counters are all zero: they belong to failed or refused requests that never
 * produced a model step. The cursor still advances past them, so a zero row is read once.
 * @param dbPath - path to `<sessionId>.db`.
 * @param afterIdx - exclusive lower-bound `gen_metadata.idx`.
 * @returns the billed rows with their aggregate and the cursor to resume from, or
 * `undefined` when the table is absent or holds no row after the cursor.
 */
export function readGenUsageAfter(dbPath: string, afterIdx: number): GenUsageBatch | undefined {
  const batch = readGenMetadataAfter(dbPath, afterIdx)
  if (batch === undefined) return undefined
  const steps = batch.records.filter(record => billedTokenTotal(record) > 0)
  return {
    maxIdx: batch.maxIdx,
    rows: batch.records.length,
    calls: steps.length,
    usage: sumDecodedUsage(steps),
    steps,
  }
}

/**
 * Read and sum all completed model steps (`step_type = 15, status = 3`) after `afterIdx`.
 * @param dbPath - path to `<sessionId>.db`.
 * @param afterIdx - exclusive lower-bound step `idx`.
 * @returns aggregated batch with individual step records, or `undefined` when none exist.
 */
export function readModelStepsAfter(dbPath: string, afterIdx: number): StepUsageBatch | undefined {
  if (!existsSync(dbPath)) return undefined
  const Database = loadDatabaseSync()
  if (Database === undefined) return undefined
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const rows = db.prepare(`${MODEL_STEP_ROWS} AND idx > ? ORDER BY idx ASC`).all(afterIdx)
      return stepBatchFrom(rows, afterIdx)
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Read the highest-`idx` completed model steps, oldest first: the tail a session DB
 * can end with steps `gen_metadata` never billed.
 * @param dbPath - path to `<sessionId>.db`.
 * @param limit - how many steps of the tail to read.
 * @returns the tail batch, or `undefined` when no step exists.
 */
export function readModelStepTail(dbPath: string, limit: number): StepUsageBatch | undefined {
  if (limit <= 0) return undefined
  if (!existsSync(dbPath)) return undefined
  const Database = loadDatabaseSync()
  if (Database === undefined) return undefined
  try {
    const db = new Database(dbPath, { readOnly: true, timeout: 100 })
    try {
      const rows = db.prepare(`${MODEL_STEP_ROWS} ORDER BY idx DESC LIMIT ?`).all(limit)
      return stepBatchFrom(rows.reverse(), -1)
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Evaluate the 5-dimensional physical shadow-degradation fingerprint on one model step.
 * Only `gemini-4-argon` family requests with non-zero billing are evaluated; a total score `>= 3`
 * diagnoses upstream fallback routing while keeping single borderline metrics below threshold.
 * `block_cache` is only corroborating evidence, so signals consisting solely of it never degrade
 * on their own.
 * @param input - step metrics, pre-send context estimate, and prior same-session cache state.
 * @returns scored fingerprint verdict and matched signals.
 */
export function evaluateDegradeFingerprint(input: DegradeFingerprintInput): DegradeFingerprintResult {
  const { step } = input
  const contextTokens = Math.max(0, step.inputTokens) + Math.max(0, step.cachedReadTokens)
  const rawStreamTps = step.streamSeconds > 0.05 && step.textOutTokens > 0 ? step.textOutTokens / step.streamSeconds : 0
  const rawWallTps = step.wallSeconds > 0.05 && step.outputTokens > 0 ? step.outputTokens / step.wallSeconds : 0
  const streamTps = Math.round(rawStreamTps * 10) / 10
  const wallTps = Math.round(rawWallTps * 10) / 10
  const ttftSeconds = Math.round(Math.max(0, step.ttftSeconds) * 100) / 100
  const blockAlignedCache = step.cachedReadTokens >= 4_096 && step.cachedReadTokens % 2048 === 0
  const exactPrefixCache = step.cachedReadTokens > 0 && step.cachedReadTokens % 2048 !== 0

  if (!/argon/i.test(input.model) || (contextTokens === 0 && step.outputTokens === 0)) {
    return {
      evaluated: false,
      degraded: false,
      score: 0,
      signals: [],
      streamTps,
      wallTps,
      ttftSeconds,
      thoughtTokens: step.thoughtTokens,
      contextTokens,
      blockAlignedCache: false,
      exactPrefixCache: false,
    }
  }

  let score = 0
  const signals: DegradeSignal[] = []

  // F1: Hard 128K head-slice truncation (`127,997` ceiling on the fallback pool, +5).
  const near128kCap = contextTokens >= 127_950 && contextTokens <= 128_000 && !exactPrefixCache
  if (
    near128kCap
    && (
      (input.cwmEstTokens !== undefined && input.cwmEstTokens >= 140_000)
      || (input.prevTotalInput !== undefined && input.prevTotalInput >= 140_000)
      || blockAlignedCache
    )
  ) {
    score += 5
    const origin = input.cwmEstTokens ?? input.prevTotalInput ?? contextTokens
    signals.push({
      kind: 'context_truncated',
      points: 5,
      detail: `${Math.round(origin / 1000)}K→128K`,
      ...(input.cwmEstTokens !== undefined ? { cwmEstTokens: input.cwmEstTokens } : {}),
    })
  }

  // F2: Same-session KV cache cliff + stripped Argon thoughtSignature shrinkage (+4),
  // excluding legitimate client-side trajectory compaction where `cwmEstTokens` also drops.
  const uncompactedSession = input.cwmEstTokens !== undefined
    ? (input.prevTotalInput !== undefined && input.cwmEstTokens >= input.prevTotalInput)
    : (input.prevTotalInput !== undefined && contextTokens >= input.prevTotalInput * 0.65)
  if (
    contextTokens > 0
    && input.prevCacheRead !== undefined
    && input.prevCacheRead >= 16_000
    && step.cachedReadTokens === 0
    && input.prevTotalInput !== undefined
    && input.prevTotalInput - contextTokens >= 2_000
    && uncompactedSession
  ) {
    const dropped = input.prevTotalInput - contextTokens
    score += 4
    signals.push({
      kind: 'cache_cliff',
      points: 4,
      detail: `-${(dropped / 1000).toFixed(1)}K`,
      droppedTokens: dropped,
    })
  }

  // F3: Fallback-tier decode velocity ceiling (+2, +3 on a cold-prefix burst).
  const fastStream = step.textOutTokens >= 200 && rawStreamTps >= 220
  const fastWall = step.outputTokens >= 350 && rawWallTps >= 180
  if (fastStream || fastWall) {
    // No prefix cache read plus a sub-5.5s TTFT and a fast decode: only the fallback pool
    // answers a cold 2048-block prompt that fast, so the cold burst corroborates by itself.
    const coldBurst = step.cachedReadTokens === 0 && fastWall && step.ttftSeconds > 0 && step.ttftSeconds < 5.5
    const pts = coldBurst ? 3 : 2
    score += pts
    signals.push({
      kind: 'fast_decode',
      points: pts,
      detail: fastStream ? `${Math.round(rawStreamTps)} tok/s` : `${Math.round(rawWallTps)} tok/s`,
      streamTps,
      wallTps,
    })
  }

  // F4: 2048-token block-quantized KV cache granularity (+2 single, +3 consecutive).
  if (blockAlignedCache) {
    const consecutiveBlocks = (input.priorBlockAlignedCount ?? 0) + 1
    const pts = consecutiveBlocks >= 2 ? 3 : 2
    score += pts
    signals.push({
      kind: 'block_cache',
      points: pts,
      detail: String(step.cachedReadTokens),
      cachedReadTokens: step.cachedReadTokens,
      consecutiveBlocks,
    })
  }

  // F5: Zero or shallow thinking under High effort.
  if (input.effort === 'high') {
    const nonTrivialZeroThought = step.thoughtTokens === 0
      && (step.outputTokens >= 60 || (input.isToolStep === true && step.outputTokens > 0))
    if (nonTrivialZeroThought) {
      const pts = (step.ttftSeconds > 0 && step.ttftSeconds < 15) || blockAlignedCache ? 3 : 2
      score += pts
      signals.push({
        kind: 'shallow_thought',
        points: pts,
        detail: '0 tok',
        thoughtTokens: 0,
        ttftSeconds,
      })
    } else if (step.outputTokens >= 400 && step.ttftSeconds > 0 && step.ttftSeconds < 4.5 && step.thoughtTokens < 650) {
      score += 1
      signals.push({
        kind: 'shallow_thought',
        points: 1,
        detail: `${step.ttftSeconds.toFixed(1)}s`,
        thoughtTokens: step.thoughtTokens,
        ttftSeconds,
      })
    }
  }

  // `block_cache` is a granularity artifact rather than proof of fallback routing: on its own it
  // may raise the displayed score, but a non-`block_cache` signal must corroborate the verdict.
  const hadCorroboratingSignal = signals.some(signal => signal.kind !== 'block_cache')

  return {
    evaluated: true,
    degraded: score >= 3 && hadCorroboratingSignal,
    score,
    signals,
    streamTps,
    wallTps,
    ttftSeconds,
    thoughtTokens: step.thoughtTokens,
    contextTokens,
    blockAlignedCache,
    exactPrefixCache,
  }
}
