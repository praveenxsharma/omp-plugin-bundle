// Unit tests of the one-shot config migration: account families fold into
// visibleModels, the machine account moves into the account list once, and the
// whole transform is pure and idempotent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_VERSION, migrateConfig } from '../lib/migrate.js'

const CATALOG = [
  'gemini-4-argon',
  'gemini-3.8-flash',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b-medium',
]

// A stored account after the migration, which no longer carries `families`.
const account = (id, extra = {}) => ({
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

const machineAccount = (extra = {}) => ({
  id: 'default',
  system: true,
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

/** Deep-freeze a value so any in-place write inside the migration throws. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Run the migration twice, asserting purity and idempotency on the way.
 * @param raw - stored config of one case.
 * @param catalog - catalog ids for the run.
 * @returns the first result.
 */
function migrateTwice(raw, catalog = CATALOG) {
  const snapshot = structuredClone(raw)
  const first = migrateConfig(raw, catalog)
  assert.deepEqual(raw, snapshot, 'migrateConfig must not modify its input')
  const second = migrateConfig(first.config, catalog)
  assert.deepEqual(second.config, first.config, 'the migration must be idempotent')
  assert.equal(second.changed, false, 'a second run must report changed === false')
  return first
}

test('the migration writes the merged config version', () => {
  assert.equal(CONFIG_VERSION, 2)
  assert.equal(migrateConfig({}, CATALOG).config.configVersion, 2)
})

test('an empty configuration gains the machine account and reports a change', () => {
  const result = migrateTwice({})
  assert.equal(result.changed, true)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.config, { configVersion: 2, accounts: [machineAccount()] })
})

test('an empty configuration is reported as a change even without any other key', () => {
  const result = migrateConfig({}, CATALOG)
  assert.equal(result.changed, true)
  assert.equal(result.config.accounts.length, 1)
})

test('a missing useSystemAccount adds the machine account', () => {
  const result = migrateTwice({ provider: 'antigravity' })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config, {
    provider: 'antigravity',
    configVersion: 2,
    accounts: [machineAccount()],
  })
})

test('useSystemAccount true adds the machine account and keeps unrelated keys', () => {
  const result = migrateTwice({ useSystemAccount: true, maxLiveSessions: 3, provider: 'antigravity' })
  assert.equal(result.changed, true)
  assert.equal(result.config.maxLiveSessions, 3)
  assert.equal(result.config.provider, 'antigravity')
  assert.equal(result.config.configVersion, 2)
  assert.deepEqual(result.config.accounts, [machineAccount()])
  assert.equal(Object.hasOwn(result.config, 'useSystemAccount'), false)
})

test('useSystemAccount false adds nothing, drops the switch, and records the version', () => {
  const result = migrateTwice({ useSystemAccount: false })
  assert.equal(result.changed, true)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.config, { configVersion: 2 })
  const again = migrateConfig(result.config, CATALOG)
  assert.equal(again.config.accounts, undefined)
  assert.equal(again.changed, false)
})

test('useSystemAccount false drops systemProfile without generating an account', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    systemProfile: { env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, contextWindow: 256_000 },
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config, { configVersion: 2 })
})

test('a missing systemProfile falls back to the schema defaults', () => {
  const result = migrateTwice({ accounts: [], useSystemAccount: true })
  assert.equal(result.config.configVersion, 2)
  assert.deepEqual(result.config.accounts, [machineAccount()])
  assert.deepEqual(result.config.accounts[0].env, {})
  assert.equal(result.config.accounts[0].contextWindow, 0)
  assert.equal(result.config.accounts[0].priority, 1)
  assert.equal(result.config.accounts[0].weight, 1)
})

test('systemProfile values move into the machine account', () => {
  const result = migrateTwice({
    systemProfile: {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      contextWindow: 512_000,
      families: [],
      visibleModels: ['claude-opus-5-5'],
      priority: 2,
      weight: 5,
    },
  })
  assert.equal(result.changed, true)
  assert.equal(result.config.configVersion, 2)
  assert.deepEqual(result.config.accounts, [machineAccount({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    contextWindow: 512_000,
    visibleModels: ['claude-opus-5-5'],
    priority: 2,
    weight: 5,
  })])
  assert.equal(Object.hasOwn(result.config, 'systemProfile'), false)
  assert.deepEqual(result.warnings, [])
})

