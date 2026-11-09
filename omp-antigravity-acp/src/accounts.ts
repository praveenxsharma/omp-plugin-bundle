/**
 * Account pool: per-account isolation layout, credential sandbox preparation,
 * login helpers, and the scheduler that picks the account serving one step.
 *
 * The official CLI keeps its login in the OS keychain and only falls back to a
 * file when the keychain holds no entry, so a second account cannot be added by
 * pointing at another config directory. Each account therefore owns a private
 * `$HOME`: on macOS the security framework resolves the default keychain from
 * `$HOME/Library/Keychains`, and an isolated `$HOME` without that file makes
 * every keychain call fail or raise a system prompt. Every non-system account
 * is created together with an empty-password login keychain so the CLI can
 * refresh its token without an interactive unlock.
 * @module omp-antigravity-acp/accounts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountProfile } from './config.ts'
import { decodeStoredCredential, readStoredCredentialRaw } from './credential.ts'
import { defaultHome, prepareHome, type CommandRunner } from './preflight.ts'

/** Id of the implicit account that reuses this machine's own login. */
export const SYSTEM_ACCOUNT_ID = 'default'
/** Remark shown for the machine account until the user names it. */
export const SYSTEM_ACCOUNT_LABEL = 'This Mac'
/** Directory under the plugin home holding one directory per declared account. */
export const POOL_DIR = 'accounts'
/** Cooldown applied when a window is reported exhausted without a reset time. */
export const DEFAULT_COOLDOWN_MS = 10 * 60_000
/**
 * Cooldown applied when an account is briefly rate limited (upstream overload)
 * without a stated retry delay. Short on purpose: a transient 429 must not hide
 * a healthy account for a whole quota window.
 */
export const TRANSIENT_COOLDOWN_MS = 60_000
/** Account ids double as directory names, so a declared id stays in this alphabet. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Prefix of the key the pool assigns to an account declared without one. */
export const AUTO_ACCOUNT_PREFIX = 'acc'
/** Longest remark the settings card accepts. */
export const MAX_ACCOUNT_REMARK = 64

/** Model families that keep independent quota windows. */
export const MODEL_FAMILIES = ['gemini', 'claude', 'gpt-oss'] as const
/** One model family with its own quota window. */
export type Family = typeof MODEL_FAMILIES[number]
/** Cooldown bucket key (`argon` cools down independently on Pro without blocking Gemini Flash). */
export type CooldownKey = Family | 'argon'
/** Proxy variables written together so one account has one egress. */
const PROXY_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const
/** Loopback names kept off an account proxy so the local tool bridge stays direct. */
export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1'

/**
 * Map a model id to the quota family that governs it.
 * @param model - model family id from the catalog.
 * @returns the quota family.
 */
export function familyForModel(model: string): Family {
  if (model.startsWith('gpt-oss')) return 'gpt-oss'
  return /gemini/i.test(model) ? 'gemini' : 'claude'
}

/**
 * Parse a quota reset timestamp into epoch milliseconds.
 * @param value - ISO timestamp or numeric epoch string.
 * @returns the epoch milliseconds, or undefined when absent or unparsable.
 */
