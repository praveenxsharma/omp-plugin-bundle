// Unit tests of `resolveModelQuota`: which windows govern one model on one
// account, and when an account must report "not entitled" instead of borrowing
// another family's pool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quotaFamilyFor, resolveModelQuota } from '../lib/quota.js'

/** Weekly bucket of one group. */
const weekly = (fraction, id = 'weekly') => ({ id, name: 'Weekly', window: 'weekly', remainingFraction: fraction, resetTime: '2026-11-14T00:00:00Z' })

/** Snapshot literal with only the fields one test needs. */
const snapshot = (fields) => ({ status: 'ok', updatedAt: '2026-11-09T00:00:00.000Z', groups: [], ...fields })

const proGroups = () => [
  { kind: 'gemini', name: 'Gemini 3.8 Flash', description: '', buckets: [weekly(1, 'gemini-weekly')] },
  { kind: 'claude', name: 'Claude 4.6 / GPT', description: '', buckets: [weekly(1, '3p-weekly')] },
]

test('quotaFamilyFor keeps Argon out of the Gemini family', () => {
  assert.equal(quotaFamilyFor('gemini-4-argon'), 'argon')
  assert.equal(quotaFamilyFor('gemini-4-argon-high'), 'argon')
  assert.equal(quotaFamilyFor('gemini-3.8-flash'), 'gemini')
  assert.equal(quotaFamilyFor('claude-opus-5-5'), 'claude')
  assert.equal(quotaFamilyFor('gpt-oss-120b-medium'), 'claude')
})

test('a Pro account that disables Argon reports no entitlement instead of its untouched Gemini pool', () => {
  const pro = snapshot({
    subscriptionTier: 'PRO',
    subscriptionName: 'Google AI Pro',
    disabledModels: ['gemini-4-argon'],
    availableModels: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    ],
    groups: proGroups(),
  })
  const focus = resolveModelQuota(pro, 'gemini-4-argon')
  assert.equal(focus.family, 'argon')
  assert.equal(focus.entitled, false)
  assert.equal(focus.reason, 'model-not-entitled')
  assert.equal(focus.group, undefined, 'the Gemini pool must never stand in for Argon')

  // The same account still reports its own Gemini windows for a model it may spend.
  const flash = resolveModelQuota(pro, 'gemini-3.8-flash')
  assert.equal(flash.entitled, true)
  assert.equal(flash.group.buckets[0].remainingFraction, 1)
})

test('a Pro plan without an explicit model list still denies Argon by tier', () => {
  const focus = resolveModelQuota(snapshot({ subscriptionTier: 'PRO', groups: proGroups() }), 'gemini-4-argon')
  assert.equal(focus.entitled, false)
  assert.equal(focus.reason, 'model-not-entitled')
})

test('a Pro account with its own Argon bucket uses that bucket', () => {
  const pro = snapshot({
    subscriptionTier: 'PRO',
    groups: [
      ...proGroups(),
      { kind: 'argon', name: 'Gemini 4 Argon', description: '', buckets: [weekly(0.42, 'gemini-argon-wtu-weekly')] },
    ],
  })
  const focus = resolveModelQuota(pro, 'gemini-4-argon')
  assert.equal(focus.entitled, true)
  assert.equal(focus.group.buckets[0].remainingFraction, 0.42)
  assert.equal(focus.group.kind, 'argon')
})

test('an Ultra account shares the Gemini pool with Argon', () => {
  const ultra = snapshot({
    subscriptionTier: 'ULTRA',
    subscriptionName: 'Google AI Ultra',
    argonSharedWithGemini: true,
    availableModels: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    groups: [{ kind: 'gemini', name: 'Gemini 4 Argon / 3.8', description: '', buckets: [weekly(0.98)] }],
  })
  const focus = resolveModelQuota(ultra, 'gemini-4-argon')
  assert.equal(focus.entitled, true)
  assert.equal(focus.group.buckets[0].remainingFraction, 0.98)
})

test('a legacy snapshot without entitlements keeps trusting its family group', () => {
  const legacy = snapshot({ groups: [{ kind: 'gemini', name: 'Gemini Models', description: '', buckets: [weekly(0.68)] }] })
  const focus = resolveModelQuota(legacy, 'gemini-4-argon')
  assert.equal(focus.entitled, true)
  assert.equal(focus.group.buckets[0].remainingFraction, 0.68)
})

test('Claude and Gemini never borrow each other’s windows', () => {
  const ultra = snapshot({
    subscriptionTier: 'ULTRA',
    groups: [{ kind: 'gemini', name: 'Gemini 4 Argon / 3.8', description: '', buckets: [weekly(0.98)] }],
  })
  const claude = resolveModelQuota(ultra, 'claude-opus-5-5')
  assert.equal(claude.entitled, false)
  assert.equal(claude.reason, 'no-groups')
  assert.equal(claude.group, undefined)

  const claudeOnly = snapshot({
    subscriptionTier: 'ULTRA',
    groups: [{ kind: 'claude', name: 'Claude 4.6 / GPT', description: '', buckets: [weekly(0.5, '3p-weekly')] }],
  })
  const gemini = resolveModelQuota(claudeOnly, 'gemini-3.8-flash')
  assert.equal(gemini.entitled, false, 'a Claude-only payload must not answer a Gemini model')
  assert.equal(gemini.group, undefined)
})
