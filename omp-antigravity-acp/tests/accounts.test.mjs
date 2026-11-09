// Unit tests of the account pool: isolation layout, environment overlay,
// credential sandbox creation, and scheduling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountPool, accountEnv, buildLayouts, emailFromToken, ensureLayout, ensureLoginKeychain,
  familyForModel, loginCommand, parseResetTime, readAccountEmail, SYSTEM_ACCOUNT_ID,
} from '../lib/accounts.js'

const profile = (id, extra = {}) => ({ id, displayName: '', home: '', enabled: true, env: {}, ...extra })
/** The machine account as one entry of an account list. */
const systemAccount = (extra = {}) => ({ id: SYSTEM_ACCOUNT_ID, displayName: '', home: '', enabled: true, env: {}, system: true, ...extra })

/** Runner that records argv and succeeds, optionally creating a file. */
function recorder(touch) {
  const calls = []
  const run = async (argv, timeoutMs, env) => {
    calls.push({ argv: [...argv], timeoutMs, env })
    if (touch !== undefined) touch(argv)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

test('buildLayouts puts the machine account first and derives one sandbox per profile', () => {
  const layouts = buildLayouts({
    home: '/base',
    accounts: [systemAccount(), profile('work', { displayName: 'Work', env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } })],
  })
  assert.equal(layouts.length, 2)
  const system = layouts[0]
  assert.equal(system.id, SYSTEM_ACCOUNT_ID)
  assert.equal(system.system, true)
  assert.equal(system.enabled, true)
  assert.equal(system.root, undefined)
  assert.equal(system.geminiDir, '/base')
  assert.equal(system.appDir, '/base/agy')
  assert.equal(system.logFile, '/base/acp.log')
  const work = layouts[1]
  assert.equal(work.id, 'work')
  assert.equal(work.label, 'Work')
  assert.equal(work.system, false)
  assert.equal(work.root, '/base/accounts/work')
  assert.equal(work.homeDir, '/base/accounts/work/home')
  assert.equal(work.geminiDir, '/base/accounts/work/gemini')
  assert.equal(work.appDir, '/base/accounts/work/gemini/agy')
  assert.equal(work.logFile, '/base/accounts/work/gemini/acp.log')
  assert.deepEqual(work.env, { HTTPS_PROXY: 'http://127.0.0.1:7890' })
})

test('buildLayouts honours a declared root and can drop the machine account', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [profile('a', { home: '/custom/a', enabled: false })] })
  assert.equal(layouts.length, 1)
  assert.equal(layouts[0].root, '/custom/a')
  assert.equal(layouts[0].geminiDir, '/custom/a/gemini')
  assert.equal(layouts[0].enabled, false)
})

test('buildLayouts assigns directory keys when an account only has a remark', () => {
  const layouts = buildLayouts({
    home: '/base',
    accounts: [profile('', { displayName: '  工作号  ' }), profile('acc-1'), profile('')],
  })
  assert.deepEqual(layouts.map((layout) => [layout.id, layout.label]), [
    ['acc-2', '工作号'],
    ['acc-1', ''],
    ['acc-3', ''],
  ])
  assert.equal(layouts[0].root, '/base/accounts/acc-2')
})

test('buildLayouts leaves a removed account directory in place for the next new account', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  mkdirSync(join(root, 'accounts', 'acc-1'), { recursive: true })
  const layouts = buildLayouts({ home: root, accounts: [profile('', { displayName: '备用' })] })
  assert.equal(layouts[0].id, 'acc-2')
  assert.equal(layouts[0].label, '备用')
  assert.equal(layouts[0].root, join(root, 'accounts', 'acc-2'))
})

test('buildLayouts rejects malformed and duplicate ids and overlong remarks', () => {
  assert.throws(() => buildLayouts({ home: '/base', accounts: [profile('../escape')] }), /must be 1-64 characters/)
  assert.throws(() => buildLayouts({ home: '/base', accounts: [profile('a'), profile('a')] }), /duplicate account id/)
  assert.throws(() => buildLayouts({ home: '/base', accounts: [systemAccount(), profile(SYSTEM_ACCOUNT_ID)] }), /duplicate account id/)
  assert.throws(() => buildLayouts({ home: '/base', accounts: [profile('a', { displayName: '名'.repeat(65) })] }), /remark must be at most 64/)
})

