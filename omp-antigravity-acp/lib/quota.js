/**
 * Plan quota and per-account subscription/model entitlement reader.
 *
 * When the account holds an OAuth credential in its isolated keychain or token
 * file, reads directly from Google Cloud Code PA (`loadCodeAssist`,
 * `retrieveUserQuotaSummary`, `fetchAvailableModels` on `daily-cloudcode-pa`
 * first) so subscription tiers (`ULTRA` / `PRO` / `FREE`), Pro's independent
 * Argon weekly bucket, and regional/student model differences (`Claude 4.6` vs
 * `Claude 5.5`, `gemini-4-argon-disabled`) are reported verbatim. Falls back to
 * `agy -p /usage --output-format json` when no OAuth token is stored locally
 * (for example against a scripted fake CLI in unit tests).
 * @module omp-antigravity-acp/quota
 */
import { SYSTEM_ACCOUNT_ID } from "./accounts.js";
import { inspectCloudCodeAccount, } from "./cloudcode.js";
/**
 * Whether one window is the weekly (7-day) bucket. Upstream either names the
 * window `weekly` or encodes it in the bucket id (`gemini-weekly`, `3p-7d`), so
 * both fields are matched. A bucket upstream marked disabled is still the
 * weekly bucket; each caller decides what an inactive window means for it.
 * @param bucket - quota window.
 * @returns true when the bucket is the weekly window.
 */
export function isWeeklyBucket(bucket) {
    return /week|7d/i.test(`${bucket.window} ${bucket.id}`);
}
/**
 * Parse `agy -p /usage --output-format json` output.
 * @param stdout - command stdout.
 * @returns the quota groups.
 */
export function parseUsage(stdout) {
    const parsed = JSON.parse(stdout);
    const groups = parsed.command?.data?.groups;
    if (!Array.isArray(groups))
        throw new Error('agy /usage returned no quota groups');
    return groups.map((raw) => {
        const group = raw;
        const name = String(group.name ?? '');
        const lower = name.toLowerCase();
        const kind = lower.includes('argon')
            ? 'argon'
            : (lower.includes('claude') || lower.includes('gpt') || lower.includes('3p') ? 'claude' : 'gemini');
        return {
            kind,
            name,
            description: String(group.description ?? ''),
            buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((b) => {
                const bucket = b;
                return {
                    id: String(bucket.id ?? ''),
                    name: String(bucket.name ?? ''),
                    window: String(bucket.window ?? ''),
                    remainingFraction: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0,
                    resetTime: String(bucket.reset_time ?? ''),
                    ...(bucket.disabled === true ? { disabled: true } : {}),
                };
            }),
        };
    });
}
/**
 * Pick the quota group that serves one model family.
 * Checks dedicated Argon groups first (`gemini-4-argon` on Pro), then falls
 * back to Gemini (shared pool on Ultra) or Claude/GPT.
 * @param groups - quota groups.
 * @param model - model family id.
 * @returns the matching group.
 */
export function groupForModel(groups, model) {
    const lower = model.toLowerCase();
    if (lower.includes('argon')) {
        const argonGroup = groups.find(g => g.kind === 'argon' || (/\bargon\b/i.test(g.name) && g.kind !== 'gemini'));
        if (argonGroup !== undefined)
            return argonGroup;
        return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && !/claude|gpt|3p/i.test(g.name))) ?? groups[0];
    }
    const gemini = lower.includes('gemini');
    if (gemini) {
        return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && g.kind !== 'argon')) ?? groups[0];
    }
    return groups.find(g => g.kind === 'claude' || /claude|gpt|3p/i.test(g.name)) ?? groups[0];
}
/**
 * Quota family that governs one model id.
 * Argon keeps its own bucket on Pro, so it is not folded into `gemini` here.
 * @param model - model id.
 * @returns the family.
 */
export function quotaFamilyFor(model) {
    if (/argon/i.test(model))
        return 'argon';
    if (/claude|gpt|oss/i.test(model))
        return 'claude';
    return 'gemini';
}
/** Kind of one group, deriving it from the name when upstream omitted it. */
function groupKindOf(group) {
    return group.kind ?? (/argon/i.test(group.name) ? 'argon' : (/claude|gpt|3p/i.test(group.name) ? 'claude' : 'gemini'));
}
/**
 * Whether this account positively cannot serve Argon. Only evidence counts, so
 * a snapshot that reports no entitlements at all keeps the historic behaviour
 * of trusting the group list; a plan that lists its models, disables Argon by
 * name, or is a Pro/Free plan never borrows the Gemini pool for it.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns true when Argon is known to be unavailable.
 */
function argonUnavailable(snapshot, model) {
    if ((snapshot.disabledModels ?? []).some(entry => entry === model || /argon/i.test(entry)))
        return true;
    const entitled = snapshot.availableModels;
    if (Array.isArray(entitled) && entitled.length > 0 && !entitled.some(entry => entry.id === model || /argon/i.test(entry.id)))
        return true;
    const tier = snapshot.subscriptionTier;
    return tier === 'PRO' || tier === 'FREE';
}
/**
 * Resolve the windows that govern one model on one account.
 *
 * The families do not fall back into each other: a missing Argon bucket on a
 * Pro plan is reported as `model-not-entitled` instead of borrowing the Gemini
 * pool, which is what made an untouched Pro plan read as 100% Argon capacity.
 * Ultra shares one pool between Argon and Gemini, and upstream flags that with
 * `argonSharedWithGemini`, so only that case reuses the Gemini windows.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns the focus, including the group when the account may spend the model.
 */
