/**
 * Host-agnostic request, stream, and error types formerly imported from
 * `@deepseek-ai/dsh-llm`. The ACP runtime still speaks this shape; the OMP
 * extension translates to and from `AssistantMessageEventStream`.
 * @module omp-antigravity-acp/host-types
 */

/** Branded tool-call id. */
export type ToolCallId = string & { readonly __toolCallId: unique symbol }

/**
 * Brand a tool-call id string.
 * @param value - raw id.
 */
export function ToolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

/** Stable provider failure. */
export class LlmError extends Error {
  readonly code: string
  readonly providerRetryAfterMs?: number
  readonly failure: { message: string; code: string; providerRetryAfterMs?: number }

  /**
   * @param message - user-facing text.
   * @param code - stable failure code.
   * @param options - optional cause and retry hint.
   */
  constructor(message: string, code: string, options?: { cause?: unknown; providerRetryAfterMs?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LlmError'
    this.code = code
    const failure: { message: string; code: string; providerRetryAfterMs?: number } = { message, code }
    if (options?.providerRetryAfterMs !== undefined) {
      this.providerRetryAfterMs = options.providerRetryAfterMs
      failure.providerRetryAfterMs = options.providerRetryAfterMs
    }
    this.failure = failure
  }
}


/** One content block of a request or stream. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | {
    type: 'image'
    attachment: { attachmentId: string; width: number; height: number; bytes: number; mediaType: string }
    offloaded?: boolean
  }
  | { type: 'image'; data: string; mimeType: string; offloaded?: boolean }
  | { type: 'file'; attachment: { attachmentId: string } }
  | { type: 'tool-addition'; toolName: string }
  | { type: 'tool-removal'; toolName: string }

/** Image block, attachment or inline. */
export type ImageBlock = Extract<ContentBlock, { type: 'image' }>

/** One tool schema advertised to the model. */
export interface ToolSchema {
  name: string
  description: string
  parameters: { type?: string; [key: string]: unknown }
  deferLoading?: boolean
}

/** Source of a user-role message. */
export interface MessageSource {
  kind: string
  provider?: string
  model?: string
  callId?: string
}

/** One request message. */
export type RequestMessage =
  | { id?: string; role: 'system'; content: ContentBlock[]; source?: MessageSource }
  | { id?: string; role: 'user'; content: ContentBlock[]; source?: MessageSource }
  | { id?: string; role: 'developer'; content: ContentBlock[]; source?: MessageSource }
  | {
    id?: string
    role: 'assistant'
    content: ContentBlock[]
    source: { kind: 'model'; provider: string; model?: string }
  }
  | {
    id?: string
    role: 'tool'
    toolCallId: string
    content: ContentBlock[]
    source?: MessageSource
    isError?: boolean
  }

/** One model generation request. */
export interface GenerateOptions {
  provider: string
  model: string
  messages: RequestMessage[]
  tools?: ToolSchema[]
  sessionId?: string
  signal?: AbortSignal
  reasoningEffort?: string
  system?: string
  purpose?: string
}

/** Token usage reported on a step. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens: number
}

/** Why a step finished. */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

/** One chunk of a generation stream. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** Catalog row. */
export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities: readonly string[]
}

/** Resolved model metadata. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  reasoning?: {
    efforts: { id: string; name: string }[]
    defaultEffort?: string
  }
  systemPromptUpdate?: string
  toolUpdate?: string
}

/** Provider group. */
export interface LlmProviderInfo {
  id: string
  name: string
}
