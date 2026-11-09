/**
 * The MCP tool bridge as `agy` sees it: the schemas advertised on each prompt,
 * the incremental tool deltas appended to keep the agent's view current, and the
 * permission gate that decides which agent tool calls may touch DSH tools.
 *
 * Everything here is pure: the live tenant registry, the bridge transport, and
 * the conversation objects stay with the runtime, which passes in only the
 * facts a decision needs.
 * @module omp-antigravity-acp/tool-bridge
 */
import { AWAIT_TOOL_NAME, CALL_TOOL_NAME } from "./conversation.js";
import { AGENT_TOOL_PREFIX, MCP_SERVER_NAME } from "./history.js";
import { digest } from "./util.js";
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function structuredToolMeta(toolCall) {
    const meta = toolCall?._meta;
    const serverName = nonEmpty(toolCall?.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(toolCall?.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    return {
        ...(serverName !== undefined ? { serverName } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
    };
}
/**
 * Merge one `session/update` identity report into the conversation's table of
 * reported tool calls. Only these reports may authorize a permission request.
 * @param conv - conversation holding the reported calls.
 * @param update - the agent's session update.
 * @returns how the report was absorbed, or `undefined` for unrelated updates.
 */
export function recordReportedToolCall(conv, update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
        return;
    if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0)
        return;
    const meta = update._meta;
    const serverName = nonEmpty(update.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(update.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    const kind = typeof update.kind === 'string' ? update.kind : undefined;
    const existing = conv.reportedToolCalls.get(update.toolCallId);
    const merged = existing === undefined ? {} : { ...existing };
    let conflict = false;
    if (kind !== undefined) {
        if (merged.kind !== undefined && merged.kind !== kind)
            conflict = true;
        else
            merged.kind = kind;
    }
    if (serverName !== undefined) {
        if (merged.serverName !== undefined && merged.serverName !== serverName)
            conflict = true;
        else
            merged.serverName = serverName;
    }
    if (toolName !== undefined) {
        if (merged.toolName !== undefined && merged.toolName !== toolName)
            conflict = true;
        else
            merged.toolName = toolName;
    }
    if (conflict)
        merged.conflict = true;
    conv.reportedToolCalls.set(update.toolCallId, merged);
    if (conflict)
        return 'conflict';
    return existing === undefined ? 'created' : 'merged';
}
function isEmptyInput(rawInput) {
    if (rawInput === undefined || rawInput === null)
        return true;
    if (typeof rawInput === 'string')
        return rawInput.trim().length === 0;
    if (Array.isArray(rawInput))
        return rawInput.length === 0;
    if (typeof rawInput === 'object')
        return Object.keys(rawInput).length === 0;
    return false;
}
/**
 * Decide one `session/request_permission`. Only a tool call the agent reported
 * itself, carrying this bridge's server name, on a tool this session offers, and
 * during a live turn may run; every other request is refused.
 * @param state - live conversation facts.
 * @param request - the agent's permission request.
 * @param port - bridge handshake lookup and the warning sink for refusals.
 * @returns the outcome handed back to the agent.
 */
export function answerPermission(state, request, port) {
    const pick = (kind) => {
        const option = request.options.find(o => o.kind === kind);
        return option === undefined ? undefined : { outcome: 'selected', optionId: option.optionId };
    };
    const reject = (reason) => {
        port.warn(`antigravity-acp: refused permission request (${reason}): ${request.toolCall?.title ?? 'unknown'}`);
        return pick('reject_once') ?? { outcome: 'cancelled' };
    };
    if (state.sessionId === undefined || request.sessionId !== state.sessionId)
        return reject('session mismatch');
    const tenantKey = state.tenantKey;
    if (tenantKey === undefined)
        return reject('no MCP bridge is mounted for this session');
    if (!state.turnLive)
        return reject('no live turn');
    const toolCallId = request.toolCall?.toolCallId;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0)
        return reject('missing toolCallId');
    const reported = state.reportedToolCalls.get(toolCallId);
    const claimed = structuredToolMeta(request.toolCall);
    if (reported === undefined) {
        if (claimed.serverName !== undefined || claimed.toolName !== undefined) {
            return reject(`tool call ${toolCallId} was never reported by the agent`);
        }
        if (request.toolCall?.kind === 'other' && isEmptyInput(request.toolCall.rawInput)) {
            if (!port.hasHandshake(tenantKey)) {
                return reject('identity-less probe without a completed MCP handshake');
            }
            return pick('allow_once') ?? { outcome: 'cancelled' };
        }
        return reject('missing structured tool metadata');
    }
    if (reported.conflict === true) {
        return reject(`reported identity of tool call ${toolCallId} conflicts across agent updates`);
    }
    if (claimed.serverName !== undefined && claimed.serverName !== reported.serverName)
        return reject('MCP server name conflict');
    if (claimed.toolName !== undefined && claimed.toolName !== reported.toolName)
        return reject('tool name conflict');
    if (reported.serverName !== MCP_SERVER_NAME)
        return reject(`unknown MCP server ${reported.serverName ?? '(none)'}`);
    const allowedTools = new Set([...state.advertisedToolNames, AWAIT_TOOL_NAME, CALL_TOOL_NAME]);
    if (reported.toolName === undefined || !allowedTools.has(reported.toolName)) {
        return reject(`tool is not offered to this session: ${reported.toolName ?? '(none)'}`);
    }
    return pick('allow_once') ?? { outcome: 'cancelled' };
}
/**
 * Diff active tools against the session's known tool set and render a compact
 * `<harness_tool_update>` block for newly added, modified, restored, or disabled tools.
 * @param conv - conversation tool state (`advertisedToolNames` and `knownTools`).
 * @param tools - active tools for the current step.
 * @returns `<harness_tool_update>` text block, or `''` when unchanged.
 */
export function consumeToolDelta(conv, tools) {
    const lines = [];
    const active = new Set();
    for (const tool of tools) {
        active.add(tool.name);
        const hash = digest(tool);
        if (conv.knownTools.get(tool.name) === hash)
            continue;
        conv.knownTools.set(tool.name, hash);
        if (conv.advertisedToolNames.has(tool.name)) {
            lines.push(`[tool restored: ${AGENT_TOOL_PREFIX}${tool.name}]`);
        }
        else {
            lines.push(`[tool available via ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}}]: ${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema })}`);
        }
    }
    for (const name of [...conv.knownTools.keys()]) {
        if (!active.has(name)) {
            conv.knownTools.delete(name);
            lines.push(`[tool disabled: ${name}]`);
        }
    }
    return lines.length > 0 ? `<harness_tool_update>\n${lines.join('\n')}\n</harness_tool_update>` : '';
}
/** Byte ceiling keeping advertised MCP tool schemas below agy's ~1,500B lazy cutoff. */
export const MAX_EAGER_BRIDGE_TOOL_BYTES = 1_350;
function shortenText(text, maxChars) {
    const clean = text.replace(/\s+/gu, ' ').trim();
    if (clean.length <= maxChars)
        return clean;
    const sentenceEnd = clean.indexOf('. ');
    if (sentenceEnd >= 32 && sentenceEnd + 1 <= maxChars)
        return clean.slice(0, sentenceEnd + 1);
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
function compactSchemaNode(value, maxDescChars) {
    if (Array.isArray(value))
        return value.map(item => compactSchemaNode(item, maxDescChars));
    if (value === null || typeof value !== 'object')
        return value;
    const record = value;
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
        if (key === 'description' && typeof entry === 'string') {
            if (maxDescChars > 0)
                out[key] = shortenText(entry, maxDescChars);
            continue;
        }
        if (key === 'properties' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const props = {};
            for (const [propKey, propVal] of Object.entries(entry)) {
                props[propKey] = compactSchemaNode(propVal, maxDescChars);
            }
            out[key] = props;
            continue;
        }
        out[key] = compactSchemaNode(entry, maxDescChars);
    }
    return out;
}
/**
 * Keep each MCP-advertised tool schema under `agy`'s eager size threshold while
 * preserving every parameter name, type, required list, and enum constraint.
 * @param tool - raw bridge tool descriptor.
 * @returns compacted descriptor when oversized, otherwise the original descriptor.
 */
export function compactBridgeTool(tool) {
    if (Buffer.byteLength(JSON.stringify(tool), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return tool;
    const pass1 = {
        name: tool.name,
        description: shortenText(tool.description, 220),
        inputSchema: compactSchemaNode(tool.inputSchema, 90),
    };
    if (Buffer.byteLength(JSON.stringify(pass1), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return pass1;
    return {
        name: tool.name,
        description: shortenText(tool.description, 140),
        inputSchema: compactSchemaNode(tool.inputSchema, 0),
    };
}
/**
 * Resolve currently active tool schemas under either direct `ToolSchema[]` or
 * `toolUpdate: 'in-history'` (`deferLoading: true` + developer `tool-addition` / `tool-removal` blocks).
 * @param rawTools - declared tools on the request.
 * @param messages - request history after leading system messages.
 * @returns active tool schemas in declaration/activation order.
 */
export function resolveActiveToolSchemas(rawTools, messages) {
    if (rawTools === undefined || rawTools.length === 0)
        return [];
    const byName = new Map(rawTools.map(t => [t.name, t]));
    const active = new Map();
    for (const tool of rawTools) {
        if (tool.deferLoading !== true)
            active.set(tool.name, tool);
    }
    for (const message of messages) {
        if (message.role !== 'developer')
            continue;
        for (const block of message.content) {
            if (block.type === 'tool-addition') {
                const schema = byName.get(block.toolName);
                if (schema !== undefined) {
                    const { deferLoading: _defer, ...rest } = schema;
                    active.set(block.toolName, rest);
                }
            }
            else if (block.type === 'tool-removal') {
                active.delete(block.toolName);
            }
        }
    }
    return [...active.values()];
}
/**
 * Turn active tool schemas into the compacted descriptors advertised on the bridge.
 * @param tools - active tool schemas.
 * @returns bridge descriptors, defaults expanded to an object schema.
 */
export function toBridgeTools(tools) {
    return (tools ?? []).filter(t => t.deferLoading !== true).map(t => compactBridgeTool({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters.type === undefined ? { type: 'object', ...t.parameters } : t.parameters,
    }));
}