test('machine account families are converted like any other account', () => {
  const result = migrateTwice({
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5'],
    systemProfile: { families: ['gemini'] },
  })
  assert.deepEqual(result.config.accounts, [machineAccount({ visibleModels: ['gemini-4-argon'] })])
  assert.equal(Object.hasOwn(result.config.accounts[0], 'families'), false)
  assert.deepEqual(result.warnings, [])
})

test('an empty families list is dropped and visibleModels is kept', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    accounts: [account('work', { families: [], visibleModels: ['claude-opus-5-5'] })],
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config.accounts, [account('work', { visibleModels: ['claude-opus-5-5'] })])
  assert.equal(Object.hasOwn(result.config.accounts[0], 'families'), false)
  assert.deepEqual(result.warnings, [])
})

test('a version 2 configuration without a system entry is left alone', () => {
  const raw = { configVersion: 2, accounts: [{ id: 'work', visibleModels: [] }] }
  const result = migrateTwice(raw)
  assert.equal(result.changed, false)
  assert.deepEqual(result.config, raw)
  assert.deepEqual(result.warnings, [])
})

test('a version 1 configuration is migrated like an older one', () => {
  const result = migrateTwice({ configVersion: 1, accounts: [] })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config, { configVersion: 2, accounts: [machineAccount()] })
})

test('a version 2 configuration keeps an existing system entry as it is', () => {
  const result = migrateTwice({
    configVersion: 2,
    useSystemAccount: true,
    systemProfile: { contextWindow: 256_000 },
    accounts: [account('default', { system: true, displayName: 'This machine' })],
  })
  assert.equal(result.changed, true)
  assert.equal(result.config.accounts.length, 1)
  assert.equal(result.config.accounts[0].displayName, 'This machine')
  assert.equal(Object.hasOwn(result.config, 'systemProfile'), false)
  assert.equal(Object.hasOwn(result.config, 'useSystemAccount'), false)
  assert.deepEqual(result.warnings, [])
})

test('a version 2 configuration drops schema defaults without adding the machine account', () => {
  const result = migrateTwice({
    configVersion: 2,
    useSystemAccount: true,
    systemProfile: {},
    accounts: [],
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config, { configVersion: 2, accounts: [] })
  assert.deepEqual(result.warnings, [])
})

test('a version 2 configuration still folds lingering families', () => {
  const result = migrateTwice({
    configVersion: 2,
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5'],
    accounts: [account('work', { families: ['gemini'] })],
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config.accounts, [account('work', { visibleModels: ['gemini-4-argon'] })])
  assert.deepEqual(result.warnings, [])
})

test('families expand against the provider allowlist without a warning', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5', 'gpt-oss-120b-medium'],
    accounts: [account('work', { families: ['gemini'] })],
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config.accounts, [account('work', { visibleModels: ['gemini-4-argon'] })])
  assert.deepEqual(result.warnings, [])
})

test('families fall back to the catalog with a warning when the provider lists nothing', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    accounts: [account('work', { families: ['claude'] })],
  })
  assert.deepEqual(result.config.accounts, [account('work', {
    visibleModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  })])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /work/)
  assert.match(result.warnings[0], /catalog/)
})

test('family ids are normalized the way accountFamilies does', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5'],
    accounts: [account('work', { families: ['nope'] })],
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.config.accounts, [account('work', { visibleModels: [] })])
  assert.equal(Object.hasOwn(result.config.accounts[0], 'families'), false)
  assert.deepEqual(result.warnings, [])
})

test('an existing account visibleModels intersects the families expansion', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    visibleModels: ['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5'],
    accounts: [account('work', {
      families: ['gemini'],
      visibleModels: ['claude-opus-5-5', 'gemini-3.8-flash'],
    })],
  })
  assert.deepEqual(result.config.accounts, [account('work', { visibleModels: ['gemini-3.8-flash'] })])
  assert.deepEqual(result.warnings, [])
})

