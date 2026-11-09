// Unit tests for Cloud Code PA tier resolution, Argon eligibility, regional /
// student Pro Claude 4.6 vs 5.5 inventories, and Pro independent Argon weekly buckets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkArgonEligibility,
  deriveAccountModels,
  inspectCloudCodeAccount,
  normalizeCloudCodeQuotaGroups,
  normalizeSubscriptionTier,
  parseLoadCodeAssist,
  parseStoredOAuthCredential,
  readAccountOAuthCredential,
} from '../lib/cloudcode.js'
import { groupForModel } from '../lib/quota.js'

test('normalizeSubscriptionTier and parseLoadCodeAssist prioritize paidTier and never guess PRO from unknown strings', () => {
  assert.equal(normalizeSubscriptionTier('g1-ultra-tier'), 'ULTRA')
  assert.equal(normalizeSubscriptionTier('GOOGLE_ONE_HELIUM'), 'ULTRA')
  assert.equal(normalizeSubscriptionTier('g1-pro-tier'), 'PRO')
  assert.equal(normalizeSubscriptionTier('Google AI Pro'), 'PRO')
  assert.equal(normalizeSubscriptionTier('free-tier'), 'FREE')
  assert.equal(normalizeSubscriptionTier('Antigravity Starter Quota'), 'FREE')
  assert.equal(normalizeSubscriptionTier('standard-tier'), 'ENTERPRISE')
  assert.equal(normalizeSubscriptionTier('GCP_ENTERPRISE_TIER'), 'ENTERPRISE')
  assert.equal(normalizeSubscriptionTier('unrecognized-tier'), 'FREE')
  assert.equal(normalizeSubscriptionTier(undefined), 'FREE')

  const ultra = parseLoadCodeAssist({
    cloudaicompanionProject: 'aicode-consumers',
    currentTier: { id: 'free-tier', name: 'Antigravity' },
    paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
  })
  assert.deepEqual(ultra, {
    projectId: 'aicode-consumers',
    subscriptionTier: 'ULTRA',
    subscriptionName: 'Google AI Ultra',
  })

  const pro = parseLoadCodeAssist({
    cloudaicompanionProject: 'aicode-consumers',
    currentTier: { id: 'free-tier', name: 'Antigravity' },
    paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
  })
  assert.deepEqual(pro, {
    projectId: 'aicode-consumers',
    subscriptionTier: 'PRO',
    subscriptionName: 'Google AI Pro',
  })

  const free = parseLoadCodeAssist({
    currentTier: { id: 'free-tier', name: 'Antigravity Starter Quota' },
  })
  assert.equal(free.subscriptionTier, 'FREE')
})

test('Ultra account shares Gemini pool with Argon and exposes Claude 5.5 + Argon', () => {
  const summaryGroups = [
    {
      displayName: 'Gemini Models',
      description: '',
      buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.82, resetTime: '2026-11-14T02:58:38Z' },
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.85, resetTime: '2026-11-08T11:50:30Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: '',
      buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0, resetTime: '2026-11-10T00:57:18Z' },
        { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T15:08:04Z' },
      ],
    },
  ]
  const fetchAvailable = {
    agentModelSorts: [{
      displayName: 'Recommended',
      groups: [{
        modelIds: [
          'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
          'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
          'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
          'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
          'gpt-oss-120b-medium',
        ],
      }],
    }],
    models: {
      'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)', maxTokens: 1048576 },
      'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', maxTokens: 1048576 },
      'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', maxTokens: 1048576 },
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
      'gemini-3.8-flash-medium': { displayName: 'Gemini 3.8 Flash (Medium)', maxTokens: 1048576 },
      'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1048576 },
      'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', maxTokens: 1000000 },
      'claude-opus-5-5-medium': { displayName: 'Claude Opus 5.5 (Medium)', maxTokens: 1000000 },
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000 },
      'claude-sonnet-5-5-low': { displayName: 'Claude Sonnet 5.5 (Low)', maxTokens: 1000000 },
      'claude-sonnet-5-5-medium': { displayName: 'Claude Sonnet 5.5 (Medium)', maxTokens: 1000000 },
      'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', maxTokens: 1000000 },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072 },
    },
  }

  const derived = deriveAccountModels(fetchAvailable, summaryGroups, 'ULTRA')
  assert.equal(derived.argonEligible, true)
  assert.deepEqual(derived.models.map(m => m.id), [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-oss-120b-medium',
  ])
  assert.deepEqual(derived.effortsByModel['gemini-4-argon'], ['low', 'medium', 'high'])
  assert.deepEqual(derived.effortsByModel['gpt-oss-120b-medium'], [])

  const normalized = normalizeCloudCodeQuotaGroups(summaryGroups, derived.models, derived.rawModels, 'ULTRA', derived.argonEligible)
  assert.equal(normalized.argonSharedWithGemini, true)
  assert.equal(normalized.groups.length, 2)
  assert.equal(normalized.groups[0].name, 'Gemini 4 Argon / 3.8')
  assert.equal(normalized.groups[1].name, 'Claude 5.5 / GPT')
  assert.equal(normalized.groups[1].buckets.find(b => b.id === '3p-5h').disabled, true, 'exhausted 3p-weekly disables 3p-5h')
  assert.equal(groupForModel(normalized.groups, 'gemini-4-argon').name, 'Gemini 4 Argon / 3.8')
})

