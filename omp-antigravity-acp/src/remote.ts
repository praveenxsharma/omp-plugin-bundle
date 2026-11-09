/**
 * Account administration facade used by tests and OMP slash commands.
 * @module omp-antigravity-acp/remote
 */

import { SYSTEM_ACCOUNT_LABEL, type AccountStatus, type LoginResult, type LoginTicket } from './accounts.ts'
import { asEffort, type AccountProfile } from './config.ts'
import type { QuotaSnapshot } from './quota.ts'
import type { AntigravityRuntime, LiveOverrides, RuntimeStatus } from './runtime.ts'

/** Package name used for descriptor identities. */
export const PACKAGE_NAME = 'omp-antigravity-acp'
/** Service key. */
export const SERVICE_NAME = 'antigravityAcp'

interface HostContext {
  get?(name: string): unknown
}

type InvocationDescriptor = Record<string, unknown>

interface TypertCodec {
  mode: 'strict'
  typeSymbol: string
  create: () => { parse: (value: unknown) => unknown }
}

/** Optional request of `quota`. */
export interface QuotaRequest {
  force?: boolean
  /** Account whose windows to read; defaults to the account that serves `model`. */
  accountId?: string
  /**
   * Model whose serving account should be read. The composer asks this way so
   * the pill can never report another account's windows for the model on
   * screen; `accountId` wins when both are present.
   */
  model?: string
  /** DSH session whose bound account should be preferred, so a pinned conversation keeps its own subscription's numbers. */
  sessionId?: string
}

function parseQuotaRequest(value: unknown): QuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity quota request')
  const force = (value as Record<string, unknown>).force
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid antigravity quota request.force')
  const accountId = (value as Record<string, unknown>).accountId
  if (accountId !== undefined && (typeof accountId !== 'string' || accountId.trim().length === 0)) {
    throw new TypeError('Invalid antigravity quota request.accountId')
  }
  const model = (value as Record<string, unknown>).model
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new TypeError('Invalid antigravity quota request.model')
  }
  const sessionId = (value as Record<string, unknown>).sessionId
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim().length === 0)) {
    throw new TypeError('Invalid antigravity quota request.sessionId')
  }
  return {
    ...force === undefined ? {} : { force },
    ...typeof accountId === 'string' ? { accountId: accountId.trim() } : {},
    ...typeof model === 'string' ? { model: model.trim() } : {},
    ...typeof sessionId === 'string' ? { sessionId: sessionId.trim() } : {},
  }
}

/** Request of `login`: the account whose interactive sign-in should start. */
export interface LoginRequest {
  accountId: string
}

/** Request of `loginCode`: the account plus the code its browser page displayed. */
export interface LoginCodeRequest {
  accountId: string
  code: string
}

function parseAccountId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`Invalid antigravity ${label}.accountId`)
  return value.trim()
}

function parseAccountRequest(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid antigravity ${label}`)
  return value as Record<string, unknown>
}

function parseLoginRequest(value: unknown): LoginRequest {
  return { accountId: parseAccountId(parseAccountRequest(value, 'login request').accountId, 'login request') }
}

function parseLoginCodeRequest(value: unknown): LoginCodeRequest {
  const record = parseAccountRequest(value, 'loginCode request')
  const accountId = parseAccountId(record.accountId, 'loginCode request')
  if (typeof record.code !== 'string' || record.code.trim().length === 0) throw new TypeError('Invalid antigravity loginCode request.code')
  return { accountId, code: record.code }
}

/**
 * Validate one declared account of a configure request.
 *
 * The request carries the whole account list, the machine entry included as
 * its `system: true` row. A retired per-account `families` gate is ignored:
 * `visibleModels` is the only model allowlist an account has.
 * @param value - candidate entry.
 * @param index - position, used to name the offending field.
 * @returns the account profile.
 */
function parseAccountProfile(value: unknown, index: number): AccountProfile {
  const label = `Invalid antigravity configure request.accounts[${String(index)}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label)
  const record = value as Record<string, unknown>
  const id = record.id === undefined ? '' : record.id
  if (typeof id !== 'string') throw new TypeError(`${label}.id`)
  const key = id.trim()
  if (key.length > 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) throw new TypeError(`${label}.id`)
  const displayName = record.displayName === undefined ? '' : record.displayName
  if (typeof displayName !== 'string') throw new TypeError(`${label}.displayName`)
  const home = record.home === undefined ? '' : record.home
  if (typeof home !== 'string') throw new TypeError(`${label}.home`)
  const enabled = record.enabled === undefined ? true : record.enabled
  if (typeof enabled !== 'boolean') throw new TypeError(`${label}.enabled`)
  const contextWindow = record.contextWindow === undefined ? 0 : record.contextWindow
  if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow < 0 || contextWindow > 1_048_576) {
    throw new TypeError(`${label}.contextWindow`)
  }
  const system = record.system === undefined ? false : record.system
  if (typeof system !== 'boolean') throw new TypeError(`${label}.system`)
  const visibleModels = parseVisibleModels(record.visibleModels, `${label}.visibleModels`)
  const priority = record.priority === undefined ? 1 : record.priority
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 999) {
    throw new TypeError(`${label}.priority`)
  }
  const weight = record.weight === undefined ? 1 : record.weight
  if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 100) {
    throw new TypeError(`${label}.weight`)
  }
  const env = record.env === undefined ? {} : record.env
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new TypeError(`${label}.env`)
  const vars: Record<string, string> = {}
  for (const [envName, entry] of Object.entries(env as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new TypeError(`${label}.env.${envName}`)
    vars[envName] = entry
  }
  return {
    id: key,
    displayName,
    home,
    enabled,
    env: vars,
    contextWindow,
    ...system ? { system: true } : {},
    visibleModels,
    priority,
    weight,
  }
}

