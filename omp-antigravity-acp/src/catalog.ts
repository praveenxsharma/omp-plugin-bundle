/**
 * Model catalog derived from the agent's session configuration options. The
 * ACP server advertises model families (`gemini-4-argon`, `claude-opus-5-5`)
 * and a separate `thought_level` option; DSH lists each family once with the
 * efforts that family actually offers. Fixed-effort families such as
 * `gpt-oss-120b-medium` carry their effort in the id and expose no selector.
 * @module omp-antigravity-acp/catalog
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AcpConfigOption } from './acp-process.ts'
import { EFFORTS, type Effort } from './config.ts'

/** One advertised model family. */
export interface CatalogModel {
  id: string
  name: string
}

/** One entry of the ACP `models.availableModels` list. */
export interface AvailableModel {
  modelId: string
  name?: string
}

/** One advertised family with the visibility the current allowlist gives it. */
export interface CatalogAvailableModel {
  id: string
  name: string
  enabled: boolean
}

/**
 * Whether one id is offered by an allowlist that may only narrow.
 * @param id - family id.
 * @param allow - configured ids; empty means "every id".
 * @returns true when the id survives the allowlist.
 */
export function isListedModel(id: string, allow: readonly string[]): boolean {
  return allow.length === 0 || allow.includes(id)
}

/**
 * Intersect two narrowing allowlists. An empty list means "everything", so the
 * empty side always defers to the other one.
 * @param provider - provider-level ids.
 * @param account - account-level ids.
 * @returns the ids the pair permits; empty when both are unrestricted.
 */
export function intersectVisible(provider: readonly string[], account: readonly string[]): string[] {
  if (provider.length === 0) return [...account]
  if (account.length === 0) return [...provider]
  return provider.filter(id => account.includes(id))
}

/** Families shown before the first ACP session reports the account's catalog. */
export const FALLBACK_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

/** Display names of the efforts. */
export const EFFORT_NAMES: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** An id that already names one fixed effort instead of a selectable family. */
const FIXED_EFFORT = /-(low|medium|high)$/

/**
 * Pick the offered effort closest to the requested one.
 * @param wanted - requested effort.
 * @param offered - efforts the model exposes.
 * @returns one of `offered`, or `wanted` when nothing is offered.
 */
export function nearestEffort(wanted: Effort, offered: readonly Effort[]): Effort {
  if (offered.includes(wanted)) return wanted
  const distance = (effort: Effort): number => Math.abs(EFFORTS.indexOf(effort) - EFFORTS.indexOf(wanted))
  let best: Effort | undefined
  for (const effort of offered) {
    if (best === undefined || distance(effort) < distance(best)) best = effort
  }
  return best ?? wanted
}

/** Observed catalog with a disk cache. */
export class ModelCatalog {
  private models: CatalogModel[]
  /**
   * Every family the CLI advertises on `session/new`. Visibility is derived
   * from this through `visibleModels`, so widening the allowlist after an
   * observation never needs another ACP session.
   */
  private advertised: CatalogModel[]
  /** Current allowlist; empty offers every advertised family. */
  private visible: string[] = []
  private efforts: Effort[] = [...EFFORTS]
  /** Efforts per model family; an empty array marks a fixed-effort model. */
  private byModel = new Map<string, Effort[]>()
  /** Upstream max input tokens per model family, when discovered. */
  private maxTokens = new Map<string, number>()
  /** Latest `availableModels` snapshot, kept for later option updates. */
  private available: readonly AvailableModel[] | undefined
  /** Whether a live ACP session has reported the catalog. */
  observed = false

  /** @param cachePath - JSON cache file. */
  constructor(private readonly cachePath: string) {
    this.advertised = this.load() ?? [...FALLBACK_MODELS]
    this.models = this.advertised
  }

  /** Current families (the advertised set narrowed by the allowlist). */
  list(): readonly CatalogModel[] {
    return this.models
  }

  /**
   * Advertised families with their current visibility, for the model picker.
   * @returns one row per advertised family, in CLI order.
   */
  availableModels(): readonly CatalogAvailableModel[] {
    return this.advertised.map(model => ({
      id: model.id,
      name: model.name,
      enabled: isListedModel(model.id, this.visible),
    }))
  }

