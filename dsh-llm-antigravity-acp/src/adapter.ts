/**
 * Catalog, exact-model metadata, and streaming through the ACP runtime.
 * @module omp-antigravity-acp/adapter
 */

import { EFFORT_NAMES, nearestEffort } from './catalog.ts'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from './host-types.ts'
import type { AntigravityRuntime } from './runtime.ts'

/** Degraded-route failures are re-asked by the host retry layer with the identical request. */
const RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'DEGRADED_ROUTE']

/** Retry policy DSH tests (and OMP callers) inspect. */
export interface ResolvedRetryPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: string[]
}

const ANTIGRAVITY_RETRY_POLICY: ResolvedRetryPolicy = {
  mode: 'normal',
  maxRetries: 4,
  retryableCodes: [...RETRYABLE_CODES],
}

/** Antigravity primary-model adapter. */
export class AntigravityAdapter {
  /**
   * @param runtime - process and session owner.
   * @param displayName - provider group name.
   * @param imageInput - whether request images can be read.
   */
  constructor(
    private readonly runtime: AntigravityRuntime,
    private readonly displayName: string,
    private readonly imageInput: () => boolean,
  ) {}

  /** Host retry policy for this route. */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return ANTIGRAVITY_RETRY_POLICY
  }

  /** Provider group shown in the picker. */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /** Advertised families. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.runtime.catalog.list().map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: 'Antigravity via the official ACP server',
      inputModalities: this.imageInput() ? ['text', 'image'] as const : ['text'] as const,
    })))
  }

  /** Exact metadata for one family. */
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.runtime.catalog.find(model)
    const efforts = this.runtime.catalog.effortsFor(model)
    const defaultEffort = efforts.length > 0 ? nearestEffort(this.runtime.defaultEffort(), efforts) : undefined
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.imageInput() ? ['text', 'image'] as const : ['text'] as const,
      context: { contextWindow: this.runtime.contextWindowFor(model) },
      ...efforts.length > 0 ? {
        reasoning: {
          efforts: efforts.map(id => ({ id, name: EFFORT_NAMES[id] })),
          ...defaultEffort !== undefined ? { defaultEffort } : {},
        },
      } : {},
      systemPromptUpdate: 'in-history',
      toolUpdate: 'in-history',
    })
  }

  /** Stream one generation. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.runtime.stream(options)
  }
}
