/**
 * Boot-time config migration write-back and the live account list view.
 * @module omp-antigravity-acp/boot
 */
import { accountVisibleModels } from "./accounts.js";
import { current } from "./config.js";
import { CONFIG_VERSION, migrateConfig, normalizeAccounts, storedEqual } from "./migrate.js";
export { Config } from "./config.js";
export const name = 'omp-antigravity-acp';
export const inject = ['llm', 'subprocess'];
/** @param version - stored `configVersion`. @returns whether the file already declares the merged shape. */
function isCurrentShape(version) {
    return typeof version === 'number' && Number.isFinite(version) && version >= CONFIG_VERSION;
}
/**
 * Store the migrated configuration in the plugin's settings file.
 * @param input.settings - settings service, when the host offers one.
 * @param input.namespace - plugin settings namespace.
 * @param input.migrated - result of the boot migration.
 * @param input.accounts - account list the profile holds right now.
 * @param input.configVersion - `configVersion` the profile holds right now.
 * @param input.warn - logger for a write that could not be stored.
 */
export async function writeMigrationBack(input) {
    const { settings, migrated } = input;
    if (!migrated.changed)
        return 'skipped';
    if (settings?.writable !== true || typeof settings.update !== 'function')
        return 'skipped';
    const values = {};
    if (Object.hasOwn(migrated.config, 'accounts') && !storedEqual(migrated.config.accounts, input.accounts)) {
        values.accounts = migrated.config.accounts;
    }
    if (!storedEqual(migrated.config.configVersion, input.configVersion)) {
        values.configVersion = migrated.config.configVersion;
    }
    if (Object.keys(values).length === 0)
        return 'skipped';
    try {
        await settings.update(input.namespace, values);
        return 'written';
    }
    catch (error) {
        input.warn(`antigravity-acp: could not store the migrated configuration: ${error instanceof Error ? error.message : String(error)}`);
        return 'failed';
    }
}
/**
 * The account list as the runtime reads it.
 * @param config - validated configuration.
 * @param catalogIds - model ids the current catalog advertises.
 */
export function liveAccounts(config, catalogIds) {
    return {
        get: () => normalizeAccounts(current(config.accounts), {
            modern: isCurrentShape(current(config.configVersion)),
            providerVisible: accountVisibleModels(current(config.visibleModels)),
            catalogIds,
        }),
    };
}
/**
 * Read a configuration object as plain data.
 * @param config - validated configuration.
 */
export function storedConfig(config) {
    const out = {};
    for (const [key, value] of Object.entries(config))
        out[key] = current(value);
    return out;
}
export { migrateConfig, CONFIG_VERSION };