  /** Current allowlist; empty means every advertised family. */
  visibleModels(): readonly string[] {
    return this.visible
  }

  /**
   * Narrow the offered families without a new observation.
   * @param visible - configured ids; empty restores every advertised family.
   * @returns whether the offered list changed.
   */
  applyVisibility(visible: readonly string[]): boolean {
    const before = JSON.stringify(this.models)
    this.visible = [...visible]
    this.models = this.advertised.filter(model => isListedModel(model.id, this.visible))
    return before !== JSON.stringify(this.models)
  }

  /** Efforts the account offers globally, in escalation order. */
  effortList(): readonly Effort[] {
    return this.efforts
  }

  /**
   * Efforts one family actually offers. Empty means the family is a single
   * fixed variant (for example `gpt-oss-120b-medium`).
   * @param id - family id.
   * @returns offered efforts.
   */
  effortsFor(id: string): readonly Effort[] {
    const observed = this.byModel.get(id)
    if (observed !== undefined) return observed
    return this.fixedEffort(id) === undefined ? this.efforts : []
  }

  /**
   * Effort baked into a fixed-variant id.
   * @param id - family id.
   * @returns the effort, or undefined for a selectable family.
   */
  fixedEffort(id: string): Effort | undefined {
    const match = FIXED_EFFORT.exec(id)
    return match === null ? undefined : match[1] as Effort
  }

  /**
   * Find one family.
   * @param id - family id.
   * @returns the catalog entry.
   */
  find(id: string): CatalogModel | undefined {
    return this.models.find(model => model.id === id) ?? this.advertised.find(model => model.id === id)
  }

  /**
   * Upstream context window reported for one family, if discovered.
   * @param id - family id.
   * @returns max input tokens, or undefined when unknown.
   */
  maxTokensFor(id: string): number | undefined {
    return this.maxTokens.get(id)
  }

