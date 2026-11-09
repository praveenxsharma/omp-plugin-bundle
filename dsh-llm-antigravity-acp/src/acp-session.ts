/**
 * The ACP session layer: one conversation's binding state, how a prompt is
 * split into replayed history and fresh input, the MCP attachment shared by
 * `session/new` and `session/load`, and the model/effort selection that follows
 * a session opening.
 *
 * Nothing here owns runtime state: callers pass the tenant registry, catalog,
 * and logging through explicit ports so both session-open paths stay one code
 * path.
 * @module dsh-llm-antigravity-acp/acp-session
 */

import { randomBytes } from 'node:crypto'
import { LlmError } from './host-types.ts'
import type { RequestMessage } from './host-types.ts'
import type { AcpConfigOption, AcpPermissionOutcome, AcpPermissionRequest, AcpProcess, AcpSessionListener } from './acp-process.ts'
import type { Effort } from './config.ts'
import type { AcpTurn } from './conversation.ts'
import { bridgeSystemPrompt, MCP_SERVER_NAME, type AcpPromptBlock } from './history.ts'
import { labeled } from './labels.ts'
import type { BridgeTool } from './mcp-bridge.ts'
import type { RouteHealth } from './route-health.ts'
import { recordReportedToolCall, type PermissionGateState, type ReportedToolCall } from './tool-bridge.ts'
import { digest } from './util.ts'

/** Purpose of the conversation serving the user-visible turn rather than an auxiliary call. */
export const MAIN_PURPOSE = 'main'

/** One DSH conversation bound to at most one live ACP session. */
export interface Conversation {
  readonly key: string
  readonly dshSessionId: string | undefined
  readonly purpose: string
  readonly tag: string
  /** Account this conversation is pinned to; kept across steps for prompt-cache affinity. */
  accountId: string | undefined
  tenantKey: string | undefined
  /** Per-tenant bearer credential presented by the agent on the MCP bridge. */
  tenantSecret: string | undefined
  sessionId: string | undefined
  process: AcpProcess | undefined
  configOptions: AcpConfigOption[]
  systemHash: string | undefined
  advertisedTools: BridgeTool[]
  advertisedToolNames: Set<string>
  knownTools: Map<string, string>
  toolNames: Set<string>
  /** Tool calls the agent reported via `session/update` — the only trusted permission source. */
  reportedToolCalls: Map<string, ReportedToolCall>
  /** True while this conversation is being acquired or its session is opening; never evicted as idle. */
  opening: boolean
  /**
   * Which table reports this ACP session's per-step usage, decided once per session
   * so one generation is never billed by both paths: `gen` for a session DB carrying
   * `gen_metadata` rows, `steps` for an old `agy` that has none, `undefined` before
   * the first decision.
   */
  usageSource: 'gen' | 'steps' | undefined
  /** Exclusive lower-bound `gen_metadata.idx` of the merged usage read. */
  genMetaCursor: number
  /** Exclusive lower-bound `steps.idx`, used only by the legacy fallback path. */
  usageCursor: number
  /** Completed steps already back-filled from `steps` because `gen_metadata` never billed them. */
  backfilledSteps: number
  /** Degradation fingerprint state and the numbers the quota pill reads. */
  health: RouteHealth
  /** Automatic re-answer bookkeeping; replaced as a whole whenever the ACP session is replaced. */
  reanswer: ReanswerState
  promptGen: number
  promptSettled: Promise<void>
  knownIds: string[] | undefined
  issuedIds: Set<string>
  turn: AcpTurn | undefined
  dirty: boolean
  lastUsed: number
  model: string | undefined
  effort: Effort | undefined
}

/** How one request is delivered to its ACP session. */
export interface PromptPlan {
  rebuild: boolean
  history: readonly RequestMessage[]
  input: readonly RequestMessage[]
}

/**
 * One conversation's automatic re-answer bookkeeping. A degraded attempt fails
 * the step with `DEGRADED_ROUTE`; DSH's request-retry layer then calls
 * `stream()` again with the identical request, which is recognized through
 * {@link ReanswerState.key} and answered inside the same ACP session.
 */
export interface ReanswerState {
  /** `session/prompt` rounds this ACP session already completed (reset with the session). */
  rounds: number
  /** Identity of the request the conversation is serving: message ids, system digest, model, purpose. */
  key: string | undefined
  /** Prompt blocks of that request, replayed verbatim when a cold session is replaced. */
  blocks: AcpPromptBlock[]
  /** Automatic re-answers already granted for this key. */
  granted: number
  /** The last attempt degraded; the next request with the same key re-answers instead of answering. */
  awaiting: boolean
  /** The re-answer must open a fresh ACP session (the degraded one never finished a round). */
  freshSession: boolean
}

