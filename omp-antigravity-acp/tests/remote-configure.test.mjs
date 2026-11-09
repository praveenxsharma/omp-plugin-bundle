// Unit tests of the configure wire shape and its persistence: the request
// carries the whole account list (this Mac's `system: true` row included), a
// save never freezes the machine display label into a remark, and the retired
// `systemProfile` / `useSystemAccount` / per-account `families` fields are
// ignored rather than resurrected.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AntigravityRemote, parseConfigureRequest, profileFromStatus, storedAccounts } from '../lib/remote.js'

/** One account as a configure request spells it. */
const profile = (id, extra = {}) => ({
  id,
  displayName: '',
  home: '',
  enabled: true,
  env: {},
  contextWindow: 0,
  visibleModels: [],
  priority: 1,
  weight: 1,
  ...extra,
})

/** One row as the runtime reports it back. */
const row = (id, extra = {}) => ({
  id,
  label: '',
  system: false,
  enabled: true,
  root: undefined,
  home: '',
  env: {},
  homeDir: '',
  geminiDir: '',
  state: 'idle',
  error: undefined,
  cooldowns: [],
  sessions: 0,
  email: undefined,
  contextWindow: 0,
  visibleModels: [],
  priority: 1,
  weight: 1,
  proxyUrl: '',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ...extra,
})

const machineRow = (extra = {}) => row('default', {
  label: 'This Mac',
  system: true,
  env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
  contextWindow: 512_000,
  visibleModels: ['claude-opus-5-5'],
  priority: 2,
  weight: 5,
  ...extra,
})

test('a configure request carries the whole account list with the machine row in it', () => {
  const parsed = parseConfigureRequest({
    accounts: [
      profile('default', { system: true, contextWindow: 256_000 }),
      profile('work', { displayName: 'Work' }),
    ],
  })
  assert.equal(parsed.accounts.length, 2)
  assert.equal(parsed.accounts[0].id, 'default')
  assert.equal(parsed.accounts[0].system, true)
  assert.equal(parsed.accounts[0].contextWindow, 256_000)
  assert.equal(parsed.accounts[1].id, 'work')
  assert.equal(parsed.accounts[1].system, undefined, 'a declared account carries no system marker')
  assert.equal(parsed.accounts[1].displayName, 'Work')
})

test('a configure request ignores the retired systemProfile and useSystemAccount fields', () => {
  const parsed = parseConfigureRequest({
    accounts: [profile('work')],
    systemProfile: { env: { HTTPS_PROXY: 'http://p' }, contextWindow: 128_000, visibleModels: ['gemini-4-argon'], priority: 3, weight: 4 },
    useSystemAccount: false,
  })
  assert.equal(Object.hasOwn(parsed, 'systemProfile'), false, 'the retired field is not passed on')
  assert.equal(Object.hasOwn(parsed, 'useSystemAccount'), false, 'the retired switch is not passed on')
  assert.equal(parsed.accounts.length, 1, 'the list is exactly what the page declared')
  assert.equal(parsed.accounts[0].id, 'work')
  assert.equal(parsed.accounts[0].contextWindow, 0, 'the retired profile never edits an account')
})

test('a configure request ignores a retired per-account families gate', () => {
  const parsed = parseConfigureRequest({ accounts: [{ id: 'work', families: ['gemini'] }] })
  assert.equal(Object.hasOwn(parsed.accounts[0], 'families'), false)
  assert.deepEqual(parsed.accounts[0].visibleModels, [], 'families no longer narrows a model list')
  const kept = parseConfigureRequest({ accounts: [{ id: 'work', families: [], visibleModels: ['claude-opus-5-5'] }] })
  assert.deepEqual(kept.accounts[0].visibleModels, ['claude-opus-5-5'])
})

test('a request that touches no account leaves the list alone', () => {
  const parsed = parseConfigureRequest({ contextWindow: 900_000 })
  assert.equal(parsed.accounts, undefined)
  assert.equal(parsed.contextWindow, 900_000)
})