  /**
   * Merge per-account model inventories into the provider-level catalog union.
   * An account on Ultra may offer `claude-opus-5-5` + `gemini-4-argon` while a
   * promotional/student Pro account offers `claude-opus-4-6-thinking`; the
   * provider union exposes every entitled model so requests route to the
   * account that supports them.
   * @param inventories - ordered model lists of enabled signed-in accounts.
   * @param effortsByModel - merged per-model efforts across accounts.
   * @param maxTokensByModel - merged per-model context windows across accounts.
   * @param visible - provider allowlist.
   * @returns whether the offered list changed.
   */
  mergeAccountInventories(
    inventories: readonly (readonly CatalogModel[])[],
    effortsByModel: Readonly<Record<string, readonly Effort[]>>,
    maxTokensByModel: Readonly<Record<string, number>>,
    visible?: readonly string[],
  ): boolean {
    if (visible !== undefined) this.visible = [...visible]
    const union: CatalogModel[] = []
    const seen = new Set<string>()
    for (const list of inventories) {
      for (const item of list) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        union.push({ id: item.id, name: item.name })
      }
    }
    if (union.length === 0) return false
    this.observed = true
    let metaChanged = false
    for (const [id, offered] of Object.entries(effortsByModel)) {
      const next = EFFORTS.filter(e => offered.includes(e))
      if (JSON.stringify(this.byModel.get(id)) !== JSON.stringify(next)) {
        this.byModel.set(id, next)
        metaChanged = true
      }
    }
    for (const [id, tokens] of Object.entries(maxTokensByModel)) {
      if (tokens > 0 && this.maxTokens.get(id) !== tokens) {
        this.maxTokens.set(id, tokens)
        metaChanged = true
      }
    }
    const changed = JSON.stringify(union) !== JSON.stringify(this.advertised)
    if (changed) this.advertised = union
    const narrowed = this.applyVisibility(this.visible)
    if (changed || narrowed || metaChanged) this.save()
    return changed || narrowed
  }

  /**
   * Fold session configuration options and the session's model inventory into
   * the catalog.
   * @param options - options from `session/new` or `config_option_update`.
   * @param available - `models.availableModels` from `session/new`.
   * @param visible - allowlist to apply; omitted keeps the current one.
   * @returns whether the family list changed.
   */
  observe(
    options: readonly AcpConfigOption[] | undefined,
    available?: readonly AvailableModel[] | undefined,
    visible?: readonly string[] | undefined,
  ): boolean {
    if (visible !== undefined) this.visible = [...visible]
    if (available !== undefined && available.length > 0) this.available = available
    if (options === undefined) return false
    const modelOption = options.find(o => o.id === 'model' || o.category === 'model')
    const levelOption = options.find(o => o.id === 'thought_level' || o.category === 'thought_level')
    const beforeEfforts = JSON.stringify(this.efforts)
    if (levelOption?.options !== undefined) {
      const offered = levelOption.options.map(o => o.value).filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
      if (offered.length > 0) this.efforts = EFFORTS.filter(e => offered.includes(e))
    }
    if (modelOption?.options === undefined || modelOption.options.length === 0) return false
    const advertised = modelOption.options
      .map(o => ({ id: o.value, name: o.name ?? o.value }))
    this.observed = true
    const changed = JSON.stringify(advertised) !== JSON.stringify(this.advertised)
    if (changed) this.advertised = advertised
    const narrowed = this.applyVisibility(this.visible)
    const effortsChanged = this.deriveEfforts() || beforeEfforts !== JSON.stringify(this.efforts)
    if (changed || narrowed || effortsChanged) this.save()
    return changed || narrowed
  }

  /** Recompute per-family efforts from the latest inventory across all advertised models. */
  private deriveEfforts(): boolean {
    if (this.available === undefined) return false
    let changed = false
    for (const model of this.advertised) {
      const offered = EFFORTS.filter(effort => this.available!.some(entry => entry.modelId === `${model.id}-${effort}`))
      if (offered.length > 0) {
        if (JSON.stringify(this.byModel.get(model.id)) !== JSON.stringify(offered)) {
          this.byModel.set(model.id, offered)
          changed = true
        }
        continue
      }
      const present = this.available.some(entry => entry.modelId === model.id || entry.modelId.startsWith(`${model.id}-`))
      if (!present) continue
      if ((this.byModel.get(model.id) ?? []).length !== 0) {
        this.byModel.set(model.id, [])
        changed = true
      }
    }
    return changed
  }

  private save(): void {
    try {
      writeFileSync(this.cachePath, `${JSON.stringify({
        // Persist the advertised set, not the narrowed one: a later widen of
        // the allowlist must be able to restore families the CLI reported.
        models: this.advertised,
        efforts: this.efforts,
        byModel: Object.fromEntries(this.byModel),
        maxTokens: Object.fromEntries(this.maxTokens),
      }, null, 2)}\n`)
    } catch (_cacheWrite) {
      // The cache only speeds up the next cold start.
    }
  }

  private load(): CatalogModel[] | undefined {
    if (!existsSync(this.cachePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        models?: CatalogModel[]
        efforts?: string[]
        byModel?: Record<string, string[]>
        maxTokens?: Record<string, number>
      }
      if (Array.isArray(parsed.efforts)) {
        const efforts = parsed.efforts.filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
        if (efforts.length > 0) this.efforts = efforts
      }
      if (parsed.byModel !== null && typeof parsed.byModel === 'object') {
        for (const [id, values] of Object.entries(parsed.byModel)) {
          if (!Array.isArray(values)) continue
          const efforts = values.filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v))
          this.byModel.set(id, efforts)
        }
      }
      if (parsed.maxTokens !== null && typeof parsed.maxTokens === 'object') {
        for (const [id, tokens] of Object.entries(parsed.maxTokens)) {
          if (typeof tokens === 'number' && tokens > 0) this.maxTokens.set(id, tokens)
        }
      }
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(m => typeof m?.id === 'string' && typeof m?.name === 'string')
        : []
      return models.length > 0 ? models : undefined
    } catch (_cacheRead) {
      // A corrupt cache falls back to the built-in families.
      return undefined
    }
  }
}