test('accountEnv isolates HOME and never lets a profile override it', () => {
  const [system, work] = buildLayouts({ home: '/base', accounts: [systemAccount(), profile('work', { env: { HOME: '/tmp/evil', HTTPS_PROXY: 'http://p' } })] })
  assert.deepEqual(accountEnv(system, 'darwin'), {})
  assert.deepEqual(accountEnv(work, 'darwin'), { HOME: '/base/accounts/work/home', HTTPS_PROXY: 'http://p' })
  const linux = accountEnv(work, 'linux')
  assert.equal(linux.HOME, '/base/accounts/work/home')
  assert.equal(linux.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/base/accounts/work/.no-dbus-session')
})

test('loginCommand quotes paths and scopes HOME only for sandboxed accounts', () => {
  const [system, work] = buildLayouts({ home: '/base', accounts: [systemAccount(), profile('work')] })
  assert.equal(loginCommand(system, '/usr/local/bin/agy'), '/usr/local/bin/agy acp --login')
  assert.equal(loginCommand(work, '/usr/local/bin/agy'), 'HOME=/base/accounts/work/home /usr/local/bin/agy acp --login')
  const spaced = buildLayouts({ home: '/base dir', accounts: [profile('w')] })
  assert.match(loginCommand(spaced[0], '/opt/my agy/agy'), /^HOME='\/base dir\/accounts\/w\/home' '\/opt\/my agy\/agy' acp --login$/)
})

test('familyForModel groups models by their quota window', () => {
  assert.equal(familyForModel('gemini-4-argon'), 'gemini')
  assert.equal(familyForModel('claude-5-5-sonnet'), 'claude')
  assert.equal(familyForModel('gpt-oss-120b-medium'), 'gpt-oss')
})

test('parseResetTime and emailFromToken read plain JSON, go-keyring-base64, and JWT claims', () => {
  assert.equal(parseResetTime('2026-11-10T00:57:18Z'), Date.parse('2026-11-10T00:57:18Z'))
  assert.equal(parseResetTime(''), undefined)
  assert.equal(parseResetTime('later'), undefined)
  assert.equal(emailFromToken(JSON.stringify({ id_token_email: 'a@b.c' })), 'a@b.c')
  const keyringEncoded = `go-keyring-base64:${Buffer.from(JSON.stringify({ token: 'x', id_token_email: 'keyring@example.com' })).toString('base64')}\n`
  assert.equal(emailFromToken(keyringEncoded), 'keyring@example.com')
  const jwtPayload = Buffer.from(JSON.stringify({ email: 'jwt@example.com' })).toString('base64url')
  assert.equal(emailFromToken(JSON.stringify({ id_token: `hdr.${jwtPayload}.sig` })), 'jwt@example.com')
  assert.equal(emailFromToken('{"id_token_email":""}'), undefined)
  assert.equal(emailFromToken('not json'), undefined)
})

test('ensureLoginKeychain creates one empty-password keychain and never touches the default one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  const [work] = buildLayouts({ home: join(root, 'base'), accounts: [profile('work')] })
  const { calls, run } = recorder((argv) => {
    if (argv[1] === 'create-keychain') {
      mkdirSync(join(work.homeDir, 'Library', 'Keychains'), { recursive: true })
      writeFileSync(argv[4], '')
    }
  })
  assert.equal(await ensureLoginKeychain(work, run), true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].argv, ['security', 'create-keychain', '-p', '', join(work.homeDir, 'Library', 'Keychains', 'login.keychain-db')])
  assert.deepEqual(calls[1].argv, ['security', 'set-keychain-settings', join(work.homeDir, 'Library', 'Keychains', 'login.keychain-db')])
  for (const call of calls) assert.equal(call.env.HOME, work.homeDir)
  assert.equal(calls.some(call => call.argv.includes('default-keychain')), false)
  // An account that already owns a keychain issues no command at all.
  const again = recorder()
  assert.equal(await ensureLoginKeychain(work, again.run), false)
  assert.equal(again.calls.length, 0)
})

test('ensureLoginKeychain surfaces a creation failure instead of pretending success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  const [work] = buildLayouts({ home: join(root, 'base'), accounts: [profile('work')] })
  const run = async () => ({ code: 1, stdout: '', stderr: 'denied' })
  await assert.rejects(() => ensureLoginKeychain(work, run), /could not create the isolated keychain/)
})

test('ensureLayout prepares the bridge home and skips the keychain for the machine account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  const [system, work] = buildLayouts({ home: join(root, 'base'), accounts: [systemAccount(), profile('work')] })
  const machine = recorder()
  assert.equal(await ensureLayout(system, machine.run, 'darwin'), false)
  assert.equal(machine.calls.length, 0)
  const sandboxed = recorder((argv) => {
    if (argv[1] !== 'create-keychain') return
    mkdirSync(join(work.homeDir, 'Library', 'Keychains'), { recursive: true })
    writeFileSync(argv[4], '')
  })
  assert.equal(await ensureLayout(work, sandboxed.run, 'darwin'), true)
  assert.ok(existsSync(join(work.homeDir, 'Library', 'Keychains', 'login.keychain-db')))
  assert.ok(existsSync(join(work.geminiDir, 'config', 'plugins', 'omp-bridge', 'agents', 'omp-bridge.md')))
  // Linux never creates a keychain: the broken session bus forces the file store.
  const linux = recorder()
  const [onlyLinux] = buildLayouts({ home: join(root, 'base'), accounts: [profile('l')] })
  assert.equal(await ensureLayout(onlyLinux, linux.run, 'linux'), false)
  assert.equal(linux.calls.length, 0)
})