test('stored accounts keep the machine row and never freeze its display label', () => {
  const stored = storedAccounts([
    machineRow(),
    row('work', { label: 'Work', home: '/custom/work', contextWindow: 128_000, visibleModels: ['gemini-4-argon'] }),
  ])
  assert.deepEqual(stored.map(entry => [entry.id, entry.system === true]), [['default', true], ['work', false]])
  assert.equal(stored[0].displayName, '', 'the default label is not a remark the user chose')
  assert.deepEqual(stored[0].visibleModels, ['claude-opus-5-5'])
  assert.equal(stored[1].home, '/custom/work')
  assert.deepEqual(stored[1].visibleModels, ['gemini-4-argon'])
})

test('a renamed machine row round-trips its remark', () => {
  const stored = storedAccounts([machineRow({ label: '公司本机' })])
  assert.equal(stored[0].displayName, '公司本机')
  assert.equal(stored[0].system, true)
  assert.equal(profileFromStatus(machineRow()).system, true)
})

/** Minimal status rows for a runtime stub that echoes the accounts it was given. */
const statusRows = (accounts) => accounts.map(entry => row(entry.id, {
  label: entry.system === true && entry.displayName === '' ? 'This Mac' : entry.displayName,
  system: entry.system === true,
  home: entry.home,
  env: { ...entry.env },
  contextWindow: entry.contextWindow,
  visibleModels: [...entry.visibleModels],
  priority: entry.priority ?? 1,
  weight: entry.weight ?? 1,
}))

/** Status the runtime reports after a patch. */
const statusOf = (accounts) => ({
  state: 'idle', contextWindow: 0, configuredContextWindow: 0, defaultEffort: 'high',
  longDecodeContinuations: 3, models: [], availableModels: [], visibleModels: [], efforts: [],
  liveSessions: 0, activeTurns: 0, accounts: statusRows(accounts),
})

/** A remote over a runtime stub that records the patch and echoes its list. */
const mountRemote = (currentRows) => {
  const writes = []
  const ctx = { get: (name) => name === 'settings' ? { writable: true, update: async (_ns, values) => { writes.push(values) } } : undefined }
  const patches = []
  const runtime = {
    accounts: () => currentRows,
    configure: (next) => {
      patches.push(next)
      return statusOf(next.accounts ?? currentRows.map(entry => profileFromStatus(entry)))
    },
  }
  return { remote: new AntigravityRemote(ctx, { runtime, settingsNs: 'omp-antigravity-acp' }), patches, writes }
}

test('remote.configure applies and persists the whole list, machine row included', async () => {
  const { remote, patches, writes } = mountRemote([machineRow(), row('work', { label: 'Work' })])
  await remote.configure({
    accounts: [
      profile('default', { system: true, contextWindow: 256_000 }),
      profile('work', { displayName: 'Work' }),
    ],
  })

  assert.deepEqual(patches[0].accounts.map(entry => [entry.id, entry.system === true]), [
    ['default', true],
    ['work', false],
  ], 'the runtime sees the machine row the page declared')
  assert.equal(patches[0].accounts[0].contextWindow, 256_000)

  assert.equal(writes.length, 1)
  const stored = writes[0]
  assert.deepEqual(stored.accounts.map(entry => [entry.id, entry.system === true]), [
    ['default', true],
    ['work', false],
  ], 'the stored profile keeps this Mac login')
  assert.equal(Object.hasOwn(stored, 'systemProfile'), false, 'the retired key is never written again')
  assert.equal(Object.hasOwn(stored, 'useSystemAccount'), false)
  assert.equal(stored.accounts[0].displayName, '', 'the machine display label is not stored as a remark')
})

test('remote.configure stores a list without the machine row when the page removed it', async () => {
  const { remote, patches, writes } = mountRemote([machineRow(), row('work', { label: 'Work' })])
  await remote.configure({ accounts: [profile('work', { displayName: 'Work' })] })

  assert.deepEqual(patches[0].accounts.map(entry => entry.id), ['work'], 'the runtime drops the machine account')
  assert.deepEqual(writes[0].accounts.map(entry => entry.id), ['work'], 'the stored list drops it too')
})

test('remote.configure persists nothing when the request touches no account', async () => {
  const { remote, writes } = mountRemote([machineRow()])
  await remote.configure({ contextWindow: 900_000 })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].accounts, undefined)
  assert.equal(writes[0].contextWindow, 900_000)
})
