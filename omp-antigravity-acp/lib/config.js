/**
 * Plugin configuration. Live fields are plain values: OMP slash commands and
 * the on-disk settings file update them, and the next request reads the new
 * value without restarting the extension.
 * @module omp-antigravity-acp/config
 */
/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'];
/** Built-in defaults. */
export const DEFAULT_CONFIG = {
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
};
/**
 * Apply defaults over a partial configuration. Callable as `Config({})` so
 * existing tests keep working.
 * @param overrides - fields to set.
 */
export function Config(overrides = {}) {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        accounts: overrides.accounts ?? DEFAULT_CONFIG.accounts,
        visibleModels: overrides.visibleModels ?? DEFAULT_CONFIG.visibleModels,
    };
}
/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or a live view with `get()`.
 */
export function current(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value) {
    return EFFORTS.includes(value ?? '') ? value : undefined;
}
