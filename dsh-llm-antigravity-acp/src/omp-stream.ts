/**
 * Translate OMP `streamSimple` context into the ACP runtime request shape,
 * and runtime stream chunks into `AssistantMessageEvent`s.
 * @module omp-antigravity-acp/omp-stream
 */

import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai'
import { asEffort, type Effort } from './config.ts'
import type {
  ContentBlock, GenerateOptions, RequestMessage, StreamChunk, TokenUsage, ToolSchema,
} from './host-types.ts'
import { LlmError } from './host-types.ts'
import type { ImageResolver } from './history.ts'
import type { AntigravityRuntime } from './runtime.ts'

/** Minimal OMP model row the stream needs. */
export interface StreamModel {
  id: string
  provider: string
  api: string
}

/** Minimal OMP tool row. */
interface StreamTool {
  name: string
  description?: string
  parameters?: unknown
}

/** Minimal OMP message. */
interface StreamMessage {
  role: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

/** Minimal OMP context. */
export interface StreamContext {
  systemPrompt?: string[]
  messages: StreamMessage[]
  tools?: StreamTool[]
}

/** Minimal stream options. */
export interface StreamCallOptions {
  signal?: AbortSignal
  sessionId?: string
  cwd?: string
  reasoning?: string
  disableReasoning?: boolean
}

interface PartialAssistant {
  role: 'assistant'
  content: Array<Record<string, unknown>>
  api: string
  provider: string
  model: string
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    reasoningTokens?: number
  }
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  timestamp: number
}

/**
 * Inline image bytes already present on a content block.
 * @param block - ACP/DSH image block.
 */
export function inlineImageResolver(block: Extract<ContentBlock, { type: 'image' }>): Promise<{ data: string; mimeType: string } | undefined> {
  if ('data' in block && typeof block.data === 'string' && block.data.length > 0) {
    return Promise.resolve({ data: block.data, mimeType: 'mimeType' in block ? block.mimeType : 'image/png' })
  }
  return Promise.resolve(undefined)
}

/**
 * Map OMP thinking to an Antigravity effort.
 * @param value - OMP effort or undefined.
 * @param disable - force the lowest effort.
 */
export function effortFromOptions(value: string | undefined, disable: boolean | undefined, fallback: Effort): Effort {
  if (disable === true) return 'low'
  if (value === 'minimal') return 'low'
  if (value === 'xhigh' || value === 'max') return 'high'
  return asEffort(value) ?? fallback
}

function jsonSchema(parameters: unknown): ToolSchema['parameters'] {
  if (parameters !== null && typeof parameters === 'object') {
    const record = parameters as { type?: unknown; toJsonSchema?: unknown; schema?: unknown }
    if (typeof record.toJsonSchema === 'function') {
      const schema = (record.toJsonSchema as () => unknown)()
      if (schema !== null && typeof schema === 'object') return schema as ToolSchema['parameters']
    }
    if (record.schema !== null && typeof record.schema === 'object') return record.schema as ToolSchema['parameters']
    if (typeof record.type === 'string' || 'properties' in record) return record as ToolSchema['parameters']
  }
  return { type: 'object', properties: {} }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    } else if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'thinking') {
      const text = (block as { thinking?: unknown }).thinking
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

function userBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string') {
      blocks.push({ type: 'image', data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png' })
    }
  }
  return blocks
}

function assistantBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    const block = item as {
      type?: unknown
      text?: unknown
      thinking?: unknown
      id?: unknown
      name?: unknown
      arguments?: unknown
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      if (block.thinking.length > 0) blocks.push({ type: 'reasoning', text: block.thinking })
    } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
      const args = block.arguments
      blocks.push({
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      })
    }
  }
  return blocks
}

/**
 * Convert an OMP context into a runtime generation request.
 * @param provider - provider id registered with OMP.
 * @param model - selected model.
 * @param context - OMP conversation.
 * @param options - stream options.
 * @param fallbackEffort - plugin default effort.
 */
export function toGenerateOptions(
  provider: string,
  model: StreamModel,
  context: StreamContext,
  options: StreamCallOptions | undefined,
  fallbackEffort: Effort,
): GenerateOptions {
  const messages: RequestMessage[] = []
  const system = (context.systemPrompt ?? []).filter(part => part.length > 0).join('\n\n')
  for (const message of context.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: userBlocks(message.content), source: { kind: 'user' } })
    } else if (message.role === 'developer') {
      messages.push({ role: 'developer', content: userBlocks(message.content) })
    } else if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: assistantBlocks(message.content),
        source: { kind: 'model', provider, model: model.id },
      })
    } else if (message.role === 'toolResult') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      messages.push({
        role: 'tool',
        toolCallId: callId,
        content: userBlocks(message.content).length > 0 ? userBlocks(message.content) : [{ type: 'text', text: textOf(message.content) }],
        source: { kind: 'tool', callId },
        ...message.isError === true ? { isError: true } : {},
      })
    }
  }
  const tools: ToolSchema[] | undefined = context.tools?.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: jsonSchema(tool.parameters),
  }))
  return {
    provider,
    model: model.id,
    messages,
    ...tools !== undefined ? { tools } : {},
    ...options?.sessionId !== undefined ? { sessionId: options.sessionId } : {},
    ...options?.signal !== undefined ? { signal: options.signal } : {},
    reasoningEffort: effortFromOptions(options?.reasoning, options?.disableReasoning, fallbackEffort),
    ...system.length > 0 ? { system } : {},
  }
}

function emptyUsage(): PartialAssistant['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
}