test('readAccountEmail prefers the sandboxed keychain and falls back to the token file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  const [work] = buildLayouts({ home: join(root, 'base'), accounts: [profile('work')] })
  mkdirSync(work.appDir, { recursive: true })
  writeFileSync(join(work.appDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'file@example.com' }))
  const fromFile = await readAccountEmail(work, async () => ({ code: 1, stdout: '', stderr: 'not found' }), 'darwin')
  assert.equal(fromFile, 'file@example.com')
  const fromKeychain = await readAccountEmail(work, async () => ({ code: 0, stdout: JSON.stringify({ id_token_email: 'key@example.com' }), stderr: '' }), 'darwin')
  assert.equal(fromKeychain, 'key@example.com')
  const empty = await readAccountEmail(work, async () => ({ code: 1, stdout: '', stderr: '' }), 'linux')
  assert.equal(empty, 'file@example.com')
})

test('readAccountEmail unlocks the sandboxed keychain first and skips a keychain blob that carries no email', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-accounts-'))
  const [work] = buildLayouts({ home: join(root, 'base'), accounts: [profile('work')] })
  mkdirSync(join(work.homeDir, 'Library', 'Keychains'), { recursive: true })
  writeFileSync(join(work.homeDir, 'Library', 'Keychains', 'login.keychain-db'), '')
  mkdirSync(work.appDir, { recursive: true })
  writeFileSync(join(work.appDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'file@example.com' }))
  const calls = []
  const run = async (argv, timeoutMs, env) => {
    calls.push({ argv: [...argv], timeoutMs, env })
    return { code: 0, stdout: 'not json', stderr: '' }
  }
  const email = await readAccountEmail(work, run, 'darwin')
  assert.equal(email, 'file@example.com', 'an unusable keychain payload falls back to the token file')
  assert.deepEqual(calls[0].argv, ['security', 'unlock-keychain', '-p', '', join(work.homeDir, 'Library', 'Keychains', 'login.keychain-db')])
  assert.equal(calls[0].timeoutMs, 5_000)
  assert.deepEqual(calls[0].env, { HOME: work.homeDir })
  assert.deepEqual(calls[1].argv, ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'])
  assert.equal(calls[1].timeoutMs, 10_000)
  assert.deepEqual(calls[1].env, { HOME: work.homeDir })
})

test('readAccountEmail never unlocks or scopes HOME for the machine account', async () => {
  const [system] = buildLayouts({ home: join(mkdtempSync(join(tmpdir(), 'agy-accounts-')), 'base'), accounts: [systemAccount()] })
  const calls = []
  const run = async (argv, timeoutMs, env) => {
    calls.push({ argv: [...argv], timeoutMs, env })
    return { code: 1, stdout: '', stderr: 'not found' }
  }
  assert.equal(await readAccountEmail(system, run, 'darwin'), undefined)
  assert.deepEqual(calls, [{
    argv: ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
    timeoutMs: 10_000,
    env: undefined,
  }])
})

test('the scheduler keeps a conversation on its account while it is usable', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [systemAccount(), profile('a'), profile('b')] })
  const pool = new AccountPool(layouts)
  pool.touch('a', 100)
  pool.touch('b', 200)
  assert.equal(pool.choose('gemini')?.id, SYSTEM_ACCOUNT_ID, 'the least recently used account takes a new conversation')
  assert.equal(pool.choose('gemini', 'b')?.id, 'b', 'a sticky account is kept for cache affinity')
  pool.exhaust('b', 'gemini', Date.now() + 60_000)
  assert.notEqual(pool.choose('gemini', 'b')?.id, 'b', 'a parked account loses its stickiness')
})

test('cooldowns are per family and expire on the reset time the CLI reported', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [profile('a')] })
  const pool = new AccountPool(layouts)
  const until = Date.now() + 3_600_000
  pool.exhaust('a', 'claude', until)
  assert.equal(pool.cooldownMs('a', 'claude') > 0, true)
  assert.equal(pool.cooldownMs('a', 'gemini'), 0, 'an exhausted Claude window never blocks Gemini')
  assert.deepEqual(pool.cooldowns('a').map(row => row.family), ['claude'])
  assert.equal(pool.choose('claude'), undefined)
  assert.equal(pool.choose('gemini')?.id, 'a')
  pool.clear('a')
  assert.equal(pool.cooldownMs('a', 'claude'), 0)
})

