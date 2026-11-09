/**
 * The ACP session layer: one conversation's binding state, how a prompt is
 * split into replayed history and fresh input, the MCP attachment shared by
 * `session/new` and `session/load`, and the model/effort selection that follows
 * a session opening.
 *
 * Nothing here owns runtime state: callers pass the tenant registry, catalog,
 * and logging through explicit ports so both session-open paths stay one code
 * path.
 * @module omp-antigravity-acp/acp-session
 */
import { randomBytes } from 'node:crypto';
import { LlmError } from "./host-types.js";
import { bridgeSystemPrompt, MCP_SERVER_NAME } from "./history.js";
import { labeled } from "./labels.js";
import { recordReportedToolCall } from "./tool-bridge.js";
import { digest } from "./util.js";
/** Purpose of the conversation serving the user-visible turn rather than an auxiliary call. */
export const MAIN_PURPOSE = 'main';
/** Fresh bookkeeping for one ACP session. */
export function freshReanswer() {
    return { rounds: 0, key: undefined, blocks: [], granted: 0, awaiting: false, freshSession: false };
}
/** Snapshot the conflict, identity, and liveness facts the permission gate reads. */
export function permissionState(conv) {
    return {
        sessionId: conv.sessionId,
        tenantKey: conv.tenantKey,
        turnLive: conv.turn !== undefined && !conv.turn.finished,
        reportedToolCalls: conv.reportedToolCalls,
        advertisedToolNames: conv.advertisedToolNames,
    };
}
/**
 * Whether one message is this provider's own earlier output rather than new input.
 * @param message - request message to classify.
 * @param provider - provider id this runtime answers for.
 * @param issuedIds - tool call ids this provider's turns issued.
 * @returns true for the model's own assistant text and for results of its own tool calls.
 */
export function isOwnMessage(message, provider, issuedIds) {
    if (message.role === 'assistant')
        return message.source.kind === 'model' && message.source.provider === provider;
    if (message.role === 'tool')
        return issuedIds.has(message.toolCallId);
    return false;
}
/**
 * Drop the provider's own trailing assistant/tool messages and decide whether
 * what remains is new input for the same ACP session.
 * @param messages - candidate messages after the session's already-known prefix.
 * @param isOwn - classifies one message as the provider's own earlier output.
 * @returns the new input messages, or `[]` when there is nothing new to send.
 */
export function pendingInput(messages, isOwn) {
    let skip = 0;
    while (skip < messages.length && isOwn(messages[skip]))
        skip++;
    const rest = messages.slice(skip);
    return rest.every(m => m.role === 'user' || m.role === 'developer' || m.role === 'system') ? rest : [];
}
/**
 * Whether this ACP session already owns a prefix of the request history.
 * @param conv - conversation holding the known ids and system digest.
 * @param system - request system text.
 * @param messages - full request history.
 * @returns true when the session may be continued incrementally.
 */
export function historyPrefixIntact(conv, system, messages) {
    if (conv.knownIds === undefined || conv.systemHash !== digest(system))
        return false;
    const known = conv.knownIds;
    return known.length <= messages.length
        && known.every((id, index) => messages[index]?.id === id);
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
export function planPrompt(conv, system, messages, provider) {
    const reusable = conv.sessionId !== undefined
        && !conv.dirty
        && conv.purpose === MAIN_PURPOSE
        && historyPrefixIntact(conv, system, messages);
    if (reusable) {
        const known = conv.knownIds;
        const input = pendingInput(messages.slice(known.length), message => isOwnMessage(message, provider, conv.issuedIds));
        if (input.length > 0)
            return { rebuild: false, history: [], input };
    }
    let cut = messages.length;
    while (cut > 0) {
        const role = messages[cut - 1]?.role;
        if (role !== 'user' && role !== 'developer' && role !== 'system')
            break;
        cut--;
    }
    return { rebuild: true, history: messages.slice(0, cut), input: messages.slice(cut) };
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
export function mountBridge(conv, port) {
    const attachMcp = conv.advertisedTools.length > 0 || conv.purpose === MAIN_PURPOSE;
    const tenantKey = attachMcp ? randomBytes(16).toString('hex') : undefined;
    const tenantSecret = tenantKey !== undefined ? randomBytes(24).toString('hex') : undefined;
    const mcpServers = tenantKey !== undefined && tenantSecret !== undefined
        ? [{ type: 'http', name: MCP_SERVER_NAME, url: `${port.bridgeUrl}/${tenantKey}`, headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }] }]
        : [];
    conv.tenantKey = tenantKey;
    conv.tenantSecret = tenantSecret;
    if (tenantKey !== undefined)
        port.registerTenant(tenantKey, conv);
    const listener = {
        onUpdate: (update) => {
            if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
                conv.configOptions = update.configOptions;
                port.observeConfigOptions(update.configOptions);
            }
            if (recordReportedToolCall(conv, update) === 'conflict') {
                port.warn(`antigravity-acp: agent reported conflicting identity for tool call ${String(update.toolCallId)}`);
            }
            conv.turn?.onUpdate(update);
        },
        onPermission: request => port.permission(request),
    };
    return { mcpServers, systemAppend: bridgeSystemPrompt(port.system, port.toolContracts), listener };
}
/**
 * Drop a conversation's bridge attachment after `session/new` or `session/load`
 * failed, releasing the tenant slot before the key is cleared.
 * @param conv - conversation whose attachment is discarded.
 * @param releaseTenant - revokes the tenant in the runtime and the bridge.
 */
export function detachBridge(conv, releaseTenant) {
    releaseTenant(conv);
    conv.tenantKey = undefined;
    conv.tenantSecret = undefined;
    conv.advertisedTools = [];
    conv.advertisedToolNames.clear();
    conv.knownTools.clear();
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
export async function applyModelAndEffort(conv, proc, model, effort, port) {
    const sessionId = conv.sessionId;
    let switched = false;
    let modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model');
    if (modelOption?.options !== undefined && !modelOption.options.some(o => o.value === model)) {
        throw new LlmError(labeled('UNKNOWN_MODEL', `Antigravity does not offer model "${model}" to this account; available: ${modelOption.options.map(o => o.value).join(', ')}`), 'UNKNOWN_MODEL');
    }
    if (conv.model !== model && modelOption?.currentValue !== model) {
        conv.configOptions = await proc.setConfigOption(sessionId, modelOption?.id ?? 'model', model).catch((error) => { throw port.fail(error); });
        switched = true;
        modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model');
        if (modelOption !== undefined && modelOption.currentValue !== undefined && modelOption.currentValue !== model) {
            conv.configOptions = await proc.setConfigOption(sessionId, modelOption.id, model).catch((error) => { throw port.fail(error); });
        }
    }
    conv.model = model;
    let levelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level');
    const selectable = port.selectableEfforts(model);
    if (selectable.length > 0 && levelOption !== undefined && conv.effort !== effort && levelOption.currentValue !== effort) {
        conv.configOptions = await proc.setConfigOption(sessionId, levelOption.id, effort).catch((error) => { throw port.fail(error); });
        switched = true;
        levelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level');
        if (levelOption !== undefined && levelOption.currentValue !== undefined && levelOption.currentValue !== effort) {
            conv.configOptions = await proc.setConfigOption(sessionId, levelOption.id, effort).catch((error) => { throw port.fail(error); });
        }
    }
    conv.effort = effort;
    return switched;
}
