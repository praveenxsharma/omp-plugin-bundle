/**
 * OMP extension: register Antigravity as a command-backed provider that drives
 * the official `agy acp` CLI. Requests never go from OMP to Google's Cloud
 * Code Assist HTTP API; credentials stay inside the official process.
 * @module omp-antigravity-acp/extension
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

import { liveAccounts, name as PLUGIN_NAME, writeMigrationBack } from './boot.ts'
import { FALLBACK_MODELS } from './catalog.ts'
import { Config, current, type AccountProfile, type Config as PluginConfig } from './config.ts'
import { CONFIG_VERSION, migrateConfig } from './migrate.ts'
import { ompImageResolver, streamGenerate, toGenerateOptions, type StreamCallOptions, type StreamContext, type StreamModel } from './omp-stream.ts'
import { defaultHome } from './preflight.ts'
import { AntigravityRuntime } from './runtime.ts'
import { createAcpSpawner, createCommandRunner } from './spawn.ts'

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function settingsPath(home: string): string {
  return join(home.length > 0 ? home : defaultHome(), 'settings.json')
}

function loadStored(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function persist(path: string, config: PluginConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

function modelRow(id: string, name: string, contextWindow: number, reasoning: boolean) {
  return {
    id,
    name,
    reasoning,
    thinking: reasoning
      ? { mode: 'google-level' as const, efforts: ['low', 'medium', 'high'] as const, defaultLevel: 'high' as const }
      : undefined,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: ZERO_COST,
    contextWindow,
    maxTokens: Math.min(64_000, contextWindow),
  }
}

/**
 * OMP extension factory.
 * @param pi - extension API.
 */
