// Unit tests for the shadow-degradation fingerprint verdict on real `gen_metadata` replays.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDegradeFingerprint } from '../lib/usage-db.js'

// Replayed steps of one real ACP session (effort=high, model=gemini-4-argon). The 2048-token
// block-quantized cache hit stays constant at 18432 across the tail of the session, so every
// step from idx2 onward accumulates the consecutive `block_cache` bonus alone.
const replayedSteps = [
  {
    idx: 2,
    priorBlockAlignedCount: 1,
    prevCacheRead: 18432,
    prevTotalInput: 21323,
    step: {
      inputTokens: 3157, cachedReadTokens: 18432, outputTokens: 141, thoughtTokens: 73,
      textOutTokens: 68, ttftSeconds: 1.2973, streamSeconds: 0.0543, wallSeconds: 1.3516,
    },
    cwmEstTokens: 27824,
  },
  {
    idx: 3,
    priorBlockAlignedCount: 2,
    prevCacheRead: 18432,
    prevTotalInput: 21589,
    step: {
      inputTokens: 3432, cachedReadTokens: 18432, outputTokens: 82, thoughtTokens: 14,
      textOutTokens: 68, ttftSeconds: 1.0698, streamSeconds: 0.0578, wallSeconds: 1.1276,
    },
    cwmEstTokens: 28076,
  },
  {
    idx: 4,
    priorBlockAlignedCount: 3,
    prevCacheRead: 18432,
    prevTotalInput: 21889,
    step: {
      inputTokens: 3648, cachedReadTokens: 18432, outputTokens: 205, thoughtTokens: 128,
      textOutTokens: 77, ttftSeconds: 1.8615, streamSeconds: 0.00085, wallSeconds: 1.8624,
    },
    cwmEstTokens: 28269,
  },
]

test('consecutive block_cache alone never degrades while keeping its accumulated score', () => {
  for (const replayed of replayedSteps) {
    const result = evaluateDegradeFingerprint({
      model: 'gemini-4-argon',
      effort: 'high',
      isToolStep: true,
      priorBlockAlignedCount: replayed.priorBlockAlignedCount,
      prevCacheRead: replayed.prevCacheRead,
      prevTotalInput: replayed.prevTotalInput,
      cwmEstTokens: replayed.cwmEstTokens,
      step: replayed.step,
    })

    assert.equal(result.evaluated, true)
    // The score is unchanged: the consecutive block bonus still adds 3 points and is surfaced in the UI.
    assert.equal(result.score, 3, `idx${replayed.idx} keeps score 3`)
    assert.deepEqual(result.signals.map(signal => signal.kind), ['block_cache'], `idx${replayed.idx} only matches block_cache`)
    assert.equal(result.signals[0].points, 3)
    assert.equal(result.signals[0].consecutiveBlocks, replayed.priorBlockAlignedCount + 1)
    // ...but a granularity artifact on its own must not be diagnosed as upstream degradation.
    assert.equal(result.degraded, false, `idx${replayed.idx} is not degraded`)
  }
})

test('consecutive block_cache degrades once a corroborating signal matches', () => {
  const corroborated = evaluateDegradeFingerprint({
    model: 'gemini-4-argon',
    effort: 'high',
    isToolStep: true,
    priorBlockAlignedCount: 2,
    prevCacheRead: 18432,
    prevTotalInput: 21589,
    cwmEstTokens: 27824,
    // Same shape as idx2 but with zero thinking under high effort and TTFT < 6s.
    step: {
      inputTokens: 3157, cachedReadTokens: 18432, outputTokens: 141, thoughtTokens: 0,
      textOutTokens: 68, ttftSeconds: 1.2973, streamSeconds: 0.0543, wallSeconds: 1.3516,
    },
  })

  assert.equal(corroborated.evaluated, true)
  assert.equal(corroborated.degraded, true)
  assert.equal(corroborated.score, 6)
  assert.deepEqual(corroborated.signals.map(signal => signal.kind), ['block_cache', 'shallow_thought'])
  assert.equal(corroborated.signals[1].points, 3)
})

test('hard 128K head-slice truncation still degrades', () => {
  const truncated = evaluateDegradeFingerprint({
    model: 'gemini-4-argon',
    effort: 'high',
    cwmEstTokens: 378_421,
    step: {
      inputTokens: 3069, cachedReadTokens: 124928, outputTokens: 90, thoughtTokens: 15,
      textOutTokens: 75, ttftSeconds: 3.1, streamSeconds: 0.4, wallSeconds: 3.5,
    },
  })

  assert.equal(truncated.evaluated, true)
  assert.equal(truncated.contextTokens, 127_997)
  assert.equal(truncated.degraded, true)
  assert.ok(truncated.signals.some(signal => signal.kind === 'context_truncated'))
  assert.equal(truncated.signals.find(signal => signal.kind === 'context_truncated').points, 5)
})

test('a cold-start first step with no cache read and a fast decode degrades on its own', () => {
  // Session a9eef35e, first step: nothing cached, yet 719 text tokens in 2.76s after a 3.64s TTFT.
  const cold = evaluateDegradeFingerprint({
    model: 'gemini-4-argon',
    cwmEstTokens: 23_719,
    step: {
      inputTokens: 17_688, cachedReadTokens: 0, outputTokens: 1_708, thoughtTokens: 989,
      textOutTokens: 719, ttftSeconds: 3.64, streamSeconds: 2.76, wallSeconds: 6.4,
    },
  })

  assert.equal(cold.evaluated, true)
  assert.equal(cold.degraded, true)
  assert.equal(cold.score, 3)
  assert.equal(cold.signals.find(signal => signal.kind === 'fast_decode').points, 3)
})
