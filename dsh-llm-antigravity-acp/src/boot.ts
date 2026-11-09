/**
 * Boot-time config migration write-back and the live account list view.
 * @module omp-antigravity-acp/boot
 */

import { accountVisibleModels } from './accounts.ts'
import { current, type AccountProfile, type Config } from './config.ts'
import { CONFIG_VERSION, migrateConfig, normalizeAccounts, storedEqual, type MigrationResult } from './migrate.ts'

export { Config } from './config.ts'
export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

/** Settings surface the boot write-back needs. */
export interface SettingsWriter {
  writable?: boolean
  update?(ns: string, values: Record<string, unknown>): Promise<void>
}

/** What a boot write-back did. */
export type MigrationWriteOutcome = 'written' | 'skipped' | 'failed'

/** @param version - stored `configVersion`. @returns whether the file already declares the merged shape. */
function isCurrentShape(version: unknown): boolean {
  return typeof version === 'number' && Number.isFinite(version) && version >= CONFIG_VERSION
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
export async function writeMigrationBack(input: {
  settings: SettingsWriter | undefined
  namespace: string
  migrated: MigrationResult
  accounts: unknown
  configVersion: unknown
  warn(message: string): void
}): Promise<MigrationWriteOutcome> {
  const { settings, migrated } = input
  if (!migrated.changed) return 'skipped'
  if (settings?.writable !== true || typeof settings.update !== 'function') return 'skipped'
  const values: Record<string, unknown> = {}
  if (Object.hasOwn(migrated.config, 'accounts') && !storedEqual(migrated.config.accounts, input.accounts)) {
    values.accounts = migrated.config.accounts
  }
  if (!storedEqual(migrated.config.configVersion, input.configVersion)) {
    values.configVersion = migrated.config.configVersion
  }
  if (Object.keys(values).length === 0) return 'skipped'
  try {
    await settings.update(input.namespace, values)
    return 'written'
  } catch (error) {
    input.warn(`antigravity-acp: could not store the migrated configuration: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

/**
 * The account list as the runtime reads it.
 * @param config - validated configuration.
 * @param catalogIds - model ids the current catalog advertises.
 */
export function liveAccounts(
  config: Pick<Config, 'accounts' | 'configVersion' | 'visibleModels'>,
  catalogIds: readonly string[],
): { get(): AccountProfile[] } {
  return {
    get: () => normalizeAccounts(current(config.accounts), {
      modern: isCurrentShape(current(config.configVersion)),
      providerVisible: accountVisibleModels(current(config.visibleModels)),
      catalogIds,
    }) as unknown as AccountProfile[],
  }
}

/**
 * Read a configuration object as plain data.
 * @param config - validated configuration.
 */
export function storedConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) out[key] = current(value)
  return out
}

export { migrateConfig, CONFIG_VERSION }
