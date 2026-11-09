/**
 * Short label per stable failure code, prefixed onto messages that reach the
 * transcript so a bare code is readable at a glance.
 */
/** Code → short label. Unknown codes stay unlabelled. */
const FAILURE_LABELS = {
    RATE_LIMIT: 'rate limited',
    QUOTA: 'quota exhausted',
    AUTH: 'not signed in',
    CONTEXT_WINDOW_EXCEEDED: 'context overflow',
    TIMEOUT: 'timed out',
    TRANSPORT: 'connection lost',
    SERVER: 'upstream error',
    REFUSAL: 'refused',
    MAX_SESSIONS: 'session cap',
    UNKNOWN_MODEL: 'model unavailable',
    INVALID_MODEL_CONFIG: 'model config rejected',
    IMAGE_TOO_LARGE: 'image too large',
    EMPTY_RESPONSE: 'empty response',
    DEGRADED_ROUTE: 'auto re-answer',
    DEGRADED_ROUTE_EXHAUSTED: 'degraded route',
    PROCESS_CLEANUP_FAILED: 'process still running',
    PLAN_REQUIRED: 'plan does not include this model',
    PROVIDER_ERROR: 'model request failed',
};
/**
 * Prefix a message with its code's short label.
 * @param code - stable failure code.
 * @param message - provider or plugin message.
 */
export function labeled(code, message) {
    const label = FAILURE_LABELS[code];
    return label === undefined || message.startsWith(`[${label}]`) ? message : `[${label}] ${message}`;
}