/** Fresh bookkeeping for one ACP session. */
export function freshReanswer(): ReanswerState {
  return { rounds: 0, key: undefined, blocks: [], granted: 0, awaiting: false, freshSession: false }
}

/** Snapshot the conflict, identity, and liveness facts the permission gate reads. */
export function permissionState(conv: Conversation): PermissionGateState {
  return {
    sessionId: conv.sessionId,
    tenantKey: conv.tenantKey,
    turnLive: conv.turn !== undefined && !conv.turn.finished,
    reportedToolCalls: conv.reportedToolCalls,
    advertisedToolNames: conv.advertisedToolNames,
  }
}

/**
 * Whether one message is this provider's own earlier output rather than new input.
 * @param message - request message to classify.
 * @param provider - provider id this runtime answers for.
 * @param issuedIds - tool call ids this provider's turns issued.
 * @returns true for the model's own assistant text and for results of its own tool calls.
 */
export function isOwnMessage(message: RequestMessage, provider: string, issuedIds: ReadonlySet<string>): boolean {
  if (message.role === 'assistant') return message.source.kind === 'model' && message.source.provider === provider
  if (message.role === 'tool') return issuedIds.has(message.toolCallId)
  return false
}

/**
 * Drop the provider's own trailing assistant/tool messages and decide whether
 * what remains is new input for the same ACP session.
 * @param messages - candidate messages after the session's already-known prefix.
 * @param isOwn - classifies one message as the provider's own earlier output.
 * @returns the new input messages, or `[]` when there is nothing new to send.
 */
export function pendingInput(
  messages: readonly RequestMessage[],
  isOwn: (message: RequestMessage) => boolean,
): RequestMessage[] {
  let skip = 0
  while (skip < messages.length && isOwn(messages[skip] as RequestMessage)) skip++
  const rest = messages.slice(skip)
  return rest.every(m => m.role === 'user' || m.role === 'developer' || m.role === 'system') ? rest : []
}

/**
 * Whether this ACP session already owns a prefix of the request history.
 * @param conv - conversation holding the known ids and system digest.
 * @param system - request system text.
 * @param messages - full request history.
 * @returns true when the session may be continued incrementally.
 */
export function historyPrefixIntact(conv: Conversation, system: string, messages: readonly RequestMessage[]): boolean {
  if (conv.knownIds === undefined || conv.systemHash !== digest(system)) return false
  const known = conv.knownIds
  return known.length <= messages.length
    && known.every((id, index) => messages[index]?.id === id)
}

/**
 * Decide whether the request continues the live ACP session with fresh input or
 * must rebuild it by replaying the harness history.
 * @param conv - conversation bound to the session.
 * @param system - request system text.
 * @param messages - full request history.
 * @param provider - provider id this runtime answers for.
 * @returns the prompt plan.
 */
export function planPrompt(
  conv: Conversation,
  system: string,
  messages: readonly RequestMessage[],
  provider: string,
): PromptPlan {
  const reusable = conv.sessionId !== undefined
    && !conv.dirty
    && conv.purpose === MAIN_PURPOSE
    && historyPrefixIntact(conv, system, messages)
  if (reusable) {
    const known = conv.knownIds as string[]
    const input = pendingInput(messages.slice(known.length), message => isOwnMessage(message, provider, conv.issuedIds))
    if (input.length > 0) return { rebuild: false, history: [], input }
  }
  let cut = messages.length
  while (cut > 0) {
    const role = messages[cut - 1]?.role
    if (role !== 'user' && role !== 'developer' && role !== 'system') break
    cut--
  }
  return { rebuild: true, history: messages.slice(0, cut), input: messages.slice(cut) }
}

