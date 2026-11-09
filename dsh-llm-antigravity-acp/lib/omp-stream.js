/**
 * Translate OMP `streamSimple` context into the ACP runtime request shape,
 * and runtime stream chunks into `AssistantMessageEvent`s.
 * @module omp-antigravity-acp/omp-stream
 */
import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai';
import { asEffort } from "./config.js";
import { LlmError } from "./host-types.js";
/**
 * Inline image bytes already present on a content block.
 * @param block - ACP/DSH image block.
 */
export function inlineImageResolver(block) {
    if ('data' in block && typeof block.data === 'string' && block.data.length > 0) {
        return Promise.resolve({ data: block.data, mimeType: 'mimeType' in block ? block.mimeType : 'image/png' });
    }
    return Promise.resolve(undefined);
}
/**
 * Map OMP thinking to an Antigravity effort.
 * @param value - OMP effort or undefined.
 * @param disable - force the lowest effort.
 */
export function effortFromOptions(value, disable, fallback) {
    if (disable === true)
        return 'low';
    if (value === 'minimal')
        return 'low';
    if (value === 'xhigh' || value === 'max')
        return 'high';
    return asEffort(value) ?? fallback;
}
function jsonSchema(parameters) {
    if (parameters !== null && typeof parameters === 'object') {
        const record = parameters;
        if (typeof record.toJsonSchema === 'function') {
            const schema = record.toJsonSchema();
            if (schema !== null && typeof schema === 'object')
                return schema;
        }
        if (record.schema !== null && typeof record.schema === 'object')
            return record.schema;
        if (typeof record.type === 'string' || 'properties' in record)
            return record;
    }
    return { type: 'object', properties: {} };
}
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return content == null ? '' : String(content);
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text') {
            const text = block.text;
            if (typeof text === 'string')
                parts.push(text);
        }
        else if (block !== null && typeof block === 'object' && block.type === 'thinking') {
            const text = block.thinking;
            if (typeof text === 'string')
                parts.push(text);
        }
    }
    return parts.join('');
}
function userBlocks(content) {
    if (typeof content === 'string')
        return content.length > 0 ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content))
        return [];
    const blocks = [];
    for (const item of content) {
        if (item === null || typeof item !== 'object')
            continue;
        const block = item;
        if (block.type === 'text' && typeof block.text === 'string') {
            if (block.text.length > 0)
                blocks.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'image' && typeof block.data === 'string') {
            blocks.push({ type: 'image', data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png' });
        }
    }
    return blocks;
}
function assistantBlocks(content) {
    if (typeof content === 'string')
        return content.length > 0 ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content))
        return [];
    const blocks = [];
    for (const item of content) {
        if (item === null || typeof item !== 'object')
            continue;
        const block = item;
        if (block.type === 'text' && typeof block.text === 'string') {
            if (block.text.length > 0)
                blocks.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            if (block.thinking.length > 0)
                blocks.push({ type: 'reasoning', text: block.thinking });
        }
        else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
            const args = block.arguments;
            blocks.push({
                type: 'tool-call',
                id: block.id,
                name: block.name,
                arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            });
        }
    }
    return blocks;
}
/**
 * Convert an OMP context into a runtime generation request.
 * @param provider - provider id registered with OMP.
 * @param model - selected model.
 * @param context - OMP conversation.
 * @param options - stream options.
 * @param fallbackEffort - plugin default effort.
 */
export function toGenerateOptions(provider, model, context, options, fallbackEffort) {
    const messages = [];
    const system = (context.systemPrompt ?? []).filter(part => part.length > 0).join('\n\n');
    for (const message of context.messages) {
        if (message.role === 'user') {
            messages.push({ role: 'user', content: userBlocks(message.content), source: { kind: 'user' } });
        }
        else if (message.role === 'developer') {
            messages.push({ role: 'developer', content: userBlocks(message.content) });
        }
        else if (message.role === 'assistant') {
            messages.push({
                role: 'assistant',
                content: assistantBlocks(message.content),
                source: { kind: 'model', provider, model: model.id },
            });
        }
        else if (message.role === 'toolResult') {
            const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
            messages.push({
                role: 'tool',
                toolCallId: callId,
                content: userBlocks(message.content).length > 0 ? userBlocks(message.content) : [{ type: 'text', text: textOf(message.content) }],
                source: { kind: 'tool', callId },
                ...message.isError === true ? { isError: true } : {},
            });
        }
    }
    const tools = context.tools?.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: jsonSchema(tool.parameters),
    }));
    return {
        provider,
        model: model.id,
        messages,
        ...tools !== undefined ? { tools } : {},
        ...options?.sessionId !== undefined ? { sessionId: options.sessionId } : {},
        ...options?.signal !== undefined ? { signal: options.signal } : {},
        reasoningEffort: effortFromOptions(options?.reasoning, options?.disableReasoning, fallbackEffort),
        ...system.length > 0 ? { system } : {},
    };
}
function emptyUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}
function applyUsage(partial, usage) {
    partial.usage = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        totalTokens: usage.totalTokens,
        ...usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {},
    };
}
function parseArgs(raw) {
    try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    }
    catch {
        return { raw };
    }
}
function snapshot(partial) {
    return {
        ...partial,
        content: partial.content.map(block => ({ ...block })),
        usage: { ...partial.usage },
    };
}
/**
 * Drive an OMP event stream from one runtime generation.
 * @param runtime - ACP runtime.
 * @param options - generation request.
 * @param model - OMP model metadata.
 */
