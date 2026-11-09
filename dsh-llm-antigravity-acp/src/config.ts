/**
 * Plugin configuration. Live fields are plain values: OMP slash commands and
 * the on-disk settings file update them, and the next request reads the new
 * value without restarting the extension.
 * @module omp-antigravity-acp/config
 */

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = typeof EFFORTS[number]

/** One declared account of the pool. */
export interface AccountProfile {
  /** Directory key under the pool root. Empty asks the pool to assign one and save it back. */
  id: string
  /** Optional remark shown in status. Empty shows as untitled. */
  displayName: string
  /** Absolute account root; empty uses `<plugin home>/accounts/<id>`. */
  home: string
  /** Disabled accounts keep their files and login but receive no traffic. */
  enabled: boolean
  /** Extra environment for this account's CLI processes, such as a dedicated `HTTPS_PROXY`. */
  env: Record<string, string>
  /** Context-window override in tokens. `0` follows the provider default. */
  contextWindow: number
  /**
   * Keep this machine's own login, `$HOME`, and keychain. Such an entry is
   * always enabled and its id defaults to `default`.
   */
  system?: boolean
  /**
   * Fine-grained subset of the provider's visible families. Empty inherits the
   * provider allowlist; the effective set is always
   * `provider ∩ account`, so this can only narrow what the provider offers.
   */
  visibleModels: string[]
  /** Scheduling priority (`1..999`, default `1`); smaller values take precedence (`1` beats `2`). */
  priority?: number
  /** Scheduling weight (`1..100`, default `1`); distributes load proportionally within the same priority tier. */
  weight?: number
}

/** Validated plugin configuration. */
export interface Config {
  /** Provider route id shown in the model picker. */
  provider: string
  /** Display name of the provider group. */
  displayName: string
  /** Absolute path of the `agy` executable; empty resolves `~/.local/bin/agy`, then `agy` on PATH. */
  command: string
  /** Isolated Antigravity home for ACP sessions; empty uses `$OMP_HOME/cache/antigravity-acp`. */
  home: string
  /**
   * Every account of the pool, the machine account included as the entry with
   * `system: true`. The list is the only truth: no entry means no machine
   * account.
   */
  accounts: AccountProfile[]
  /**
   * Shape version of the stored configuration, migrated at plugin load. `0`
   * means the stored file predates the account list and still needs migration.
   */
  configVersion: number
  /**
   * Model families offered in the picker, as a subset of what the CLI
   * advertises. Empty offers every advertised family.
   */
  visibleModels: string[]
  /** Declared context window in tokens; 0 selects 1,048,576 for an unlocked binary and 256,000 otherwise. */
  contextWindow: number
  /** Effort applied when a request carries none. */
  defaultEffort: Effort
  /** Check the binary with the local context-unlock script before starting ACP, and apply it when needed. */
  autoPatch: boolean
  /** Context-unlock script; empty uses `~/.gemini/antigravity/tools/agy-patch.py`. */
  patchScript: string
  /** Maximum concurrent ACP sessions kept alive across conversations, subagents, and auxiliary calls. */
  maxLiveSessions: number
  /** Idle time after which an inactive ACP session is closed. */
  idleSessionTtlMs: number
  /** Window that groups parallel tool calls into one OMP step. */
  parkSettleMs: number
  /** Settle delay in ms after a cold-session `session/set_config_option` switch before sending `session/prompt`. */
  coldSwitchSettleMs: number
  /** SSE keepalive interval for parked tool calls. */
  keepAliveMs: number
  /** Delay in ms before a parked tool call returns a still-running relay notice to refresh cache TTL before agy's 180s MCP deadline. */
  relayAfterMs: number
  /** Automatic continuations after an output-length stop (long decode). */
  longDecodeContinuations: number
  /** Start the ACP process and read the model catalog at plugin load. */
  warmup: boolean
  /** Minimum interval between quota refreshes through `agy -p /usage`. */
  quotaTtlMs: number
}

/** Built-in defaults. */
export const DEFAULT_CONFIG: Config = {
  provider: 'antigravity',
  displayName: 'Antigravity',
  command: '',
  home: '',
  accounts: [],
  configVersion: 0,
  visibleModels: [],
  contextWindow: 0,
  defaultEffort: 'high',
  autoPatch: true,
  patchScript: '',
  maxLiveSessions: 16,
  idleSessionTtlMs: 30 * 60_000,
  parkSettleMs: 250,
  coldSwitchSettleMs: 80,
  keepAliveMs: 15_000,
  relayAfterMs: 85_000,
  longDecodeContinuations: 3,
  warmup: true,
  quotaTtlMs: 120_000,
}

/**
 * Apply defaults over a partial configuration. Callable as `Config({})` so
 * existing tests keep working.
 * @param overrides - fields to set.
 */
export function Config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    accounts: overrides.accounts ?? DEFAULT_CONFIG.accounts,
    visibleModels: overrides.visibleModels ?? DEFAULT_CONFIG.visibleModels,
  }
}

/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or a live view with `get()`.
 */
export function current<T>(value: T | { get(): T }): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value: string | undefined): Effort | undefined {
  return (EFFORTS as readonly string[]).includes(value ?? '') ? value as Effort : undefined
}