/** One MCP endpoint advertised to agy for a new or resumed ACP session. */
export interface McpServerEntry {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** What one bridge mount contributes to `session/new` or `session/load`. */
export interface BridgeMount {
  mcpServers: McpServerEntry[]
  systemAppend: string
  listener: AcpSessionListener
}

/** Runtime state the bridge mount needs but does not own. */
export interface BridgeMountPort {
  /** Base URL of the shared MCP bridge; the tenant key is appended per session. */
  bridgeUrl: string
  /** Request system text. */
  system: string
  /** Rendered tool contracts appended to the agent system prompt. */
  toolContracts: string
  registerTenant(tenantKey: string, conv: Conversation): void
  observeConfigOptions(options: AcpConfigOption[]): void
  permission(request: AcpPermissionRequest): AcpPermissionOutcome | undefined
  warn(message: string): void
}

/**
 * Reserve the conversation's MCP tenant and build the listener pair both
 * `session/new` and `session/load` install. The caller assigns
 * `advertisedTools`/`knownTools` first, because that differs between a fresh
 * and a resumed session.
 * @param conv - conversation the session belongs to.
 * @param port - runtime state the mount borrows.
 * @returns the MCP endpoints, the system prompt suffix, and the session listener.
 */
export function mountBridge(conv: Conversation, port: BridgeMountPort): BridgeMount {
  const attachMcp = conv.advertisedTools.length > 0 || conv.purpose === MAIN_PURPOSE
  const tenantKey = attachMcp ? randomBytes(16).toString('hex') : undefined
  const tenantSecret = tenantKey !== undefined ? randomBytes(24).toString('hex') : undefined
  const mcpServers: McpServerEntry[] = tenantKey !== undefined && tenantSecret !== undefined
    ? [{ type: 'http', name: MCP_SERVER_NAME, url: `${port.bridgeUrl}/${tenantKey}`, headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }] }]
    : []
  conv.tenantKey = tenantKey
  conv.tenantSecret = tenantSecret
  if (tenantKey !== undefined) port.registerTenant(tenantKey, conv)
  const listener: AcpSessionListener = {
    onUpdate: (update) => {
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        conv.configOptions = update.configOptions
        port.observeConfigOptions(update.configOptions)
      }
      if (recordReportedToolCall(conv, update) === 'conflict') {
        port.warn(`antigravity-acp: agent reported conflicting identity for tool call ${String(update.toolCallId)}`)
      }
      conv.turn?.onUpdate(update)
    },
    onPermission: request => port.permission(request),
  }
  return { mcpServers, systemAppend: bridgeSystemPrompt(port.system, port.toolContracts), listener }
}

/**
 * Drop a conversation's bridge attachment after `session/new` or `session/load`
 * failed, releasing the tenant slot before the key is cleared.
 * @param conv - conversation whose attachment is discarded.
 * @param releaseTenant - revokes the tenant in the runtime and the bridge.
 */
export function detachBridge(conv: Conversation, releaseTenant: (conv: Conversation) => void): void {
  releaseTenant(conv)
  conv.tenantKey = undefined
  conv.tenantSecret = undefined
  conv.advertisedTools = []
  conv.advertisedToolNames.clear()
  conv.knownTools.clear()
}

/** Runtime hooks the model/effort selection needs. */
export interface SelectionPort {
  /** Reasoning levels this model offers; empty means the account exposes no level. */
  selectableEfforts(model: string): readonly Effort[]
  /** Maps a transport failure onto the provider's stable error. */
  fail(error: unknown): Error
}

/**
 * Point the ACP session at the requested model and reasoning level. agy replaces
 * the whole option list on each switch, so every step re-reads it and retries
 * once when the value did not stick.
 * @param conv - conversation bound to the session.
 * @param proc - its ACP front.
 * @param model - requested model id.
 * @param effort - resolved reasoning effort.
 * @param port - runtime hooks.
 * @returns whether the session was reconfigured.
 */
export async function applyModelAndEffort(
  conv: Conversation,
  proc: AcpProcess,
  model: string,
  effort: Effort,
  port: SelectionPort,
): Promise<boolean> {
  const sessionId = conv.sessionId as string
  let switched = false
  let modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model')
  if (modelOption?.options !== undefined && !modelOption.options.some(o => o.value === model)) {
    throw new LlmError(labeled('UNKNOWN_MODEL', `Antigravity does not offer model "${model}" to this account; available: ${modelOption.options.map(o => o.value).join(', ')}`), 'UNKNOWN_MODEL')
  }
  if (conv.model !== model && modelOption?.currentValue !== model) {
    conv.configOptions = await proc.setConfigOption(sessionId, modelOption?.id ?? 'model', model).catch((error: unknown) => { throw port.fail(error) })
    switched = true
    modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model')
    if (modelOption !== undefined && modelOption.currentValue !== undefined && modelOption.currentValue !== model) {
      conv.configOptions = await proc.setConfigOption(sessionId, modelOption.id, model).catch((error: unknown) => { throw port.fail(error) })
    }
  }
  conv.model = model
  let levelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level')
  const selectable = port.selectableEfforts(model)
  if (selectable.length > 0 && levelOption !== undefined && conv.effort !== effort && levelOption.currentValue !== effort) {
    conv.configOptions = await proc.setConfigOption(sessionId, levelOption.id, effort).catch((error: unknown) => { throw port.fail(error) })
    switched = true
    levelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level')
    if (levelOption !== undefined && levelOption.currentValue !== undefined && levelOption.currentValue !== effort) {
      conv.configOptions = await proc.setConfigOption(sessionId, levelOption.id, effort).catch((error: unknown) => { throw port.fail(error) })
    }
  }
  conv.effort = effort
  return switched
}
