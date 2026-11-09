/**
 * Host-agnostic request, stream, and error types formerly imported from
 * `@deepseek-ai/dsh-llm`. The ACP runtime still speaks this shape; the OMP
 * extension translates to and from `AssistantMessageEventStream`.
 * @module omp-antigravity-acp/host-types
 */
/**
 * Brand a tool-call id string.
 * @param value - raw id.
 */
export function ToolCallId(value) {
    return value;
}
/** Stable provider failure. */
export class LlmError extends Error {
    code;
    providerRetryAfterMs;
    failure;
    /**
     * @param message - user-facing text.
     * @param code - stable failure code.
     * @param options - optional cause and retry hint.
     */
    constructor(message, code, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'LlmError';
        this.code = code;
        const failure = { message, code };
        if (options?.providerRetryAfterMs !== undefined) {
            this.providerRetryAfterMs = options.providerRetryAfterMs;
            failure.providerRetryAfterMs = options.providerRetryAfterMs;
        }
        this.failure = failure;
    }
}