test('Standard Pro account with dedicated Argon weekly bucket keeps Argon separate from Gemini 3.8', () => {
  const summaryGroups = [
    {
      displayName: 'Gemini Models',
      description: '',
      buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-14T00:00:00Z' },
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.78, resetTime: '2026-11-08T12:00:00Z' },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      description: 'Pro Argon weekly cap',
      buckets: [
        { id: 'gemini-argon-wtu-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.41, resetTime: '2026-11-14T00:00:00Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: '',
      buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.65, resetTime: '2026-11-14T00:00:00Z' },
        { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.88, resetTime: '2026-11-08T12:00:00Z' },
      ],
    },
  ]
  const fetchAvailable = {
    agentModelSorts: [{
      groups: [{
        modelIds: [
          'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
          'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
          'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
          'gpt-oss-120b-medium',
        ],
      }],
    }],
    models: {
      'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', maxTokens: 1048576 },
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
      'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000 },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072 },
    },
  }

  const derived = deriveAccountModels(fetchAvailable, summaryGroups, 'PRO')
  assert.equal(derived.argonEligible, true)
  const normalized = normalizeCloudCodeQuotaGroups(summaryGroups, derived.models, derived.rawModels, 'PRO', derived.argonEligible)
  assert.equal(normalized.argonSharedWithGemini, false)
  assert.deepEqual(normalized.groups.map(g => ({ kind: g.kind, name: g.name })), [
    { kind: 'gemini', name: 'Gemini 3.8 Flash' },
    { kind: 'argon', name: 'Gemini 4 Argon' },
    { kind: 'claude', name: 'Claude 5.5 / GPT' },
  ])
  assert.equal(groupForModel(normalized.groups, 'gemini-4-argon').kind, 'argon')
  assert.equal(groupForModel(normalized.groups, 'gemini-4-argon').buckets[0].remainingFraction, 0.41)
  assert.equal(groupForModel(normalized.groups, 'gemini-3.8-flash').kind, 'gemini')
  assert.equal(groupForModel(normalized.groups, 'gemini-3.8-flash').buckets[0].remainingFraction, 0.9)
})

test('Jio / Student Pro account without Argon or Claude 5.5 reports Claude 4.6 and marks Argon disabled', () => {
  const summaryGroups = [
    {
      displayName: 'Gemini Models',
      description: '',
      buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.998, resetTime: '2026-11-14T03:04:13Z' },
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T15:08:11Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: '',
      buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-15T10:08:11Z' },
        { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-08T15:08:11Z' },
      ],
    },
  ]
  const fetchAvailable = {
    agentModelSorts: [{
      displayName: 'Recommended',
      groups: [{
        modelIds: [
          'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
          'claude-sonnet-4-6',
          'claude-opus-4-6-thinking',
          'gpt-oss-120b-medium',
          'gemini-4-argon-disabled',
        ],
      }],
    }],
    models: {
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
      'gemini-3.8-flash-medium': { displayName: 'Gemini 3.8 Flash (Medium)', maxTokens: 1048576 },
      'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1048576 },
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6 (Thinking)', maxTokens: 250000 },
      'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 (Thinking)', maxTokens: 250000 },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072 },
      'gemini-4-argon-disabled': { displayName: 'Gemini 4 Argon', disabled: true, maxTokens: 1048576 },
    },
  }

  assert.equal(checkArgonEligibility(summaryGroups, [], 'PRO'), false)
  const derived = deriveAccountModels(fetchAvailable, summaryGroups, 'PRO')
  assert.equal(derived.argonEligible, false)
  assert.deepEqual(derived.disabledModels, ['gemini-4-argon'])
  assert.deepEqual(derived.models.map(m => m.id), [
    'gemini-3.8-flash',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium',
  ])
  assert.deepEqual(derived.effortsByModel['claude-opus-4-6-thinking'], [])
  assert.equal(derived.maxTokensByModel['claude-opus-4-6-thinking'], 250000)

  const normalized = normalizeCloudCodeQuotaGroups(summaryGroups, derived.models, derived.rawModels, 'PRO', derived.argonEligible)
  assert.deepEqual(normalized.groups.map(g => ({ kind: g.kind, name: g.name })), [
    { kind: 'gemini', name: 'Gemini 3.8 Flash' },
    { kind: 'claude', name: 'Claude 4.6 / GPT' },
  ])
})