export function parseResetTime(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Extract the signed-in address from one stored Antigravity token blob.
 * Supports `go-keyring-base64:<base64>` (written by `agy` via `go-keyring` on
 * macOS Keychain), plain JSON token files, and JWT `id_token` payloads.
 * @param raw - token payload from the keychain or oauth-token file.
 * @returns the account email, or undefined when the blob carries none.
 */
export function emailFromToken(raw: string): string | undefined {
  const jsonText = decodeStoredCredential(raw)
  if (jsonText === undefined) return undefined
  try {
    const parsed = JSON.parse(jsonText) as { id_token_email?: unknown; email?: unknown; id_token?: unknown }
    if (typeof parsed.id_token_email === 'string' && parsed.id_token_email.trim().length > 0) {
      return parsed.id_token_email.trim()
    }
    if (typeof parsed.email === 'string' && parsed.email.trim().length > 0) {
      return parsed.email.trim()
    }
    if (typeof parsed.id_token === 'string') {
      const segment = parsed.id_token.split('.')[1]
      if (segment !== undefined && segment.length > 0) {
        const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as { email?: unknown }
        if (typeof claims.email === 'string' && claims.email.trim().length > 0) return claims.email.trim()
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Filesystem and process isolation facts of one account. */
export interface AccountLayout {
  /** Stable internal key and default directory name; assigned by the pool when not declared. */
  id: string
  /** User-visible remark; empty when the account was never named. */
  label: string
  /** Directory that owns this account's private `$HOME`; undefined for the system account. */
  root: string | undefined
  /** `home` exactly as the profile declared it, so an edit round-trip never pins a derived path. */
  declaredHome: string
  /** `$HOME` handed to this account's CLI processes. */
  homeDir: string
  /** `--gemini-dir` of this account. */
  geminiDir: string
  /** `--app-data-dir` of this account, always absolute. */
  appDir: string
  /** Session working directory, kept empty so writes only happen through tools. */
  workspace: string
  /** ACP log file of this account. */
  logFile: string
  /** Extra environment merged after the isolation variables. */
  env: Record<string, string>
  /** Context-window override in tokens. `0` follows the provider default. */
  contextWindow: number
  /**
   * Fine-grained subset of the provider's visible families this account may
   * serve. Empty inherits the provider allowlist; a non-empty list can only
   * narrow it, never add a family the provider hides.
   */
  visibleModels: readonly string[]
  /** Scheduling priority (`1..999`, smaller = higher priority). */
  priority: number
  /** Scheduling weight (`1..100`, proportional load share within same priority). */
  weight: number
  /** Whether the scheduler may route to this account. */
  enabled: boolean
  /** True for the implicit account that reuses the real `$HOME` and its login. */
  system: boolean
}

/** One account row rendered by the settings card. */
export interface AccountStatus {
  id: string
  label: string
  system: boolean
  enabled: boolean
  root: string | undefined
  /** Declared `home` of the profile; empty when the account uses the pool default. */
  home: string
  /** Declared extra environment of the profile. */
  env: Record<string, string>
  homeDir: string
  geminiDir: string
  /** Live ACP process state of this account. */
  state: 'idle' | 'starting' | 'ready' | 'error'
  error: string | undefined
  /** Open cooldowns, one row per exhausted family or Argon bucket. */
  cooldowns: { family: CooldownKey; until: string }[]
  /** ACP sessions currently bound to this account. */
  sessions: number
  /** Signed-in address read from this account's own credential store. */
  email: string | undefined
  /** Authoritative subscription tier (`ULTRA` / `PRO` / `FREE` / `ENTERPRISE`) from `loadCodeAssist`. */
  subscriptionTier?: 'ULTRA' | 'PRO' | 'FREE' | 'ENTERPRISE'
  /** Human-readable plan name (e.g. `Google AI Ultra`, `Google AI Pro`). */
  subscriptionName?: string
  /** Models this account's own upstream endpoint actually entitles. */
  availableModels?: readonly { id: string; name: string; enabled: boolean }[]
  /** Models explicitly marked disabled by upstream for this account (e.g. `gemini-4-argon`). */
  disabledModels?: readonly string[]
  /** Context-window override in tokens. `0` follows the provider default. */
  contextWindow: number
  /** Families this account narrows out of the provider's visible list; empty inherits it. */
  visibleModels: readonly string[]
  /** Scheduling priority (`1..999`, smaller = higher priority). */
  priority: number
  /** Scheduling weight (`1..100`, proportional load share within same priority). */
  weight: number
  /** Proxy URL declared for this account, or empty when it inherits the harness proxy. */
  proxyUrl: string
  /** Tokens reported for this account since the provider process started. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
}

/** Login hand-off returned when an interactive sign-in was started. */
export interface LoginTicket {
  accountId: string
  /** Authorization URL the user must open. */
  url: string
  /** Command the user can run in a terminal instead, when the UI cannot finish the flow. */
  command: string
}

/** Result of finishing an interactive sign-in. */
export interface LoginResult {
  ok: boolean
  email: string | undefined
  error: string | undefined
}

/** Account administration surface implemented by the runtime and exposed to the settings card. */
export interface AccountAdmin {
  accounts(): AccountStatus[]
  /** Create the account's sandbox, then start an interactive sign-in and return its URL. */
  beginLogin(accountId: string): Promise<LoginTicket>
  /** Finish the sign-in with the authorization code the browser showed. */
  completeLogin(accountId: string, code: string): Promise<LoginResult>
  /** Abandon a pending sign-in. */
  cancelLogin(accountId: string): void
}

/** Options that decide which accounts exist. */
export interface LayoutOptions {
  /** Plugin `home` config; empty uses `$DSH_HOME/cache/antigravity-acp`. */
  home: string
  /** Every account, the machine account included as the entry with `system: true`. */
  accounts: readonly AccountProfile[]
}

/**
 * Collapse a remark and enforce the settings-card length.
 * @param value - raw remark.
 * @returns the remark stored on the account.
 * @throws when the remark is longer than {@link MAX_ACCOUNT_REMARK}.
 */
export function accountRemark(value: string): string {
  const remark = value.trim().replace(/\s+/g, ' ')
  if ([...remark].length > MAX_ACCOUNT_REMARK) {
    throw new Error(`antigravity-acp: an account remark must be at most ${String(MAX_ACCOUNT_REMARK)} characters`)
  }
  return remark
}

/**
 * Keep only well-formed model ids, in declared order, without duplicates.
 * @param value - declared ids, possibly empty, blank, or repeated.
 * @returns the ids an account or the provider may serve; empty means "all".
 */
export function accountVisibleModels(value: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of value ?? []) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id.length === 0 || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * @param env - account environment.
 * @returns the proxy URL, preferring the HTTPS entry.
 */
export function proxyUrlFromEnv(env: Record<string, string>): string {
  return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || ''
}

/**
 * Normalize one proxy URL. A missing scheme becomes `http://`.
 * @param raw - user-entered proxy URL.
 * @returns the URL stored in the account environment, or `''` when unset.
 */
export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('antigravity-acp: invalid proxy URL')
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5' && scheme !== 'socks5h') {
    throw new Error(`antigravity-acp: proxy scheme ${scheme} is not supported; use http, https, socks5, or socks5h`)
  }
  if (parsed.hostname.length === 0) throw new Error('antigravity-acp: proxy URL is missing a host')
  return withScheme
}

/**
 * Replace the proxy variables of an account environment with one URL.
 * Other variables are kept. An empty URL removes the proxy and leaves the harness proxy in place.
 * @param env - current account environment.
 * @param proxyUrl - proxy URL, or empty.
 * @returns the environment to store on the account.
 */
export function envWithProxy(env: Record<string, string>, proxyUrl: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!(PROXY_ENV_NAMES as readonly string[]).includes(key)) next[key] = value
  }
  const url = normalizeProxyUrl(proxyUrl)
  if (url.length === 0) return next
  return {
    ...next,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
  }
}

/**
 * Absolute plugin home: the declared `home`, or the default cache directory.
 * It also hosts the data the plugin keeps for itself (session index, catalog)
 * whenever no account owns a directory.
 * @param home - plugin `home` config.
 * @returns an absolute directory path.
 */
export function pluginHome(home: string): string {
  return home.length > 0 ? home : defaultHome()
}

/**
 * Build the isolation layout of every configured account. The id is the
 * on-disk key; the remark is the only name a person chooses. An entry may
 * leave the id empty. The pool then assigns `acc-1`, `acc-2`, …, skipping keys
 * already declared and keys that already have a directory under the pool
 * root, so a removed account keeps its login directory. Saving the account
 * writes the assigned key back, and later loads use that key as-is.
 *
 * An entry with `system: true` is the machine account: it reuses this Mac's
 * `$HOME` and default keychain, owns no sandbox root, is always enabled, and
 * takes the id `default` unless it declares one. The list is the only truth,
 * so a list without such an entry simply has no machine account.
 * @param options - plugin home and every account profile.
 * @returns one layout per profile, in configured order.
 * @throws when a declared id is malformed, two ids collide, or a remark is too long.
 */
export function buildLayouts(options: LayoutOptions): AccountLayout[] {
  const base = pluginHome(options.home)
  const layouts: AccountLayout[] = []
  const seen = new Set<string>()
  // The machine account falls back to `default`, so a declared one may still
  // collide with a normal account that spells `default` out.
  const declared = options.accounts.map(profile => profile.system === true
    ? (profile.id.trim().length > 0 ? profile.id.trim() : SYSTEM_ACCOUNT_ID)
    : profile.id.trim())
  for (const id of declared) {
    if (id.length === 0) continue
    if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error(`antigravity-acp: account id "${id}" must be 1-64 characters of A-Z a-z 0-9 . _ -`)
    if (seen.has(id)) throw new Error(`antigravity-acp: duplicate account id "${id}"`)
    seen.add(id)
  }
  const poolRoot = join(base, POOL_DIR)
  let nextAuto = 0
  for (const [index, profile] of options.accounts.entries()) {
    const id = declared[index] ?? ''
    const named = { ...profile, displayName: accountRemark(profile.displayName) }
    if (profile.system === true) {
      layouts.push(systemLayout(base, id, named))
      continue
    }
    if (id.length > 0) {
      layouts.push(profileLayout(id, named, poolRoot))
      continue
    }
    let assigned: string
    do {
      nextAuto += 1
      if (nextAuto > 10_000) throw new Error('antigravity-acp: no free account directory key')
      assigned = `${AUTO_ACCOUNT_PREFIX}-${nextAuto}`
    } while (seen.has(assigned) || existsSync(join(poolRoot, assigned)))
    seen.add(assigned)
    layouts.push(profileLayout(assigned, named, poolRoot))
  }
  return layouts
}

function systemLayout(base: string, id: string, profile: AccountProfile): AccountLayout {
  const remark = profile.displayName.trim()
  return {
    id,
    label: remark.length > 0 ? remark : SYSTEM_ACCOUNT_LABEL,
    root: undefined,
    declaredHome: '',
    homeDir: homedir(),
    geminiDir: base,
    appDir: join(base, 'agy'),
    workspace: join(base, 'workspace'),
    logFile: join(base, 'acp.log'),
    env: { ...profile.env },
    contextWindow: positiveWindow(profile.contextWindow),
    visibleModels: accountVisibleModels(profile.visibleModels),
    priority: accountPriority(profile.priority),
    weight: accountWeight(profile.weight),
    // The machine account always serves traffic while it is in the list;
    // removing it is expressed by dropping the entry.
    enabled: true,
    system: true,
  }
}

function profileLayout(id: string, profile: AccountProfile, poolRoot: string): AccountLayout {
  const declared = profile.home.trim()
  const root = declared.length > 0 ? declared : join(poolRoot, id)
  const geminiDir = join(root, 'gemini')
  return {
    id,
    label: profile.displayName.trim(),
    root,
    declaredHome: declared,
    homeDir: join(root, 'home'),
    geminiDir,
    appDir: join(geminiDir, 'agy'),
    workspace: join(geminiDir, 'workspace'),
    logFile: join(geminiDir, 'acp.log'),
    env: { ...profile.env },
    contextWindow: positiveWindow(profile.contextWindow),
    visibleModels: accountVisibleModels(profile.visibleModels),
    priority: accountPriority(profile.priority),
    weight: accountWeight(profile.weight),
    enabled: profile.enabled,
    system: false,
  }
}

function positiveWindow(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Normalize an account scheduling priority (`1..999`, smaller = higher priority).
 * @param value - declared priority.
 * @returns integer in `1..999`, defaulting to `1`.
 */
export function accountPriority(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999 ? value : 1
}

/**
 * Normalize an account scheduling weight (`1..100`, proportional share within a priority tier).
 * @param value - declared weight.
 * @returns integer in `1..100`, defaulting to `1`.
 */
export function accountWeight(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 1
}

/**
 * One resolved layout as the settings surface saves it back into the account
 * list, so a round-trip keeps the machine entry, its id, and its remark.
 * @param layout - resolved layout.
 * @param declaredDisplayName - remark the profile declared, when the caller
 * still holds it; the machine account falls back to "no remark" rather than
 * freezing its display label.
 * @returns the account profile.
 */
export function accountProfileOf(layout: AccountLayout, declaredDisplayName?: string): AccountProfile {
  const displayName = declaredDisplayName !== undefined
    ? declaredDisplayName.trim()
    : layout.system && layout.label === SYSTEM_ACCOUNT_LABEL ? '' : layout.label
  return {
    id: layout.id,
    displayName,
    home: layout.declaredHome,
    enabled: layout.enabled,
    env: { ...layout.env },
    contextWindow: layout.contextWindow,
    ...layout.system ? { system: true } : {},
    visibleModels: [...layout.visibleModels],
    priority: layout.priority,
    weight: layout.weight,
  }
}

/**
 * Environment one account's CLI processes inherit, merged over the parent base.
 * @param layout - account layout.
 * @param platform - target platform, injectable for tests.
 * @returns the environment overlay.
 */
export function accountEnv(layout: AccountLayout, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  // Declared extras come first so the isolation variables below always win: a
  // profile `env.HOME` must never point two accounts at one credential store.
  const env: NodeJS.ProcessEnv = { ...layout.env }
  if (!layout.system) {
    env.HOME = layout.homeDir
    // Without a session bus the keyring implementation cannot reach a desktop
    // secret service and falls back to the account's own credential file.
    if (platform === 'linux') env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(layout.root ?? layout.homeDir, '.no-dbus-session')}`
  }
  return env
}

/**
 * Shell command that signs one account in from a terminal.
 * @param layout - account layout.
 * @param binary - `agy` executable path.
 * @returns a copy-pasteable command.
 */
export function loginCommand(layout: AccountLayout, binary: string): string {
  const prefix = layout.system ? '' : `HOME=${shellQuote(layout.homeDir)} `
  return `${prefix}${shellQuote(binary)} acp --login`
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Create the account's directory sandbox and its private credential store.
 * @param layout - account layout.
 * @param run - helper command runner.
 * @param platform - target platform, injectable for tests.
 * @returns true when a new keychain had to be created.
 */
export async function ensureLayout(
  layout: AccountLayout,
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  mkdirSync(layout.homeDir, { recursive: true })
  prepareHome(layout.geminiDir, layout.homeDir)
  if (layout.system || platform !== 'darwin') return false
  return ensureLoginKeychain(layout, run)
}

/**
 * Create the empty-password login keychain of one sandboxed account.
 * @param layout - account layout.
 * @param run - helper command runner.
 * @returns true when the keychain was created.
 * @throws when the keychain could not be created.
 */
export async function ensureLoginKeychain(layout: AccountLayout, run: CommandRunner): Promise<boolean> {
  if (layout.system || layout.root === undefined) return false
  const dir = join(layout.homeDir, 'Library', 'Keychains')
  const path = join(dir, 'login.keychain-db')
  if (existsSync(path)) return false
  mkdirSync(dir, { recursive: true })
  // `HOME` is scoped to the sandbox for the whole call: creating the file under
  // the sandbox is what makes the security framework treat it as this account's
  // default keychain. Setting a default keychain here would rewrite the
  // machine's own selection and must never happen.
  const env = { HOME: layout.homeDir }
  const created = await run(['security', 'create-keychain', '-p', '', path], 20_000, env)
  if (created.code !== 0) {
    throw new Error(`antigravity-acp: could not create the isolated keychain for account "${layout.id}": ${created.stderr.trim() || `exit ${created.code}`}`)
  }
  // No `-t` means the keychain never auto-locks, so a later token refresh inside
  // a long ACP process cannot stall on an unlock prompt.
  await run(['security', 'set-keychain-settings', path], 20_000, env)
  return true
}

/**
 * Read the signed-in address of one account without exposing its credential.
 * @param layout - account layout.
 * @param run - helper command runner.
 * @param platform - target platform, injectable for tests.
 * @returns the email, or undefined when the account is not signed in.
 */
export async function readAccountEmail(
  layout: AccountLayout,
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const raw = await readStoredCredentialRaw(layout, run, platform, (blob) => emailFromToken(blob) !== undefined)
  return raw === undefined ? undefined : emailFromToken(raw)
}

interface PoolEntry {
  layout: AccountLayout
  cooldowns: Map<CooldownKey, number>
  /** Last upstream error that parked each bucket, kept beside its cooldown. */
  reasons: Map<CooldownKey, string>
  lastUsed: number
  picks: number
}

/**
 * Priority-first, weighted load-balancing scheduler over the account layouts:
 * 1. Keeps per-family and independent Argon cooldowns.
 * 2. Keeps a conversation sticky to one account while usable (prompt-cache affinity).
 * 3. Selects the lowest numeric `priority` tier (`1` beats `2`).
 * 4. Balances within that tier by active session ratio (`activeLoad / weight`),
 *    proportional weighted round-robin (`picks / weight`), and `lastUsed` LRU.
 */
export class AccountPool {
  private entries = new Map<string, PoolEntry>()

  /** @param layouts - initial layouts. */
  constructor(layouts: readonly AccountLayout[] = []) {
    this.sync(layouts)
  }

  /**
   * Replace the layouts, preserving cooldowns, recency, and pick counts of surviving ids.
   * @param layouts - the new layout list.
   */
  sync(layouts: readonly AccountLayout[]): void {
    const next = new Map<string, PoolEntry>()
    for (const layout of layouts) {
      const existing = this.entries.get(layout.id)
      next.set(
        layout.id,
        existing !== undefined
          ? { layout, cooldowns: existing.cooldowns, reasons: existing.reasons, lastUsed: existing.lastUsed, picks: existing.picks }
          : { layout, cooldowns: new Map(), reasons: new Map(), lastUsed: 0, picks: 0 },
      )
    }
    this.entries = next
  }

  /** @returns every layout in configured order. */
  list(): AccountLayout[] {
    return [...this.entries.values()].map(entry => entry.layout)
  }

  /**
   * @param id - account id.
   * @returns the layout, or undefined when the account is not configured.
   */
  get(id: string): AccountLayout | undefined {
    return this.entries.get(id)?.layout
  }

  /**
   * @param id - account id.
   * @param family - model family.
   * @param now - clock injection for tests.
   * @returns remaining cooldown in milliseconds, 0 when the account may serve.
   */
  cooldownMs(id: string, family: CooldownKey, now = Date.now()): number {
    const entry = this.entries.get(id)
    if (entry === undefined) return 0
    const until = entry.cooldowns.get(family)
    if (until === undefined) return 0
    const remaining = until - now
    if (remaining <= 0) {
      entry.cooldowns.delete(family)
      entry.reasons.delete(family)
      return 0
    }
    return remaining
  }

  /**
   * @param id - account id.
   * @param family - model family or Argon bucket.
   * @param now - clock injection for tests.
   * @returns the upstream error that parked the bucket while it still cools down, else undefined.
   */
  cooldownReason(id: string, family: CooldownKey, now = Date.now()): string | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    if (this.cooldownMs(id, family, now) <= 0) return undefined
    return entry.reasons.get(family)
  }

  /**
   * @param id - account id.
   * @param now - clock injection for tests.
   * @returns one row per open cooldown.
   */
  cooldowns(id: string, now = Date.now()): { family: CooldownKey; until: string }[] {
    const entry = this.entries.get(id)
    if (entry === undefined) return []
    const rows: { family: CooldownKey; until: string }[] = []
    for (const [family, until] of entry.cooldowns) {
      if (until - now > 0) rows.push({ family, until: new Date(until).toISOString() })
      else {
        entry.cooldowns.delete(family)
        entry.reasons.delete(family)
      }
    }
    return rows
  }

  /**
   * Park one account for a family or Argon bucket until a deadline.
   * @param id - account id.
   * @param family - model family or Argon bucket.
   * @param until - epoch milliseconds.
   * @param reason - upstream error that caused the park, kept for diagnostics.
   */
  exhaust(id: string, family: CooldownKey, until: number, reason?: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.cooldowns.set(family, Math.max(until, Date.now() + 1_000))
    if (reason !== undefined && reason.length > 0) entry.reasons.set(family, reason)
    else entry.reasons.delete(family)
  }

  /**
   * Park one account using the window reset time the CLI reported.
   * @param id - account id.
   * @param family - model family or Argon bucket.
   * @param resetTime - reset timestamp, when known.
   * @param reason - upstream error that caused the park, kept for diagnostics.
   * @returns the epoch milliseconds the account stays parked until.
   */
  exhaustFor(id: string, family: CooldownKey, resetTime: string | undefined, reason?: string): number {
    const until = parseResetTime(resetTime) ?? Date.now() + DEFAULT_COOLDOWN_MS
    this.exhaust(id, family, until, reason)
    return until
  }

  /**
   * Clear cooldowns of one account.
   * @param id - account id.
   * @param family - model family, or every family when omitted.
   */
  clear(id: string, family?: CooldownKey): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    if (family === undefined) {
      entry.cooldowns.clear()
      entry.reasons.clear()
    } else {
      entry.cooldowns.delete(family)
      entry.reasons.delete(family)
    }
  }

  /**
   * Record that an account just served a step.
   * @param id - account id.
   * @param now - clock injection for tests.
   */
  touch(id: string, now = Date.now()): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) {
      entry.lastUsed = now
      entry.picks += 1
    }
  }

  /**
   * @param id - account id.
   * @returns the last time this account served a step, 0 when never.
   */
  lastUsed(id: string): number {
    return this.entries.get(id)?.lastUsed ?? 0
  }

  /**
   * Pick the account that serves one step.
   * @param family - model family of the step, whose cooldown gates the pick.
   * @param stickyId - account the conversation already owns, kept when usable.
   * @param now - clock injection for tests.
   * @param accept - optional per-model eligibility gate (per-account model catalog, allowlist, Argon cooldown).
   * @param activeLoad - optional live session count per account id.
   * @returns the chosen layout, or undefined when every account is parked or disabled.
   */
  choose(
    family: Family,
    stickyId?: string,
    now = Date.now(),
    accept?: (layout: AccountLayout) => boolean,
    activeLoad?: (id: string) => number,
  ): AccountLayout | undefined {
    const usable = this.list().filter(layout =>
      layout.enabled
      && this.cooldownMs(layout.id, family, now) === 0
      && (accept === undefined || accept(layout)))
    if (usable.length === 0) return undefined
    const sticky = usable.find(layout => layout.id === stickyId)
    if (sticky !== undefined) return sticky

    let minPriority = usable[0]!.priority
    for (const layout of usable) {
      if (layout.priority < minPriority) minPriority = layout.priority
    }
    const tier = usable.filter(layout => layout.priority === minPriority)

    const activeScore = (layout: AccountLayout): number =>
      activeLoad === undefined ? 0 : activeLoad(layout.id) / layout.weight
    const pickScore = (layout: AccountLayout): number =>
      (this.entries.get(layout.id)?.picks ?? 0) / layout.weight

    return tier.reduce((best, candidate) => {
      const candActive = activeScore(candidate)
      const bestActive = activeScore(best)
      if (Math.abs(candActive - bestActive) > 1e-9) {
        return candActive < bestActive ? candidate : best
      }
      const candPick = pickScore(candidate)
      const bestPick = pickScore(best)
      if (Math.abs(candPick - bestPick) > 1e-9) {
        return candPick < bestPick ? candidate : best
      }
      return this.lastUsed(candidate.id) < this.lastUsed(best.id) ? candidate : best
    })
  }
}