test('an empty intersection keeps families and warns instead of widening', () => {
  const result = migrateTwice({
    useSystemAccount: false,
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5'],
    accounts: [account('work', { families: ['gemini'], visibleModels: ['claude-opus-5-5'] })],
  })
  assert.equal(result.changed, true)
  assert.equal(result.config.configVersion, 2)
  assert.equal(Object.hasOwn(result.config, 'useSystemAccount'), false)
  assert.deepEqual(result.config.accounts, [account('work', {
    families: ['gemini'],
    visibleModels: ['claude-opus-5-5'],
  })])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /work/)
})

test('an intersection emptied by the catalog also keeps families and warns', () => {
  const result = migrateTwice(
    { useSystemAccount: false, accounts: [account('work', { families: ['gpt-oss'], visibleModels: ['claude-opus-5-5'] })] },
    ['claude-opus-5-5'],
  )
  assert.deepEqual(result.config.accounts, [account('work', {
    families: ['gpt-oss'],
    visibleModels: ['claude-opus-5-5'],
  })])
  assert.equal(result.warnings.length, 2)
})

test('a declared account with the id default blocks the machine account', () => {
  const result = migrateTwice({
    systemProfile: { contextWindow: 256_000 },
    accounts: [account('default', { displayName: 'Work' })],
  })
  assert.equal(result.config.accounts.length, 1)
  assert.equal(Object.hasOwn(result.config.accounts[0], 'system'), false)
  assert.equal(Object.hasOwn(result.config, 'systemProfile'), false)
  assert.equal(Object.hasOwn(result.config, 'useSystemAccount'), false)
  assert.equal(result.config.configVersion, 2)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /default/)
})

test('the machine account lands at the head of the existing list', () => {
  const result = migrateTwice({
    accounts: [account('work'), account('home', { displayName: 'Home' })],
  })
  assert.deepEqual(result.config.accounts.map(entry => entry.id), ['default', 'work', 'home'])
})

test('every shape of the migration is idempotent', () => {
  const cases = [
    {},
    { configVersion: 2 },
    { useSystemAccount: false },
    { useSystemAccount: true },
    { configVersion: 2, useSystemAccount: true, systemProfile: {}, accounts: [] },
    { configVersion: 2, accounts: [account('work', { families: ['gemini'] })] },
    { useSystemAccount: false, accounts: [account('work', { families: ['gemini'] })] },
    { visibleModels: ['gemini-4-argon'], accounts: [account('work', { families: ['claude'] })] },
    { accounts: [account('default')] },
    { accounts: [account('default', { system: true })] },
    { systemProfile: { families: ['gemini'], visibleModels: ['gemini-4-argon'] } },
    { useSystemAccount: false, visibleModels: ['claude-opus-5-5'], accounts: [account('work', { families: ['gemini'], visibleModels: ['claude-opus-5-5'] })] },
    { accounts: [] },
    { configVersion: 2, accounts: [] },
  ]
  for (const raw of cases) {
    const first = migrateConfig(raw, CATALOG)
    const snapshot = structuredClone(first.config)
    const second = migrateConfig(first.config, CATALOG)
    assert.deepEqual(second.config, snapshot, `idempotency failed for ${JSON.stringify(raw)}`)
    assert.equal(second.changed, false, `changed flag failed for ${JSON.stringify(raw)}`)
  }
})

test('migrateConfig leaves a frozen input untouched', () => {
  const raw = deepFreeze({
    provider: 'antigravity',
    visibleModels: ['gemini-4-argon', 'claude-opus-5-5'],
    systemProfile: { families: ['gemini'], env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } },
    accounts: [account('work', { families: ['claude'], visibleModels: ['claude-opus-5-5'] })],
  })
  const snapshot = structuredClone(raw)
  const result = migrateConfig(raw, CATALOG)
  assert.deepEqual(raw, snapshot)
  assert.equal(result.changed, true)
  assert.equal(result.config.accounts.length, 2)
  assert.deepEqual(result.config.accounts[0].visibleModels, ['gemini-4-argon'])
  assert.deepEqual(result.config.accounts[1].visibleModels, ['claude-opus-5-5'])
  assert.deepEqual(result.warnings, [])
})

test('a newer configuration version is preserved instead of downgraded', () => {
  const result = migrateConfig({ configVersion: 5, accounts: [account('work')] }, CATALOG)
  assert.equal(result.config.configVersion, 5)
  const again = migrateConfig(result.config, CATALOG)
  assert.equal(again.config.configVersion, 5)
  assert.equal(again.changed, false)
})