export default function antigravityAcp(pi: ExtensionAPI): void {
  const storedPath = settingsPath('')
  const stored = loadStored(storedPath)
  const catalogIds = FALLBACK_MODELS.map(model => model.id)
  const migrated = migrateConfig({ ...Config(), ...stored }, catalogIds)
  for (const warning of migrated.warnings) pi.logger.warn(warning)
  const base = Config(migrated.config as Partial<PluginConfig>)
  const runtimeConfig: PluginConfig = {
    ...base,
    accounts: liveAccounts(base, catalogIds).get(),
  }

  const runtime = new AntigravityRuntime({
    config: runtimeConfig,
    spawnAcp: createAcpSpawner({ HOME: homedir() }),
    runCommand: createCommandRunner({ HOME: homedir() }),
    readImage: ompImageResolver,
    canReadImages: () => true,
    log: {
      info: message => pi.logger.info(message),
      warn: message => pi.logger.warn(message),
    },
    onModelsChanged: () => undefined,
  })

  void writeMigrationBack({
    settings: {
      writable: true,
      update: async (_ns, values) => {
        persist(storedPath, { ...runtimeConfig, ...values } as PluginConfig)
      },
    },
    namespace: PLUGIN_NAME,
    migrated,
    accounts: current(runtimeConfig.accounts),
    configVersion: current(runtimeConfig.configVersion),
    warn: message => pi.logger.warn(message),
  })

  const provider = runtimeConfig.provider

  const toModelConfig = (id: string, name: string) =>
    modelRow(id, name, runtime.contextWindowFor(id), runtime.catalog.effortsFor(id).length > 0)

  pi.registerProvider(provider, {
    baseUrl: 'https://antigravity-acp.invalid/',
    apiKey: 'agy-cli',
    api: 'antigravity-acp',
    streamSimple(model: StreamModel, context: StreamContext, options?: StreamCallOptions) {
      const request = toGenerateOptions(
        provider,
        { id: model.id, provider: model.provider, api: String(model.api) },
        context,
        options,
        runtime.defaultEffort(),
      )
      return streamGenerate(runtime, request, { id: model.id, provider: model.provider, api: String(model.api) })
    },
    fetchDynamicModels: async () => {
      try {
        await runtime.warmup()
      } catch (error) {
        pi.logger.warn(`antigravity-acp: warmup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const listed = runtime.catalog.list()
      if (listed.length === 0) return FALLBACK_MODELS.map(model => toModelConfig(model.id, model.name))
      return listed.map(model => toModelConfig(model.id, model.name))
    },
    models: FALLBACK_MODELS.map(model => toModelConfig(model.id, model.name)),
  })

  pi.on('session_shutdown', () => {
    void runtime.dispose()
  })

  pi.registerCommand('agy-status', {
    description: 'Show Antigravity ACP status, accounts, and unlock state',
    handler: async (_args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => {
      const status = runtime.status()
      const accounts = status.accounts.map(row => {
        const cool = row.cooldowns.length > 0 ? ` cooldown=${row.cooldowns.map(c => c.family).join(',')}` : ''
        return `- ${row.id}${row.system === true ? ' (this machine)' : ''}: ${row.state}${row.email ? ` ${row.email}` : ''}${cool}`
      }).join('\n')
      ctx.ui.notify(
        [
          `Antigravity ACP ${status.state}${status.error ? `: ${status.error}` : ''}`,
          `binary: ${status.binary ?? '(not found)'} ${status.version ?? ''}`,
          `context: ${status.contextWindow} (configured ${status.configuredContextWindow || 'auto'}) unlock=${status.unlock?.status ?? 'unknown'}`,
          `models: ${status.models.map(m => m.id).join(', ') || '(none yet)'}`,
          accounts.length > 0 ? accounts : '- no accounts',
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('agy-login', {
    description: 'Start official agy sign-in for an account (default: this machine). Usage: /agy-login [accountId] [code]',
    handler: async (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const accountId = parts[0] && parts[0] !== 'default' && !/^[A-Za-z]/.test(parts[0] ?? '') ? 'default' : (parts[0] ?? 'default')
      const code = parts.length > 1 ? parts.slice(accountId === (parts[0] ?? '') ? 1 : 0).join(' ') : ''
      try {
        if (code.length > 0 && parts.length >= 2) {
          const result = await runtime.completeLogin(accountId, parts.slice(1).join(' '))
          ctx.ui.notify(result.ok ? `Signed in ${accountId}${result.email ? ` as ${result.email}` : ''}` : `Sign-in failed: ${result.error ?? 'unknown'}`, result.ok ? 'info' : 'error')
          return
        }
        const ticket = await runtime.beginLogin(accountId)
        ctx.ui.notify(
          [
            `Open this URL, then run /agy-login ${accountId} <code>`,
            ticket.url,
            ticket.command ? `Fallback: ${ticket.command}` : '',
          ].filter(Boolean).join('\n'),
          'info',
        )
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.registerCommand('agy-accounts', {
    description: 'List or configure Antigravity accounts. Usage: /agy-accounts [add <id>|enable <id>|disable <id>]',
    handler: async (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const action = parts[0]
      const id = parts[1]
      try {
        if (action === 'add' && id) {
          const next: AccountProfile[] = [
            ...runtime.status().accounts.map(row => ({
              id: row.id,
              displayName: row.label,
              home: row.home,
              enabled: row.enabled,
              env: { ...row.env },
              contextWindow: row.contextWindow,
              ...row.system ? { system: true as const } : {},
              visibleModels: [...row.visibleModels],
              priority: row.priority,
              weight: row.weight,
            })),
            { id, displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [] },
          ]
          runtime.configure({ accounts: next })
          persist(storedPath, { ...runtimeConfig, accounts: next, configVersion: CONFIG_VERSION })
          ctx.ui.notify(`Added account ${id}. Run /agy-login ${id}`, 'info')
          return
        }
        if ((action === 'enable' || action === 'disable') && id) {
          const next: AccountProfile[] = runtime.status().accounts.map(row => ({
            id: row.id,
            displayName: row.label,
            home: row.home,
            enabled: row.id === id ? action === 'enable' : row.enabled,
            env: { ...row.env },
            contextWindow: row.contextWindow,
            ...row.system ? { system: true as const } : {},
            visibleModels: [...row.visibleModels],
            priority: row.priority,
            weight: row.weight,
          }))
          runtime.configure({ accounts: next })
          persist(storedPath, { ...runtimeConfig, accounts: next, configVersion: CONFIG_VERSION })
          ctx.ui.notify(`${action}d ${id}`, 'info')
          return
        }
        const rows = runtime.status().accounts
        ctx.ui.notify(rows.length === 0 ? 'No accounts. /agy-login adds this machine, or /agy-accounts add <id>.' : rows.map(row => `${row.id}${row.system ? ' (machine)' : ''} ${row.enabled ? 'on' : 'off'} ${row.email ?? ''}`).join('\n'), 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  if (runtimeConfig.warmup) {
    void runtime.warmup().catch((error: unknown) => {
      pi.logger.warn(`antigravity-acp: warmup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

}