function applyUsage(partial: PartialAssistant, usage: TokenUsage): void {
  partial.usage = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens,
    ...usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {},
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
  } catch {
    return { raw }
  }
}

function snapshot(partial: PartialAssistant): Record<string, unknown> {
  return {
    ...partial,
    content: partial.content.map(block => ({ ...block })),
    usage: { ...partial.usage },
  }
}

/**
 * Drive an OMP event stream from one runtime generation.
 * @param runtime - ACP runtime.
 * @param options - generation request.
 * @param model - OMP model metadata.
 */
export function streamGenerate(
  runtime: AntigravityRuntime,
  options: GenerateOptions,
  model: StreamModel,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const started = Date.now()
  const partial: PartialAssistant = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: started,
  }
  stream.push({ type: 'start', partial: snapshot(partial) })

  const run = async (): Promise<void> => {
    let openIndex: number | undefined
    try {
      for await (const chunk of runtime.stream(options)) {
        pumpChunk(stream, partial, chunk, () => { openIndex = undefined }, index => { openIndex = index })
      }
    } catch (error) {
      const aborted = options.signal?.aborted === true || (error instanceof LlmError && error.code === 'ABORTED')
      partial.stopReason = aborted ? 'aborted' : 'error'
      partial.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: snapshot(partial) })
      stream.fail(error)
      return
    }
    if (openIndex !== undefined) {
      // The runtime always closes blocks before finish; nothing to flush.
    }
    if (partial.stopReason === 'error' || partial.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: partial.stopReason, error: snapshot(partial) })
      stream.end(snapshot(partial))
      return
    }
    stream.push({ type: 'done', reason: partial.stopReason === 'toolUse' ? 'toolUse' : partial.stopReason === 'length' ? 'length' : 'stop', message: snapshot(partial) })
    stream.end(snapshot(partial))
  }
  void run()
  return stream
}

function pumpChunk(
  stream: AssistantMessageEventStream,
  partial: PartialAssistant,
  chunk: StreamChunk,
  closeOpen: () => void,
  setOpen: (index: number) => void,
): void {
  switch (chunk.type) {
    case 'block-start': {
      const index = partial.content.length
      setOpen(index)
      if (chunk.blockType === 'text') {
        partial.content.push({ type: 'text', text: '' })
        stream.push({ type: 'text_start', contentIndex: index, partial: snapshot(partial) })
      } else if (chunk.blockType === 'reasoning') {
        partial.content.push({ type: 'thinking', thinking: '' })
        stream.push({ type: 'thinking_start', contentIndex: index, partial: snapshot(partial) })
      } else {
        partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: snapshot(partial) })
      }
      return
    }
    case 'text-delta': {
      const block = partial.content[chunk.index] as { type: 'text'; text: string } | undefined
      if (block?.type === 'text') block.text += chunk.text
      stream.push({ type: 'text_delta', contentIndex: chunk.index, delta: chunk.text, partial: snapshot(partial) })
      return
    }
    case 'reasoning-delta': {
      const block = partial.content[chunk.index] as { type: 'thinking'; thinking: string } | undefined
      if (block?.type === 'thinking') block.thinking += chunk.text
      stream.push({ type: 'thinking_delta', contentIndex: chunk.index, delta: chunk.text, partial: snapshot(partial) })
      return
    }
    case 'tool-call-delta': {
      const block = partial.content[chunk.index] as { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } | undefined
      if (block?.type === 'toolCall') {
        block.id = chunk.id
        block.name = chunk.name
        block.arguments = parseArgs(chunk.argumentsDelta)
      }
      stream.push({ type: 'toolcall_delta', contentIndex: chunk.index, delta: chunk.argumentsDelta, partial: snapshot(partial) })
      return
    }
    case 'block-end': {
      const index = chunk.index
      if (chunk.block.type === 'text') {
        const block = partial.content[index] as { type: 'text'; text: string } | undefined
        if (block?.type === 'text') block.text = chunk.block.text
        stream.push({ type: 'text_end', contentIndex: index, content: chunk.block.text, partial: snapshot(partial) })
      } else if (chunk.block.type === 'reasoning') {
        const block = partial.content[index] as { type: 'thinking'; thinking: string } | undefined
        if (block?.type === 'thinking') block.thinking = chunk.block.text
        stream.push({ type: 'thinking_end', contentIndex: index, content: chunk.block.text, partial: snapshot(partial) })
      } else if (chunk.block.type === 'tool-call') {
        const toolCall = {
          type: 'toolCall',
          id: chunk.block.id,
          name: chunk.block.name,
          arguments: parseArgs(chunk.block.arguments),
        }
        partial.content[index] = toolCall
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: snapshot(partial) })
      }
      closeOpen()
      return
    }
    case 'usage':
      applyUsage(partial, chunk.usage)
      return
    case 'finish':
      if (chunk.reason.kind === 'tool-calls') partial.stopReason = 'toolUse'
      else if (chunk.reason.kind === 'max-tokens') partial.stopReason = 'length'
      else if (chunk.reason.kind === 'aborted') {
        partial.stopReason = 'aborted'
        partial.errorMessage = chunk.reason.failure.message
      } else if (chunk.reason.kind === 'error') {
        partial.stopReason = 'error'
        partial.errorMessage = chunk.reason.failure.message
      } else {
        partial.stopReason = 'stop'
      }
      return
    default:
      return
  }
}

/** Image resolver used by the OMP extension. */
export const ompImageResolver: ImageResolver = inlineImageResolver