export function streamGenerate(runtime, options, model) {
    const stream = new AssistantMessageEventStream();
    const started = Date.now();
    const partial = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp: started,
    };
    stream.push({ type: 'start', partial: snapshot(partial) });
    const run = async () => {
        let openIndex;
        try {
            for await (const chunk of runtime.stream(options)) {
                pumpChunk(stream, partial, chunk, () => { openIndex = undefined; }, index => { openIndex = index; });
            }
        }
        catch (error) {
            const aborted = options.signal?.aborted === true || (error instanceof LlmError && error.code === 'ABORTED');
            partial.stopReason = aborted ? 'aborted' : 'error';
            partial.errorMessage = error instanceof Error ? error.message : String(error);
            stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: snapshot(partial) });
            stream.fail(error);
            return;
        }
        if (openIndex !== undefined) {
            // The runtime always closes blocks before finish; nothing to flush.
        }
        if (partial.stopReason === 'error' || partial.stopReason === 'aborted') {
            stream.push({ type: 'error', reason: partial.stopReason, error: snapshot(partial) });
            stream.end(snapshot(partial));
            return;
        }
        stream.push({ type: 'done', reason: partial.stopReason === 'toolUse' ? 'toolUse' : partial.stopReason === 'length' ? 'length' : 'stop', message: snapshot(partial) });
        stream.end(snapshot(partial));
    };
    void run();
    return stream;
}
function pumpChunk(stream, partial, chunk, closeOpen, setOpen) {
    switch (chunk.type) {
        case 'block-start': {
            const index = partial.content.length;
            setOpen(index);
            if (chunk.blockType === 'text') {
                partial.content.push({ type: 'text', text: '' });
                stream.push({ type: 'text_start', contentIndex: index, partial: snapshot(partial) });
            }
            else if (chunk.blockType === 'reasoning') {
                partial.content.push({ type: 'thinking', thinking: '' });
                stream.push({ type: 'thinking_start', contentIndex: index, partial: snapshot(partial) });
            }
            else {
                partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} });
                stream.push({ type: 'toolcall_start', contentIndex: index, partial: snapshot(partial) });
            }
            return;
        }
        case 'text-delta': {
            const block = partial.content[chunk.index];
            if (block?.type === 'text')
                block.text += chunk.text;
            stream.push({ type: 'text_delta', contentIndex: chunk.index, delta: chunk.text, partial: snapshot(partial) });
            return;
        }
        case 'reasoning-delta': {
            const block = partial.content[chunk.index];
            if (block?.type === 'thinking')
                block.thinking += chunk.text;
            stream.push({ type: 'thinking_delta', contentIndex: chunk.index, delta: chunk.text, partial: snapshot(partial) });
            return;
        }
        case 'tool-call-delta': {
            const block = partial.content[chunk.index];
            if (block?.type === 'toolCall') {
                block.id = chunk.id;
                block.name = chunk.name;
                block.arguments = parseArgs(chunk.argumentsDelta);
            }
            stream.push({ type: 'toolcall_delta', contentIndex: chunk.index, delta: chunk.argumentsDelta, partial: snapshot(partial) });
            return;
        }
        case 'block-end': {
            const index = chunk.index;
            if (chunk.block.type === 'text') {
                const block = partial.content[index];
                if (block?.type === 'text')
                    block.text = chunk.block.text;
                stream.push({ type: 'text_end', contentIndex: index, content: chunk.block.text, partial: snapshot(partial) });
            }
            else if (chunk.block.type === 'reasoning') {
                const block = partial.content[index];
                if (block?.type === 'thinking')
                    block.thinking = chunk.block.text;
                stream.push({ type: 'thinking_end', contentIndex: index, content: chunk.block.text, partial: snapshot(partial) });
            }
            else if (chunk.block.type === 'tool-call') {
                const toolCall = {
                    type: 'toolCall',
                    id: chunk.block.id,
                    name: chunk.block.name,
                    arguments: parseArgs(chunk.block.arguments),
                };
                partial.content[index] = toolCall;
                stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: snapshot(partial) });
            }
            closeOpen();
            return;
        }
        case 'usage':
            applyUsage(partial, chunk.usage);
            return;
        case 'finish':
            if (chunk.reason.kind === 'tool-calls')
                partial.stopReason = 'toolUse';
            else if (chunk.reason.kind === 'max-tokens')
                partial.stopReason = 'length';
            else if (chunk.reason.kind === 'aborted') {
                partial.stopReason = 'aborted';
                partial.errorMessage = chunk.reason.failure.message;
            }
            else if (chunk.reason.kind === 'error') {
                partial.stopReason = 'error';
                partial.errorMessage = chunk.reason.failure.message;
            }
            else {
                partial.stopReason = 'stop';
            }
            return;
        default:
            return;
    }
}
/** Image resolver used by the OMP extension. */
export const ompImageResolver = inlineImageResolver;