export function resolveModelQuota(snapshot, model) {
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const family = quotaFamilyFor(model);
    const pick = (kind) => groups.find(group => groupKindOf(group) === kind);
    if (family === 'argon') {
        const argon = pick('argon');
        if (argon !== undefined)
            return { model, family, entitled: true, group: argon };
        const gemini = pick('gemini');
        const shared = snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE';
        if (gemini !== undefined && (shared || !argonUnavailable(snapshot, model))) {
            return { model, family, entitled: true, group: gemini };
        }
        return {
            model,
            family,
            entitled: false,
            reason: argonUnavailable(snapshot, model) ? 'model-not-entitled' : 'no-groups',
        };
    }
    if (family === 'claude') {
        const claude = pick('claude');
        return claude !== undefined
            ? { model, family, entitled: true, group: claude }
            : { model, family, entitled: false, reason: 'no-groups' };
    }
    const gemini = pick('gemini') ?? (snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE' ? pick('argon') : undefined);
    return gemini !== undefined
        ? { model, family, entitled: true, group: gemini }
        : { model, family, entitled: false, reason: 'no-groups' };
}
/**
 * Cached quota reader. Every account keeps its own cache entry and in-flight
 * request so one account's windows and entitlements never bleed into another.
 */
export class QuotaReader {
    binary;
    run;
    ttlMs;
    transport;
    cached = new Map();
    inflight = new Map();
    /**
     * @param binary - returns the agy executable for CLI fallback.
     * @param run - helper command runner.
     * @param ttlMs - cache lifetime.
     * @param transport - optional Cloud Code HTTP transport override for tests.
     */
    constructor(binary, run, ttlMs, transport) {
        this.binary = binary;
        this.run = run;
        this.ttlMs = ttlMs;
        this.transport = transport;
    }
    /**
     * Return the cached snapshot of one account without triggering I/O.
     * @param accountId - account key.
     * @returns cached snapshot, if any.
     */
    peekFor(accountId) {
        return this.cached.get(accountId)?.snapshot;
    }
    /**
     * Read the quota and entitlement snapshot of one account.
     * @param accountId - account the snapshot belongs to.
     * @param env - environment that selects that account's credential store.
     * @param force - bypass the cache.
     * @param layout - optional account layout enabling direct Cloud Code inspection.
     * @returns the snapshot; failures resolve as `status: 'error'`.
     */
    async readFor(accountId, env, force = false, layout) {
        const hit = this.cached.get(accountId);
        if (!force && hit !== undefined && Date.now() - hit.at < this.ttlMs)
            return hit.snapshot;
        const running = this.inflight.get(accountId);
        if (!force && running !== undefined)
            return running;
        const pending = this.fetch(accountId, env, layout).finally(() => {
            if (this.inflight.get(accountId) === pending)
                this.inflight.delete(accountId);
        });
        this.inflight.set(accountId, pending);
        return pending;
    }
    /**
     * Read the quota snapshot of the implicit account that uses this machine's login.
     * @param force - bypass the cache.
     * @returns the snapshot.
     */
    read(force = false) {
        return this.readFor(SYSTEM_ACCOUNT_ID, {}, force);
    }
    /** Forget every cached snapshot, for example after the account list changed. */
    clear() {
        this.cached.clear();
    }
    async fetch(accountId, env, layout) {
        if (layout !== undefined) {
            try {
                const inspected = await inspectCloudCodeAccount({
                    layout,
                    env,
                    runCommand: this.run,
                    ...(this.transport !== undefined ? { transport: this.transport } : {}),
                });
                if (inspected !== undefined) {
                    const snapshot = {
                        status: 'ok',
                        updatedAt: new Date().toISOString(),
                        groups: inspected.groups,
                        subscriptionTier: inspected.subscriptionTier,
                        ...(inspected.subscriptionName !== undefined ? { subscriptionName: inspected.subscriptionName } : {}),
                        availableModels: inspected.models,
                        effortsByModel: inspected.effortsByModel,
                        maxTokensByModel: inspected.maxTokensByModel,
                        disabledModels: inspected.disabledModels,
                        argonSharedWithGemini: inspected.argonSharedWithGemini,
                    };
                    this.cached.set(accountId, { snapshot, at: Date.now() });
                    return snapshot;
                }
            }
            catch (cloudError) {
                // Fall through to `agy -p /usage` if available; otherwise report the Cloud Code error.
                const binary = this.binary();
                if (binary === undefined) {
                    return {
                        status: 'error',
                        updatedAt: new Date().toISOString(),
                        groups: this.cached.get(accountId)?.snapshot.groups ?? [],
                        error: cloudError instanceof Error ? cloudError.message : String(cloudError),
                    };
                }
            }
        }
        const binary = this.binary();
        if (binary === undefined)
            return { status: 'error', updatedAt: new Date().toISOString(), groups: [], error: 'agy binary not resolved yet' };
        try {
            const result = await this.run([binary, '-p', '/usage', '--output-format', 'json'], 45_000, env);
            const previous = this.cached.get(accountId)?.snapshot;
            const snapshot = {
                status: 'ok',
                updatedAt: new Date().toISOString(),
                groups: parseUsage(result.stdout),
                ...(previous?.subscriptionTier !== undefined ? { subscriptionTier: previous.subscriptionTier } : {}),
                ...(previous?.subscriptionName !== undefined ? { subscriptionName: previous.subscriptionName } : {}),
                ...(previous?.availableModels !== undefined ? { availableModels: previous.availableModels } : {}),
                ...(previous?.disabledModels !== undefined ? { disabledModels: previous.disabledModels } : {}),
            };
            this.cached.set(accountId, { snapshot, at: Date.now() });
            return snapshot;
        }
        catch (error) {
            return {
                status: 'error',
                updatedAt: new Date().toISOString(),
                groups: this.cached.get(accountId)?.snapshot.groups ?? [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