test('exhaustFor falls back to a bounded cooldown when no reset time is known', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [profile('a')] })
  const pool = new AccountPool(layouts)
  const before = Date.now()
  const until = pool.exhaustFor('a', 'gemini', undefined)
  assert.ok(until >= before + 9 * 60_000 && until <= before + 11 * 60_000)
  const named = pool.exhaustFor('a', 'gemini', '2026-11-14T02:58:38Z')
  assert.equal(named, Date.parse('2026-11-14T02:58:38Z'))
})

test('disabled accounts never receive traffic', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [systemAccount(), profile('a', { enabled: false })] })
  const pool = new AccountPool(layouts)
  assert.equal(pool.choose('gemini')?.id, SYSTEM_ACCOUNT_ID)
  const onlyDisabled = new AccountPool(buildLayouts({ home: '/base', accounts: [profile('a', { enabled: false })] }))
  assert.equal(onlyDisabled.choose('gemini'), undefined)
})

test('sync keeps cooldowns and recency of surviving accounts', () => {
  const pool = new AccountPool(buildLayouts({ home: '/base', accounts: [profile('a'), profile('b')] }))
  pool.exhaust('a', 'gemini', Date.now() + 600_000)
  pool.touch('b', 42)
  pool.sync(buildLayouts({ home: '/base', accounts: [profile('a'), profile('c')] }))
  assert.equal(pool.cooldownMs('a', 'gemini') > 0, true)
  assert.deepEqual(pool.list().map(layout => layout.id), ['a', 'c'])
  assert.equal(pool.lastUsed('b'), 0, 'a removed account stops being tracked')
})

test('AccountPool enforces priority tiers and proportional weights with automatic P2 failover', () => {
  const layouts = buildLayouts({
    home: '/base',
    accounts: [
      profile('p1-a', { priority: 1, weight: 3 }),
      profile('p1-b', { priority: 1, weight: 1 }),
      profile('p2-fallback', { priority: 2, weight: 5 }),
    ],
  })
  const pool = new AccountPool(layouts)
  const sequence = []
  for (let i = 1; i <= 8; i += 1) {
    const chosen = pool.choose('gemini', undefined, i * 10)
    sequence.push(chosen.id)
    pool.touch(chosen.id, i * 10)
  }
  assert.equal(sequence.includes('p2-fallback'), false, 'P2 stays in reserve while P1 accounts are healthy')
  assert.equal(sequence.filter(id => id === 'p1-a').length, 6, 'weight 3 serves 75% of turns')
  assert.equal(sequence.filter(id => id === 'p1-b').length, 2, 'weight 1 serves 25% of turns')

  // Exhaust both P1 accounts on Gemini -> seamlessly falls over to P2!
  pool.exhaust('p1-a', 'gemini', Date.now() + 60_000)
  pool.exhaust('p1-b', 'gemini', Date.now() + 60_000)
  assert.equal(pool.choose('gemini')?.id, 'p2-fallback')
})

test('buildLayouts turns a system entry into this Mac and always enables it', () => {
  const [system] = buildLayouts({
    home: '/base',
    accounts: [systemAccount({ displayName: '  我的机器  ', enabled: false, home: '/ignored' })],
  })
  assert.equal(system.id, SYSTEM_ACCOUNT_ID)
  assert.equal(system.system, true)
  assert.equal(system.enabled, true, 'the machine account is enabled by its presence in the list')
  assert.equal(system.label, '我的机器')
  assert.equal(system.root, undefined)
  assert.equal(system.declaredHome, '')
  assert.equal(system.homeDir, homedir())
  assert.equal(system.geminiDir, '/base')
  assert.equal(system.appDir, '/base/agy')
})

test('buildLayouts defaults an unnamed system entry to the default id and the machine label', () => {
  const [system] = buildLayouts({ home: '/base', accounts: [systemAccount({ id: '' })] })
  assert.equal(system.id, SYSTEM_ACCOUNT_ID)
  assert.equal(system.label, 'This Mac')
  assert.equal(system.contextWindow, 0)
  assert.deepEqual(system.visibleModels, [])
})

test('a system entry keeps the id it declares', () => {
  const [system] = buildLayouts({ home: '/base', accounts: [systemAccount({ id: 'this-mac' })] })
  assert.equal(system.id, 'this-mac')
  assert.equal(system.system, true)
})

test('the scheduler no longer filters accounts by model family', () => {
  const layouts = buildLayouts({ home: '/base', accounts: [profile('a'), profile('b')] })
  const pool = new AccountPool(layouts)
  // One Claude window parks every account on Claude: only cooldowns, not a
  // family gate, decide who serves what.
  pool.exhaust('a', 'claude', Date.now() + 60_000)
  assert.equal(pool.choose('claude')?.id, 'b')
  assert.equal(pool.choose('gemini')?.id, 'a')
})