/**
 * Validate a model allowlist field: strings, trimmed, deduplicated, bounded.
 * An empty array is meaningful — it means "no restriction at this level".
 * @param value - candidate field, undefined when the caller omitted it.
 * @param label - dotted path used in the error message.
 * @returns the normalized ids.
 * @throws when the field is not an array of short non-empty strings.
 */
function parseVisibleModels(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 500) throw new TypeError(label)
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 200) throw new TypeError(label)
    const id = entry.trim()
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Validate one configure request. Retired wire fields an older settings page
 * still sends (`systemProfile`, `useSystemAccount`) and a retired per-account
 * `families` gate are ignored: the account list is the whole truth, so a page
 * that saves it never loses this Mac's own login.
 * @param value - request payload.
 * @returns the live overrides to apply.
 */
export function parseConfigureRequest(value: unknown): LiveOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity configure request')
  const record = value as Record<string, unknown>
  const out: LiveOverrides = {}
  if (record.accounts !== undefined) {
    if (!Array.isArray(record.accounts)) throw new TypeError('Invalid antigravity configure request.accounts')
    out.accounts = record.accounts.map((entry: unknown, index: number) => parseAccountProfile(entry, index))
  }
  if (record.contextWindow !== undefined) {
    if (typeof record.contextWindow !== 'number' || !Number.isInteger(record.contextWindow) || record.contextWindow < 0 || record.contextWindow > 1_048_576) {
      throw new TypeError('Invalid antigravity contextWindow')
    }
    out.contextWindow = record.contextWindow
  }
  if (record.defaultEffort !== undefined) {
    const effort = typeof record.defaultEffort === 'string' ? asEffort(record.defaultEffort) : undefined
    if (effort === undefined) throw new TypeError('Invalid antigravity defaultEffort')
    out.defaultEffort = effort
  }
  if (record.longDecodeContinuations !== undefined) {
    if (typeof record.longDecodeContinuations !== 'number' || !Number.isInteger(record.longDecodeContinuations) || record.longDecodeContinuations < 0 || record.longDecodeContinuations > 16) {
      throw new TypeError('Invalid antigravity longDecodeContinuations')
    }
    out.longDecodeContinuations = record.longDecodeContinuations
  }
  if (record.visibleModels !== undefined) out.visibleModels = parseVisibleModels(record.visibleModels, 'Invalid antigravity configure request.visibleModels')
  return out
}

/**
 * One reported account row as the stored profile spells it, so a save keeps
 * every entry — the machine row included — and never freezes the default
 * display label into a remark.
 * @param row - account status row.
 * @returns the account profile.
 */
export function profileFromStatus(row: AccountStatus): AccountProfile {
  const label = row.label.trim()
  return {
    id: row.id,
    displayName: row.system && label === SYSTEM_ACCOUNT_LABEL ? '' : label,
    home: row.home,
    enabled: row.enabled,
    env: { ...row.env },
    contextWindow: row.contextWindow,
    ...row.system ? { system: true } : {},
    visibleModels: [...row.visibleModels],
    priority: row.priority,
    weight: row.weight,
  }
}

/**
 * Every reported account row as the profile stored in the settings profile.
 * The machine row is part of the list, so a save keeps this Mac's own login.
 * @param rows - accounts reported after the patch.
 * @returns the account list to store.
 */
export function storedAccounts(rows: readonly AccountStatus[]): AccountProfile[] {
  return rows.map(row => profileFromStatus(row))
}

function parseObject(label: string) {
  return (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
    return value
  }
}

function parseArray(label: string) {
  return (value: unknown): unknown => {
    if (!Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
    return value
  }
}

function codec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) } as TypertCodec
}

const statusCodec = codec(`${PACKAGE_NAME}#Status`, parseObject('antigravity status'))
const quotaCodec = codec(`${PACKAGE_NAME}#Quota`, parseObject('antigravity quota'))
const requestCodec = codec(`${PACKAGE_NAME}#QuotaRequest`, parseQuotaRequest)
const configureCodec = codec(`${PACKAGE_NAME}#ConfigureRequest`, parseConfigureRequest)
const accountsCodec = codec(`${PACKAGE_NAME}#Accounts`, parseArray('antigravity accounts'))
const loginCodec = codec(`${PACKAGE_NAME}#LoginRequest`, parseLoginRequest)
const loginCodeRequestCodec = codec(`${PACKAGE_NAME}#LoginCodeRequest`, parseLoginCodeRequest)
const ticketCodec = codec(`${PACKAGE_NAME}#LoginTicket`, parseObject('antigravity login ticket'))
const loginResultCodec = codec(`${PACKAGE_NAME}#LoginResult`, parseObject('antigravity login result'))

