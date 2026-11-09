/**
 * Durable DSH-to-ACP session bindings, kept in `session-index.json` under the
 * primary account's Gemini home. The index lets a restarted provider resume an
 * ACP session with `session/load` instead of replaying the whole transcript, so
 * it survives both process restarts and capacity eviction.
 *
 * The file is a cache, never the source of truth: unreadable entries are skipped
 * and a failed write falls back cleanly to the in-memory sessions.
 * @module omp-antigravity-acp/session-store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** Maximum durable DSH -> ACP session bindings retained in `session-index.json`. */
const MAX_PERSISTED_SESSIONS = 128;
/** Reader and writer of the session index file. */
export class SessionStore {
    filePath;
    entries = new Map();
    /** @param filePath - absolute path of `session-index.json`. */
    constructor(filePath) {
        this.filePath = filePath;
        this.load();
    }
    /**
     * Binding recorded for one DSH session.
     * @param dshSessionId - DSH session id.
     * @returns the binding, or undefined when the session has none.
     */
    get(dshSessionId) {
        return this.entries.get(dshSessionId);
    }
    /**
     * Record one binding and rewrite the index.
     * @param dshSessionId - DSH session id.
     * @param entry - the binding without its timestamp.
     */
    save(dshSessionId, entry) {
        this.entries.set(dshSessionId, { ...entry, updatedAt: Date.now() });
        this.flush();
    }
    /**
     * Drop one binding, rewriting the index only when it was recorded.
     * @param dshSessionId - DSH session id, or undefined when the session has none.
     */
    forget(dshSessionId) {
        if (dshSessionId === undefined)
            return;
        if (this.entries.delete(dshSessionId))
            this.flush();
    }
    load() {
        if (!existsSync(this.filePath))
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                return;
            for (const [dshId, raw] of Object.entries(parsed)) {
                if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
                    continue;
                const rec = raw;
                if (typeof rec['acpSessionId'] !== 'string'
                    || typeof rec['accountId'] !== 'string'
                    || typeof rec['systemHash'] !== 'string'
                    || !Array.isArray(rec['knownIds']))
                    continue;
                this.entries.set(dshId, {
                    acpSessionId: rec['acpSessionId'],
                    accountId: rec['accountId'],
                    systemHash: rec['systemHash'],
                    knownIds: rec['knownIds'].filter((x) => typeof x === 'string'),
                    advertisedTools: Array.isArray(rec['advertisedTools']) ? rec['advertisedTools'] : [],
                    knownTools: Array.isArray(rec['knownTools'])
                        ? rec['knownTools'].filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string')
                        : [],
                    issuedIds: Array.isArray(rec['issuedIds']) ? rec['issuedIds'].filter((x) => typeof x === 'string') : [],
                    updatedAt: typeof rec['updatedAt'] === 'number' && Number.isFinite(rec['updatedAt']) ? rec['updatedAt'] : 0,
                });
            }
        }
        catch {
            // Corrupt or outdated index file: start fresh without interrupting startup.
        }
    }
    flush() {
        try {
            if (this.entries.size > MAX_PERSISTED_SESSIONS) {
                const sorted = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
                while (this.entries.size > MAX_PERSISTED_SESSIONS && sorted.length > 0) {
                    const oldest = sorted.shift();
                    if (oldest !== undefined)
                        this.entries.delete(oldest[0]);
                }
            }
            mkdirSync(dirname(this.filePath), { recursive: true });
            const out = {};
            for (const [k, v] of this.entries.entries())
                out[k] = v;
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(out));
            renameSync(tmp, this.filePath);
        }
        catch {
            // Best-effort cache index; failure falls back cleanly to in-memory sessions.
        }
    }
}
