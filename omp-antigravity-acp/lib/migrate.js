/**
 * One-shot migration of a stored plugin configuration to the merged shape: an
 * account's `families` becomes a concrete `visibleModels` list, and the old
 * `useSystemAccount` / `systemProfile` pair becomes a `system: true` row at the
 * head of `accounts`.
 *
 * The function is pure: it never mutates its argument, plays no role at
 * runtime, and running it on its own output returns that output unchanged with
 * `changed === false`.
 * @module omp-antigravity-acp/migrate
 */
import { accountVisibleModels, familyForModel, MODEL_FAMILIES, SYSTEM_ACCOUNT_ID } from "./accounts.js";
/**
 * Version written to every migrated configuration. From version 2 on the
 * account list is the only truth for the machine account, so a list without a
 * `system: true` row means the user removed it and nothing gets added back.
 */
export const CONFIG_VERSION = 2;
/** Defaults of the machine account, mirroring the account schema in `./config.ts`. */
const CONTEXT_WINDOW_DEFAULT = 0;
/** Default scheduling priority, mirroring the account schema. */
const PRIORITY_DEFAULT = 1;
/** Default scheduling weight, mirroring the account schema. */
const WEIGHT_DEFAULT = 1;
/** Prefix of every warning this module reports. */
const WARN = 'antigravity-acp: ';
/** @param value - candidate from a stored config. @returns whether it is a plain object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** @param value - candidate list. @returns its string members, or an empty list. */
function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
/** @param value - candidate environment. @returns a copy holding only string values. */
function stringRecord(value) {
    const out = {};
    if (!isRecord(value))
        return out;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string')
            out[key] = item;
    }
    return out;
}
/** @param value - candidate number. @param minimum - lower bound. @param fallback - value used when invalid. @returns a finite number at or above `minimum`. */
function numberAtLeast(value, minimum, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}
/** @param profile - account profile. @returns the id quoted for a warning, or a placeholder. */
function accountLabel(profile) {
    const id = typeof profile.id === 'string' ? profile.id.trim() : '';
    return id.length === 0 ? '(unnamed)' : `"${id}"`;
}
/**
 * Structural equality of two stored values, ignoring object key order.
 *
 * Used to decide whether a migrated value still differs from what the profile
 * already holds, so a boot write-back stays silent when there is nothing to do.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether both carry the same data.
 */
export function storedEqual(left, right) {
    if (left === right)
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
            return false;
        return left.every((item, index) => storedEqual(item, right[index]));
    }
    if (!isRecord(left) || !isRecord(right))
        return false;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length)
        return false;
    return keys.every(key => Object.hasOwn(right, key) && storedEqual(left[key], right[key]));
}
/**
 * Keep only known model families, in canonical order. Accounts no longer carry
 * a family gate, so this lives here to normalize what an older file declares.
 * @param value - declared family ids.
 * @returns the families an older account declaration could serve.
 */
function accountFamilies(value) {
    if (value === undefined || value.length === 0)
        return [];
    return MODEL_FAMILIES.filter(family => value.includes(family));
}
/**
 * Fold one stored account's retired `families` gate into its `visibleModels`.
 *
 * An empty `families` means "every family" and becomes "follow the provider",
 * so the key is dropped. A non-empty one is expanded against the provider
 * allowlist (or the catalog when the provider lists nothing) and intersected
 * with a `visibleModels` the account already declared, because the two gates
 * were an AND. When the result would be empty the account would silently widen
 * to the whole provider list, so its `families` stay untouched and the caller
 * gets a warning instead.
 * @param profile - one stored account entry.
 * @param providerVisible - normalized provider-level `visibleModels`.
 * @param catalogIds - model ids known to the current catalog.
 * @param warnings - collector for notes that need a human decision.
 * @returns a migrated copy of the entry.
 */
export function migrateAccountProfile(profile, providerVisible, catalogIds, warnings = []) {
    const next = { ...profile };
    const declaredFamilies = stringList(profile.families);
    const families = accountFamilies(declaredFamilies);
    delete next.families;
    if (families.length === 0)
        return next;
    const label = accountLabel(profile);
    let candidates;
    if (providerVisible.length > 0) {
        candidates = providerVisible;
    }
    else {
        candidates = catalogIds;
        warnings.push(`${WARN}account ${label} declares families but the provider offers no visibleModels; its model list was fixed from the current catalog, confirm it in the settings page`);
    }
    const allowed = candidates.filter(id => families.includes(familyForModel(id)));
    const declaredModels = accountVisibleModels(stringList(profile.visibleModels));
    const narrowed = declaredModels.length > 0 ? declaredModels.filter(id => allowed.includes(id)) : allowed;
    if (narrowed.length === 0) {
        warnings.push(`${WARN}account ${label} would match no model once families is folded into visibleModels; its families were kept for a manual review`);
        next.families = declaredFamilies;
        return next;
    }
    next.visibleModels = narrowed;
    return next;
}
/**
 * Build the machine-account entry out of the retired `systemProfile`.
 * @param profile - stored `systemProfile`, possibly empty or malformed.
 * @returns the account entry, still carrying `families` for {@link migrateAccountProfile}.
 */