/** Invocation descriptors registered with the Host Gateway. */
export const INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/status`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'status',
    invocation: { kind: 'direct' },
    parameters: [],
    result: statusCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/quota`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'quota',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
    result: quotaCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/warmup`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'warmup',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
    result: statusCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/configure`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'configure',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: configureCodec }],
    result: statusCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/accounts`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'accounts',
    invocation: { kind: 'direct' },
    parameters: [],
    result: accountsCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/login`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'login',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
    result: ticketCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/loginCode`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'loginCode',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodeRequestCodec }],
    result: loginResultCodec,
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/cancelLogin`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: 'cancelLogin',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
    result: statusCodec,
  },
] as InvocationDescriptor[]

interface SettingsWriter {
  writable?: boolean
  update?(ns: string, values: Record<string, unknown>): Promise<void>
}

/** Remote facade over the runtime. */
export class AntigravityRemote {
  /**
   * @param ctx - host context that may expose a settings writer via `get('settings')`.
   * @param options - runtime and settings namespace.
   */
  constructor(
    private readonly ctx: HostContext | undefined,
    private readonly options: { runtime: AntigravityRuntime; settingsNs: string },
  ) {}

  /**
   * Provider status.
   * @returns the status snapshot.
   */
  status(): RuntimeStatus {
    return this.options.runtime.status()
  }

  /**
   * Plan quota for every model group.
   * @param request - optional cache bypass, account, or model to resolve.
   * @returns the quota snapshot.
   */
  quota(request?: QuotaRequest): Promise<QuotaSnapshot> {
    const force = request?.force === true
    if (request?.accountId !== undefined) return this.options.runtime.quotaFor(request.accountId, force)
    if (request?.model !== undefined) return this.options.runtime.quotaForModel(request.model, force, request.sessionId)
    return this.options.runtime.quotaFor(undefined, force)
  }

  /**
   * Refresh the catalog of one or all accounts without sending a prompt.
   * @param request - optional target `accountId`.
   * @returns the status after warmup.
   */
  async warmup(request?: QuotaRequest): Promise<RuntimeStatus> {
    try {
      await this.options.runtime.warmup(request?.accountId)
    } catch (_warmupFailure) {
      // The failure is reported through the returned status.
    }
    return this.options.runtime.status()
  }

  /**
   * Apply live settings and persist them into the profile settings when writable.
   * @param request - updated configuration fields.
   * @returns updated status.
   */
  async configure(request: LiveOverrides): Promise<RuntimeStatus> {
    const patch = parseConfigureRequest(request)
    const status = this.options.runtime.configure(patch)
    const settings = this.ctx?.get?.('settings') as SettingsWriter | undefined
    if (settings?.writable === true && typeof settings.update === 'function') {
      const stored: LiveOverrides = { ...patch }
      if (patch.accounts !== undefined) {
        // The machine account travels inside the list: storing the reported
        // rows keeps it and leaves its default label unremark'd. A request
        // that dropped it stores a list without it, which is the removal.
        stored.accounts = storedAccounts(status.accounts)
      }
      try {
        await settings.update(this.options.settingsNs, { ...stored })
      } catch (_persistSkipped) {
        // Ephemeral or overlay-mounted entries may not exist in the profile patch; in-memory override still applies.
      }
    }
    return status
  }

  /**
   * Every configured account with its live process state, cooldowns, and sign-in.
   * @returns one row per account in configured order.
   */
  async accounts(): Promise<AccountStatus[]> {
    await this.options.runtime.refreshAccountEmails()
    return this.options.runtime.accounts()
  }

  /**
   * Create the account sandbox and start an interactive sign-in.
   * @param request - the account to sign in.
   * @returns the authorization URL and the equivalent terminal command.
   */
  login(request: LoginRequest): Promise<LoginTicket> {
    return this.options.runtime.beginLogin(parseLoginRequest(request).accountId)
  }

  /**
   * Finish an interactive sign-in with the authorization code from the browser.
   * @param request - the account and its authorization code.
   * @returns whether the account now holds a credential.
   */
  loginCode(request: LoginCodeRequest): Promise<LoginResult> {
    const parsed = parseLoginCodeRequest(request)
    return this.options.runtime.completeLogin(parsed.accountId, parsed.code)
  }

  /**
   * Abandon a pending interactive sign-in.
   * @param request - the account whose sign-in should stop.
   * @returns status after the sign-in process was terminated.
   */
  cancelLogin(request: LoginRequest): RuntimeStatus {
    this.options.runtime.cancelLogin(parseLoginRequest(request).accountId)
    return this.options.runtime.status()
  }
}

/**
 * No-op on OMP: slash commands replace the DSH Host Gateway.
 * @param _ctx - unused.
 */
export function registerRemote(_ctx: HostContext | undefined): void {
  return
}