test('inspectCloudCodeAccount refreshes expired OAuth tokens and falls back from Daily to Sandbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cloudcode-'))
  const appDir = join(root, 'agy')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'antigravity-oauth-token'), JSON.stringify({
    id_token_email: 'student@example.edu',
    token: {
      access_token: 'expired-tok',
      refresh_token: 'refresh-tok',
      expiry: new Date(Date.now() - 60_000).toISOString(),
    },
  }))
  const layout = {
    id: 'acc-1',
    label: '',
    root,
    declaredHome: '',
    homeDir: join(root, 'home'),
    geminiDir: root,
    appDir,
    workspace: join(root, 'ws'),
    logFile: join(root, 'acp.log'),
    env: {},
    contextWindow: 0,
    visibleModels: [],
    enabled: true,
    system: false,
  }

  const seenUrls = []
  const seenAuth = []
  const result = await inspectCloudCodeAccount({
    layout,
    platform: 'linux',
    runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    transport: async (url, headers) => {
      seenUrls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        return { status: 200, body: { access_token: 'fresh-tok' } }
      }
      seenAuth.push(headers.authorization)
      if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
        return { status: 503, body: 'unavailable' }
      }
      if (url.endsWith(':loadCodeAssist')) {
        return { status: 200, body: { cloudaicompanionProject: 'proj-1', paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return {
          status: 200,
          body: {
            groups: [{
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-15T00:00:00Z' }],
            }],
          },
        }
      }
      if (url.endsWith(':fetchAvailableModels')) {
        return {
          status: 200,
          body: {
            agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium'] }] }],
            models: {
              'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
              'gemini-3.8-flash-medium': { displayName: 'Gemini 3.8 Flash (Medium)', maxTokens: 1048576 },
            },
          },
        }
      }
      throw new Error(`unexpected ${url}`)
    },
  })

  assert.ok(result)
  assert.equal(result.subscriptionTier, 'PRO')
  assert.equal(result.subscriptionName, 'Google AI Pro')
  assert.ok(seenAuth.every(a => a === 'Bearer fresh-tok'))
  assert.ok(seenUrls.some(u => u.startsWith('https://daily-cloudcode-pa.sandbox.googleapis.com')))
  assert.deepEqual(result.models.map(m => m.id), ['gemini-3.8-flash'])
})

test('parseStoredOAuthCredential unwraps go-keyring-base64 with a nested token, and the reader falls back to the token file', async () => {
  const blob = `go-keyring-base64:${Buffer.from(JSON.stringify({
    id_token_email: 'nested@example.com',
    token: { access_token: ' acc ', refresh_token: 'ref', expiry: '2026-11-09T00:00:00Z' },
  })).toString('base64')}\n`
  assert.deepEqual(parseStoredOAuthCredential(blob), {
    accessToken: 'acc',
    refreshToken: 'ref',
    expiryMs: Date.parse('2026-11-09T00:00:00Z'),
    email: 'nested@example.com',
  })
  assert.equal(parseStoredOAuthCredential(''), undefined)
  assert.equal(parseStoredOAuthCredential(JSON.stringify({ token: { access_token: '' } })), undefined)

  const root = mkdtempSync(join(tmpdir(), 'agy-cloudcode-'))
  const appDir = join(root, 'agy')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'antigravity-oauth-token'), JSON.stringify({ access_token: 'file-tok' }))
  const stored = await readAccountOAuthCredential(
    { system: false, homeDir: join(root, 'home'), appDir },
    async () => ({ code: 0, stdout: 'not json', stderr: '' }),
    'darwin',
  )
  assert.ok(stored)
  assert.equal(stored.accessToken, 'file-tok')
})