function systemProfileAccount(profile) {
    return {
        id: SYSTEM_ACCOUNT_ID,
        system: true,
        displayName: '',
        home: '',
        enabled: true,
        env: stringRecord(profile.env),
        contextWindow: numberAtLeast(profile.contextWindow, 0, CONTEXT_WINDOW_DEFAULT),
        families: stringList(profile.families),
        visibleModels: stringList(profile.visibleModels),
        priority: numberAtLeast(profile.priority, 1, PRIORITY_DEFAULT),
        weight: numberAtLeast(profile.weight, 1, WEIGHT_DEFAULT),
    };
}
/**
 * Normalize one stored account list to the merged shape.
 *
 * This is the reading entry of the account list: the runtime resolves the live
 * `accounts` setting through it on every read, so a list edited in the settings
 * page reaches the scheduler in its merged form without touching the profile.
 *
 * A configuration that already declares `configVersion >= 2`, or a list that
 * already holds a `system: true` entry, is used as it is apart from the retired
 * per-account `families` fold, so removing the machine account stays removed.
 * Older lists get the machine account back when `useSystemAccount` is not
 * `false`.
 * @param raw - stored account list, possibly from an older schema.
 * @param options - shape version, provider allowlist, catalog, and retired keys.
 * @returns the normalized account entries, in declared order.
 */
export function normalizeAccounts(raw, options) {
    const warnings = options.warnings ?? [];
    const stored = Array.isArray(raw) ? raw : [];
    const accounts = stored.map(entry => isRecord(entry)
        ? migrateAccountProfile(entry, options.providerVisible, options.catalogIds, warnings)
        : entry);
    const hasSystemAccount = accounts.some(entry => isRecord(entry) && entry.system === true);
    if (options.modern || hasSystemAccount || options.useSystemAccount === false)
        return accounts;
    if (accounts.some(entry => isRecord(entry) && entry.id === SYSTEM_ACCOUNT_ID)) {
        warnings.push(`${WARN}a declared account already uses the id "${SYSTEM_ACCOUNT_ID}"; the machine account was not added`);
        return accounts;
    }
    const source = isRecord(options.systemProfile) ? options.systemProfile : {};
    accounts.unshift(migrateAccountProfile(systemProfileAccount(source), options.providerVisible, options.catalogIds, warnings));
    return accounts;
}
/**
 * Migrate one stored plugin configuration.
 *
 * Every other key is carried over untouched. A configuration that already
 * carries `configVersion >= 2` uses the account list as the only truth: the
 * machine account is never added back, and the retired `systemProfile` /
 * `useSystemAccount` keys are dropped whether they hold a real value or a
 * schema default. Older configurations are converted once: the machine account
 * is generated when `useSystemAccount` is not `false`, and the result is
 * stamped with `configVersion` 2 unless it already declares a newer one.
 * @param raw - stored configuration, possibly from an older schema.
 * @param catalogIds - model ids the current catalog advertises.
 * @returns the migrated config, whether anything changed, and warnings.
 */
export function migrateConfig(raw, catalogIds) {
    const input = isRecord(raw) ? raw : {};
    const warnings = [];
    const config = { ...input };
    const version = input.configVersion;
    const modern = typeof version === 'number' && Number.isFinite(version) && version >= CONFIG_VERSION;
    const providerVisible = accountVisibleModels(stringList(input.visibleModels));
    const accounts = normalizeAccounts(input.accounts, {
        modern,
        providerVisible,
        catalogIds,
        ...input.systemProfile !== undefined ? { systemProfile: input.systemProfile } : {},
        ...input.useSystemAccount !== undefined ? { useSystemAccount: input.useSystemAccount } : {},
        warnings,
    });
    if (Object.hasOwn(input, 'accounts') || accounts.length > 0)
        config.accounts = accounts;
    delete config.systemProfile;
    delete config.useSystemAccount;
    const declaredVersion = typeof version === 'number' && Number.isFinite(version) ? version : 0;
    // A file written by a newer build keeps its version: migrating must never
    // downgrade a shape this module does not fully know.
    config.configVersion = Math.max(CONFIG_VERSION, declaredVersion);
    return { config, changed: !storedEqual(input, config), warnings };
}
