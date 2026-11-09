/**
 * Direct Cloud Code PA account inspector (`loadCodeAssist`,
 * `retrieveUserQuotaSummary`, `fetchAvailableModels`) modeled on official
 * Antigravity Hub traffic and `lbjlaq/Antigravity-Manager`.
 *
 * Querying the upstream endpoints with each account's own OAuth credential
 * yields three facts that `agy -p /usage` omits:
 * 1. Authoritative subscription tier (`ULTRA` / `PRO` / `FREE` / `ENTERPRISE`)
 *    from `v1internal:loadCodeAssist` (`paidTier` -> `currentTier`).
 * 2. Per-account entitled model inventory (`agentModelSorts` + `models` from
 *    `v1internal:fetchAvailableModels`), which differs between Ultra (`5.5` +
 *    Argon), standard Pro (dedicated Argon weekly bucket), and promotional /
 *    Jio / Student Pro (`4.6` Claude, `gemini-4-argon-disabled`).
 * 3. Live grouped quota windows from `daily-cloudcode-pa.googleapis.com`
 *    (primary; `cloudcode-pa.googleapis.com` is kept only as a fallback because
 *    it can report stale `1.0` Gemini fractions), preserving any dedicated Pro
 *    Argon weekly bucket (`gemini-argon-wtu-weekly`) separately from Gemini 3.8.
 * @module omp-antigravity-acp/cloudcode
 */
import { proxyUrlFromEnv } from "./accounts.js";
import { EFFORTS } from "./config.js";
import { decodeStoredCredential, readStoredCredentialRaw } from "./credential.js";
/** Fallback order: Daily first (authoritative live usage), Sandbox second. Production `cloudcode-pa` rejects consumer OAuth tokens with HTTP 429 and is excluded. */
export const CLOUD_CODE_HOSTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
];
/** Official Hub egress User-Agent matching installed Antigravity 2.29.0 (`cl=1013060670`). */
export const OFFICIAL_HUB_USER_AGENT = 'antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_CANDIDATE_CLIENTS = [
    {
        id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
        secret: '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',
    },
    {
        id: '884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com',
        secret: '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',
    },
];
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ENDPOINT_UNHEALTHY_TTL_MS = 60_000;
const unhealthyUntil = new Map();
function orderedHosts(now = Date.now()) {
    const healthy = [];
    const degraded = [];
    for (const host of CLOUD_CODE_HOSTS) {
        const until = unhealthyUntil.get(host);
        if (until !== undefined && until > now)
            degraded.push(host);
        else {
            if (until !== undefined)
                unhealthyUntil.delete(host);
            healthy.push(host);
        }
    }
    return [...healthy, ...degraded];
}
function markHostFailure(host, now = Date.now()) {
    unhealthyUntil.set(host, now + ENDPOINT_UNHEALTHY_TTL_MS);
}
function markHostSuccess(host) {
    unhealthyUntil.delete(host);
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Decode a stored keychain or oauth-token payload into its OAuth fields.
 * @param raw - raw string from `security find-generic-password` or token file.
 * @returns decoded credential, or undefined when malformed or missing tokens.
 */
export function parseStoredOAuthCredential(raw) {
    const jsonText = decodeStoredCredential(raw);
    if (jsonText === undefined)
        return undefined;
    try {
        const outer = asRecord(JSON.parse(jsonText));
        if (outer === undefined)
            return undefined;
        const inner = asRecord(outer.token) ?? outer;
        const accessToken = typeof inner.access_token === 'string' ? inner.access_token.trim() : '';
        const refreshToken = typeof inner.refresh_token === 'string' && inner.refresh_token.trim().length > 0
            ? inner.refresh_token.trim()
            : undefined;
        if (accessToken.length === 0 && refreshToken === undefined)
            return undefined;
        let expiryMs;
        if (typeof inner.expiry === 'string') {
            const parsed = Date.parse(inner.expiry);
            if (Number.isFinite(parsed))
                expiryMs = parsed;
        }
        else if (typeof inner.expires_at === 'number' && Number.isFinite(inner.expires_at)) {
            expiryMs = inner.expires_at > 1e12 ? inner.expires_at : inner.expires_at * 1000;
        }
        const email = typeof outer.id_token_email === 'string' && outer.id_token_email.trim().length > 0
            ? outer.id_token_email.trim()
            : (typeof outer.email === 'string' && outer.email.trim().length > 0 ? outer.email.trim() : undefined);
        return {
            accessToken,
            ...(refreshToken !== undefined ? { refreshToken } : {}),
            ...(expiryMs !== undefined ? { expiryMs } : {}),
            ...(email !== undefined ? { email } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Read one account's stored OAuth credential from its isolated keychain or file.
 * @param layout - account layout.
 * @param run - command runner.
 * @param platform - host platform.
 * @returns the stored credential, or undefined when not signed in.
 */
export async function readAccountOAuthCredential(layout, run, platform = process.platform) {
    const raw = await readStoredCredentialRaw(layout, run, platform, (blob) => parseStoredOAuthCredential(blob) !== undefined);
    return raw === undefined ? undefined : parseStoredOAuthCredential(raw);
}
/**
 * Default HTTP POST transport. Uses direct `fetch` when the account declares no
 * custom proxy, and `curl` with `env` when the account configures its own HTTP /
 * HTTPS / SOCKS5 proxy so per-account egress isolation is strictly preserved.
 * @param run - command runner for proxied curl calls.
 * @returns transport function.
 */
export function createCloudCodeTransport(run) {
    return async (url, headers, body, env) => {
        const proxy = env !== undefined ? proxyUrlFromEnv(env) : '';
        if (proxy.length > 0) {
            const argv = ['curl', '-sS', '--max-time', '15', '-X', 'POST', url, '-w', '\n__HTTP_STATUS__:%{http_code}'];
            for (const [key, value] of Object.entries(headers)) {
                argv.push('-H', `${key}: ${value}`);
            }
            argv.push('--data-raw', body);
            const res = await run(argv, REQUEST_TIMEOUT_MS + 2_000, env);
            if (res.code !== 0)
                throw new Error(res.stderr.trim() || `curl exit ${String(res.code)}`);
            const marker = '\n__HTTP_STATUS__:';
            const idx = res.stdout.lastIndexOf(marker);
            if (idx < 0)
                throw new Error('missing HTTP status from curl');
            const rawBody = res.stdout.slice(0, idx);
            const status = Number(res.stdout.slice(idx + marker.length).trim());
            let parsed = rawBody;
            try {
                parsed = JSON.parse(rawBody);
            }
            catch { /* non-JSON error text */ }
            return { status, body: parsed };
        }
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let parsed = text;
        try {
            parsed = JSON.parse(text);
        }
        catch { /* non-JSON error text */ }
        return { status: response.status, body: parsed };
    };
}
async function refreshAccessToken(refreshToken, transport, env) {
    for (const client of OAUTH_CANDIDATE_CLIENTS) {
        const form = new URLSearchParams({
            client_id: client.id,
            client_secret: client.secret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString();
        try {
            const res = await transport(OAUTH_TOKEN_URL, { 'content-type': 'application/x-www-form-urlencoded' }, form, env);
            const body = asRecord(res.body);
            if (res.status >= 200 && res.status < 300 && typeof body?.access_token === 'string' && body.access_token.length > 0) {
                return body.access_token;
            }
        }
        catch {
            // Try next candidate OAuth client.
        }
    }
    return undefined;
}
/**
 * Normalize a raw `loadCodeAssist` tier id or name into a canonical tier.
 * Mirrors `Antigravity-Manager`'s `normalize_subscription_tier` and never infers
 * tier from model lists.
 * @param raw - raw tier id or display name.
 * @returns canonical tier, or `'FREE'` when unrecognized.
 */
export function normalizeSubscriptionTier(raw) {
    const lower = (raw ?? '').trim().toLowerCase();
    if (lower.length === 0)
        return 'FREE';
    if (lower.includes('ultra') || lower.includes('helium'))
        return 'ULTRA';
    if (lower.includes('free') || lower.includes('starter'))
        return 'FREE';
    if (lower.includes('pro') || lower.includes('premium') || lower.includes('advanced'))
        return 'PRO';
    if (lower.includes('enterprise')
        || lower.includes('standard')
        || lower.includes('business')
        || lower.startsWith('gcp_')
        || lower.includes('vertex')) {
        return 'ENTERPRISE';
    }
    return 'FREE';
}
/**
 * Extract project id and authoritative subscription tier from `loadCodeAssist`.
 * Priority: `paidTier` -> `currentTier` -> `allowedTiers` default/`free-tier` -> `FREE`.
 * @param body - parsed JSON response from `v1internal:loadCodeAssist`.
 * @returns project id, normalized tier, and human-readable plan name.
 */
export function parseLoadCodeAssist(body) {
    const data = asRecord(body);
    if (data === undefined)
        return { subscriptionTier: 'FREE' };
    const projectId = typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject.trim().length > 0
        ? data.cloudaicompanionProject.trim()
        : undefined;
    const paidTier = asRecord(data.paidTier);
    const currentTier = asRecord(data.currentTier);
    const allowedTiers = Array.isArray(data.allowedTiers) ? data.allowedTiers.map(asRecord).filter((t) => t !== undefined) : [];
    const tierString = (tier) => {
        if (tier === undefined)
            return undefined;
        if (typeof tier.id === 'string' && tier.id.trim().length > 0)
            return tier.id.trim();
        if (typeof tier.name === 'string' && tier.name.trim().length > 0)
            return tier.name.trim();
        return undefined;
    };
    const rawTier = tierString(paidTier)
        ?? tierString(currentTier)
        ?? tierString(allowedTiers.find(t => t.id === 'free-tier' || t.isDefault === true))
        ?? 'free-tier';
    const subscriptionTier = normalizeSubscriptionTier(rawTier);
    const paidName = typeof paidTier?.name === 'string' && paidTier.name.trim().length > 0 ? paidTier.name.trim() : undefined;
    const currentName = typeof currentTier?.name === 'string' && currentTier.name.trim().length > 0 ? currentTier.name.trim() : undefined;
    const subscriptionName = paidName
        ?? (subscriptionTier === 'ULTRA' ? 'Google AI Ultra'
            : subscriptionTier === 'PRO' ? 'Google AI Pro'
                : subscriptionTier === 'ENTERPRISE' ? 'Enterprise'
                    : currentName && currentName.toLowerCase() !== 'antigravity' ? currentName : 'Free / Starter');
    return {
        ...(projectId !== undefined ? { projectId } : {}),
        subscriptionTier,
        subscriptionName,
    };
}
function parseQuotaSummaryGroups(body) {
    const data = asRecord(body);
    const rawGroups = Array.isArray(data?.groups) ? data.groups : [];
    return rawGroups.map((entry) => {
        const group = asRecord(entry) ?? {};
        const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
        const buckets = [];
        for (const rawBucket of rawBuckets) {
            const b = asRecord(rawBucket);
            if (b === undefined)
                continue;
            const fraction = typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : (typeof b.remaining_fraction === 'number' ? b.remaining_fraction : undefined);
            if (fraction === undefined && b.disabled !== true)
                continue;
            buckets.push({
                id: String(b.bucketId ?? b.id ?? ''),
                name: String(b.displayName ?? b.name ?? ''),
                window: String(b.window ?? ''),
                remainingFraction: fraction ?? 0,
                resetTime: String(b.resetTime ?? b.reset_time ?? ''),
                ...(b.disabled === true ? { disabled: true } : {}),
            });
        }
        return {
            displayName: String(group.displayName ?? group.name ?? ''),
            description: String(group.description ?? ''),
            buckets,
        };
    });
}
function isGroupArgon(group) {
    if (/argon/i.test(group.displayName))
        return true;
    return group.buckets.some(b => /argon/i.test(`${b.id} ${b.name}`));
}
function isGroupThirdParty(group) {
    if (/claude|gpt|3p/i.test(group.displayName))
        return true;
    return group.buckets.some(b => /3p|claude|gpt/i.test(b.id));
}
/**
 * Determine whether one account is genuinely entitled to Gemini 4 Argon.
 * Mirrors `Antigravity-Manager`'s `checkArgonEligibility`:
 * 1. `ULTRA` / `ENTERPRISE` enjoy Argon via the privileged shared pool unless
 *    upstream explicitly marks Argon disabled.
 * 2. `PRO` requires a dedicated Argon quota group/bucket in
 *    `retrieveUserQuotaSummary` (such as `gemini-argon-wtu-weekly`), or when
 *    summary groups are absent, an active non-disabled Argon model entry.
 * 3. `FREE` or `PRO` without an Argon bucket (e.g. Jio/Student Pro returning
 *    `gemini-4-argon-disabled`) is not eligible.
 * @param summaryGroups - parsed summary groups.
 * @param rawModels - parsed `fetchAvailableModels` entries.
 * @param tier - normalized subscription tier.
 * @returns true when Argon is usable on this account.
 */
export function checkArgonEligibility(summaryGroups, rawModels, tier) {
    const hasExplicitDisabled = rawModels.some(m => /argon/i.test(m.id) && m.disabled);
    if (tier === 'ULTRA' || tier === 'ENTERPRISE') {
        return !hasExplicitDisabled;
    }
    if (summaryGroups.some(isGroupArgon)) {
        return !hasExplicitDisabled;
    }
    if (summaryGroups.length === 0) {
        return rawModels.some(m => /argon/i.test(m.id) && !m.disabled);
    }
    return false;
}
function isCompliantAgentModel(id) {
    const lower = id.trim().toLowerCase();
    if (lower.length === 0
        || lower.includes('-disabled')
        || lower.endsWith('_disabled')
        || lower.startsWith('chat_')
        || lower.startsWith('tab_')
        || lower.includes('internal')
        || lower.includes('-exp')
        || lower.endsWith('-agent')
        || lower.endsWith('-tiered')
        || lower.endsWith('-image')
        || lower === 'gemini-3-flash'
        || lower.startsWith('gemini-2.')
        || lower.startsWith('gemini-2-')
        || lower.startsWith('gemini-1.')) {
        return false;
    }
    return true;
}
const EFFORT_VARIANT_SUFFIX = /^(.+)-(low|medium|high)$/;
function stripEffortLabel(displayName) {
    return displayName.replace(/\s*\((Low|Medium|High)\)\s*$/i, '').trim();
}
const DEFAULT_FAMILY_DISPLAY_NAMES = {
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};
/**
 * Derive an account's exact ACP-selectable models, per-model efforts, context
 * windows, and disabled model ids from `fetchAvailableModels` + `quotaSummary`.
 * @param body - parsed JSON from `v1internal:fetchAvailableModels`.
 * @param summaryGroups - parsed groups from `v1internal:retrieveUserQuotaSummary`.
 * @param tier - authoritative subscription tier.
 * @returns derived per-account model inventory.
 */
export function deriveAccountModels(body, summaryGroups, tier) {
    const data = asRecord(body);
    const modelsMap = asRecord(data?.models) ?? {};
    const rawModels = [];
    const byId = new Map();
    const disabledSet = new Set();
    for (const [rawId, rawInfo] of Object.entries(modelsMap)) {
        const id = rawId.trim();
        const info = asRecord(rawInfo) ?? {};
        const lower = id.toLowerCase();
        const disabled = info.disabled === true || lower.includes('-disabled') || lower.endsWith('_disabled');
        const quotaInfo = asRecord(info.quotaInfo);
        const entry = {
            id,
            ...(typeof info.displayName === 'string' && info.displayName.trim().length > 0 ? { displayName: info.displayName.trim() } : {}),
            disabled,
            ...(typeof info.maxTokens === 'number' && info.maxTokens > 0 ? { maxTokens: info.maxTokens } : {}),
            ...(typeof quotaInfo?.remainingFraction === 'number' ? { remainingFraction: quotaInfo.remainingFraction } : {}),
            ...(typeof quotaInfo?.resetTime === 'string' && quotaInfo.resetTime.length > 0 ? { resetTime: quotaInfo.resetTime } : {}),
        };
        rawModels.push(entry);
        byId.set(id, entry);
        if (disabled) {
            const baseDisabled = id.replace(/-disabled$|_disabled$/i, '');
            if (baseDisabled.length > 0)
                disabledSet.add(baseDisabled);
        }
    }
    const argonEligible = checkArgonEligibility(summaryGroups, rawModels, tier);
    if (!argonEligible && rawModels.some(m => /argon/i.test(m.id))) {
        disabledSet.add('gemini-4-argon');
    }
    // Ordered candidate ids from `agentModelSorts` (`Recommended`), matching
    // official Antigravity IDE and `agy acp` ordering.
    const orderedRawIds = [];
    const sorts = Array.isArray(data?.agentModelSorts) ? data.agentModelSorts : [];
    for (const sort of sorts) {
        const groups = Array.isArray(asRecord(sort)?.groups) ? asRecord(sort).groups : [];
        for (const group of groups) {
            const ids = Array.isArray(asRecord(group)?.modelIds) ? asRecord(group).modelIds : [];
            for (const candidate of ids) {
                if (typeof candidate === 'string' && candidate.trim().length > 0 && !orderedRawIds.includes(candidate.trim())) {
                    orderedRawIds.push(candidate.trim());
                }
            }
        }
    }
    if (orderedRawIds.length === 0) {
        for (const entry of rawModels) {
            if (!entry.disabled && isCompliantAgentModel(entry.id))
                orderedRawIds.push(entry.id);
        }
    }
    // Keep only active, compliant, and Argon-eligible raw ids.
    const activeRawIds = orderedRawIds.filter((id) => {
        if (!isCompliantAgentModel(id))
            return false;
        const info = byId.get(id);
        if (info?.disabled === true)
            return false;
        if (/argon/i.test(id) && !argonEligible)
            return false;
        return true;
    });
    // Count how many distinct effort variants share a stem: families with >=2
    // variants (`gemini-4-argon-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`)
    // collapse into their base family id, while standalone fixed variants like
    // `gpt-oss-120b-medium` stay intact.
    const stemEfforts = new Map();
    for (const id of activeRawIds) {
        const match = EFFORT_VARIANT_SUFFIX.exec(id);
        if (match === null)
            continue;
        const stem = match[1];
        const effort = match[2];
        const list = stemEfforts.get(stem) ?? [];
        if (!list.includes(effort))
            list.push(effort);
        stemEfforts.set(stem, list);
    }
    const models = [];
    const effortsByModel = {};
    const maxTokensByModel = {};
    const seenFamilies = new Set();
    for (const rawId of activeRawIds) {
        const match = EFFORT_VARIANT_SUFFIX.exec(rawId);
        const stem = match?.[1];
        const variants = stem !== undefined ? stemEfforts.get(stem) : undefined;
        const collapsible = stem !== undefined && variants !== undefined && (variants.length >= 2 || byId.has(stem));
        const familyId = collapsible ? stem : rawId;
        const info = byId.get(rawId) ?? byId.get(familyId);
        if (info?.maxTokens !== undefined) {
            maxTokensByModel[familyId] = Math.max(maxTokensByModel[familyId] ?? 0, info.maxTokens);
        }
        if (seenFamilies.has(familyId))
            continue;
        seenFamilies.add(familyId);
        if (collapsible && variants !== undefined) {
            effortsByModel[familyId] = EFFORTS.filter(e => variants.includes(e));
            const baseName = info?.displayName !== undefined ? stripEffortLabel(info.displayName) : undefined;
            models.push({
                id: familyId,
                name: DEFAULT_FAMILY_DISPLAY_NAMES[familyId] ?? (baseName && baseName.length > 0 ? baseName : familyId),
            });
        }
        else {
            effortsByModel[familyId] = [];
            models.push({
                id: familyId,
                name: info?.displayName ?? DEFAULT_FAMILY_DISPLAY_NAMES[familyId] ?? familyId,
            });
        }
    }
    // If upstream granted Argon via a dedicated Pro group or Ultra tier without
    // listing split Argon entries in `models`, inject `gemini-4-argon` (matching
    // Antigravity-Manager lines 715-791).
    if (argonEligible && !models.some(m => /argon/i.test(m.id)) && rawModels.length > 0) {
        models.unshift({ id: 'gemini-4-argon', name: 'Gemini 4 Argon' });
        effortsByModel['gemini-4-argon'] = ['low', 'medium', 'high'];
        maxTokensByModel['gemini-4-argon'] = 1_048_576;
    }
    return {
        models,
        effortsByModel,
        maxTokensByModel,
        disabledModels: [...disabledSet],
        rawModels,
        argonEligible,
    };
}
function summarizeClaudeGptLabel(models) {
    const versions = new Set();
    let hasClaude = false;
    let hasGpt = false;
    for (const model of models) {
        const lower = model.id.toLowerCase();
        if (lower.startsWith('claude')) {
            hasClaude = true;
            const m = /claude-[a-z]+-(\d+)[.-](\d+)/i.exec(lower) ?? /claude-(\d+)[.-](\d+)/i.exec(lower);
            if (m !== null)
                versions.add(`${m[1]}.${m[2]}`);
        }
        else if (lower.startsWith('gpt')) {
            hasGpt = true;
        }
    }
    const sorted = [...versions].sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
    const claudePart = sorted.length > 0 ? `Claude ${sorted.join('/')}` : (hasClaude ? 'Claude' : '');
    if (claudePart && hasGpt)
        return `${claudePart} / GPT`;
    if (claudePart)
        return claudePart;
    return hasGpt ? 'GPT-OSS' : 'Claude / GPT';
}
function summarizeGeminiLabel(models, includeArgon) {
    const hasFlash38 = models.some(m => m.id.toLowerCase().startsWith('gemini-3.8'));
    if (includeArgon && hasFlash38)
        return 'Gemini 4 Argon / 3.8';
    if (includeArgon)
        return 'Gemini 4 Argon';
    if (hasFlash38)
        return 'Gemini 3.8 Flash';
    return 'Gemini';
}
function applyWeeklyExhaustionConstraint(buckets, isFreeTier) {
    const filtered = isFreeTier
        ? buckets.filter(b => !/5h|hour/i.test(`${b.window} ${b.id}`))
        : [...buckets];
    const weeklyExhausted = filtered.some(b => /week|7d/i.test(`${b.window} ${b.id}`) && b.remainingFraction <= 0.005 && !b.disabled);
    if (!weeklyExhausted)
        return filtered;
    return filtered.map((b) => {
        if (/5h|hour/i.test(`${b.window} ${b.id}`)) {
            return { ...b, disabled: true };
        }
        return b;
    });
}
/**
 * Normalize upstream quota groups with full subscription-tier and per-account
 * model awareness:
 * - Preserves dedicated Pro Argon weekly groups (`kind: 'argon'`) separately.
 * - Marks Ultra's shared Gemini+Argon pool (`argonSharedWithGemini: true`).
 * - Applies `[3P ISOLATION]` (drops phantom 3P buckets when the account has no
 *   active Claude/GPT models) and labels actual Claude versions (`5.5` vs `4.6`).
 * @param summaryGroups - parsed groups from `retrieveUserQuotaSummary`.
 * @param accountModels - derived active models of this account.
 * @param rawModels - raw entries from `fetchAvailableModels` (fallback quotaInfo).
 * @param tier - normalized subscription tier.
 * @param argonEligible - whether Argon is active on this account.
 * @returns normalized quota groups and Argon sharing flag.
 */
export function normalizeCloudCodeQuotaGroups(summaryGroups, accountModels, rawModels, tier, argonEligible) {
    const isFreeTier = tier === 'FREE';
    const hasClaudeOrGpt = accountModels.some((m) => {
        const lower = m.id.toLowerCase();
        return lower.startsWith('claude') || lower.startsWith('gpt');
    });
    const dedicatedArgonGroups = summaryGroups.filter(isGroupArgon);
    const hasDedicatedArgon = dedicatedArgonGroups.length > 0;
    const argonSharedWithGemini = argonEligible && !hasDedicatedArgon && (tier === 'ULTRA' || tier === 'ENTERPRISE');
    const out = [];
    if (summaryGroups.length > 0) {
        // 1. Standard Gemini pool (or shared Gemini + Argon pool on Ultra).
        const geminiSource = summaryGroups.filter(g => !isGroupArgon(g) && !isGroupThirdParty(g));
        const geminiBuckets = applyWeeklyExhaustionConstraint(geminiSource.flatMap(g => g.buckets), isFreeTier);
        if (geminiBuckets.length > 0) {
            out.push({
                kind: 'gemini',
                name: summarizeGeminiLabel(accountModels, argonSharedWithGemini),
                description: geminiSource[0]?.description ?? '',
                buckets: geminiBuckets,
            });
        }
        // 2. Independent Argon weekly pool (e.g. Google AI Pro `gemini-argon-wtu-weekly`).
        if (argonEligible && hasDedicatedArgon) {
            const argonBuckets = dedicatedArgonGroups.flatMap(g => g.buckets);
            if (argonBuckets.length > 0) {
                out.push({
                    kind: 'argon',
                    name: 'Gemini 4 Argon',
                    description: dedicatedArgonGroups[0]?.description || 'Independent weekly limit',
                    buckets: argonBuckets,
                });
            }
        }
        // 3. Claude & GPT pool (omitted when the account has zero active 3P models).
        if (hasClaudeOrGpt || accountModels.length === 0) {
            const thirdPartySource = summaryGroups.filter(g => !isGroupArgon(g) && isGroupThirdParty(g));
            const thirdPartyBuckets = applyWeeklyExhaustionConstraint(thirdPartySource.flatMap(g => g.buckets), isFreeTier);
            if (thirdPartyBuckets.length > 0) {
                out.push({
                    kind: 'claude',
                    name: accountModels.length > 0 ? summarizeClaudeGptLabel(accountModels) : 'Claude / GPT',
                    description: thirdPartySource[0]?.description ?? '',
                    buckets: thirdPartyBuckets,
                });
            }
        }
        return { groups: out, argonSharedWithGemini };
    }
    // Fallback when `retrieveUserQuotaSummary` returned no groups: synthesize from
    // `fetchAvailableModels` per-model `quotaInfo` (distinguishing <=6h vs >6h).
    const now = Date.now();
    const buildFallbackBuckets = (predicate, forceWeeklyOnly) => {
        const matched = rawModels.filter(m => !m.disabled && predicate(m.id.toLowerCase()) && m.remainingFraction !== undefined);
        if (matched.length === 0)
            return [];
        const fiveHour = matched.filter((m) => {
            if (!m.resetTime || forceWeeklyOnly)
                return false;
            const diff = Date.parse(m.resetTime) - now;
            return diff > 0 && diff <= 6 * 3600_000;
        });
        const weekly = matched.filter((m) => {
            if (!m.resetTime)
                return forceWeeklyOnly;
            const diff = Date.parse(m.resetTime) - now;
            return forceWeeklyOnly || diff > 6 * 3600_000;
        });
        const buckets = [];
        if (weekly.length > 0) {
            const minW = weekly.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
            buckets.push({
                id: 'fallback-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: minW.remainingFraction,
                resetTime: minW.resetTime ?? '',
            });
        }
        if (!isFreeTier && !forceWeeklyOnly && fiveHour.length > 0) {
            const minH = fiveHour.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
            buckets.push({
                id: 'fallback-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: minH.remainingFraction,
                resetTime: minH.resetTime ?? '',
            });
        }
        return applyWeeklyExhaustionConstraint(buckets, isFreeTier);
    };
    const gemBuckets = buildFallbackBuckets(id => id.startsWith('gemini') && !id.includes('argon'), false);
    if (gemBuckets.length > 0) {
        out.push({
            kind: 'gemini',
            name: summarizeGeminiLabel(accountModels, argonSharedWithGemini),
            description: '',
            buckets: gemBuckets,
        });
    }
    if (argonEligible && !argonSharedWithGemini) {
        const argBuckets = buildFallbackBuckets(id => id.includes('argon'), true);
        if (argBuckets.length > 0) {
            out.push({
                kind: 'argon',
                name: 'Gemini 4 Argon',
                description: 'Independent weekly limit',
                buckets: argBuckets,
            });
        }
    }
    if (hasClaudeOrGpt) {
        const claudeBuckets = buildFallbackBuckets(id => id.startsWith('claude') || id.startsWith('gpt'), false);
        if (claudeBuckets.length > 0) {
            out.push({
                kind: 'claude',
                name: summarizeClaudeGptLabel(accountModels),
                description: '',
                buckets: claudeBuckets,
            });
        }
    }
    return { groups: out, argonSharedWithGemini };
}
async function postWithFallback(path, accessToken, payload, transport, env) {
    const headers = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': OFFICIAL_HUB_USER_AGENT,
    };
    const body = JSON.stringify(payload);
    const hosts = orderedHosts();
    let lastResponse = { status: 0, body: undefined };
    for (const [index, host] of hosts.entries()) {
        try {
            const res = await transport(`${host}${path}`, headers, body, env);
            if (res.status >= 200 && res.status < 300) {
                markHostSuccess(host);
                return res;
            }
            // 401/403 is an account auth/entitlement result, not a host outage.
            if (res.status === 401 || res.status === 403) {
                return res;
            }
            markHostFailure(host);
            lastResponse = res;
            if (index + 1 < hosts.length)
                continue;
        }
        catch (error) {
            markHostFailure(host);
            lastResponse = { status: 0, body: error instanceof Error ? error.message : String(error) };
        }
    }
    return lastResponse;
}
/**
 * Inspect one Antigravity account directly against Cloud Code PA (`loadCodeAssist`,
 * `retrieveUserQuotaSummary`, `fetchAvailableModels`).
 * @param options - account layout, environment, command runner, and optional transport override.
 * @returns structured inspection, or undefined when no OAuth token is stored locally.
 * @throws when the stored token is rejected or all upstream endpoints fail.
 */
export async function inspectCloudCodeAccount(options) {
    const cred = await readAccountOAuthCredential(options.layout, options.runCommand, options.platform);
    if (cred === undefined)
        return undefined;
    const transport = options.transport ?? createCloudCodeTransport(options.runCommand);
    let accessToken = cred.accessToken;
    const needsRefresh = accessToken.length === 0
        || (cred.expiryMs !== undefined && cred.expiryMs <= Date.now() + TOKEN_REFRESH_SKEW_MS);
    if (needsRefresh && cred.refreshToken !== undefined) {
        const refreshed = await refreshAccessToken(cred.refreshToken, transport, options.env);
        if (refreshed !== undefined)
            accessToken = refreshed;
    }
    if (accessToken.length === 0)
        return undefined;
    let loadRes = await postWithFallback('/v1internal:loadCodeAssist', accessToken, { metadata: { ideType: 'ANTIGRAVITY' } }, transport, options.env);
    // Retry once on 401 if a refresh token is available.
    if (loadRes.status === 401 && cred.refreshToken !== undefined) {
        const refreshed = await refreshAccessToken(cred.refreshToken, transport, options.env);
        if (refreshed !== undefined) {
            accessToken = refreshed;
            loadRes = await postWithFallback('/v1internal:loadCodeAssist', accessToken, { metadata: { ideType: 'ANTIGRAVITY' } }, transport, options.env);
        }
    }
    if (loadRes.status === 401) {
        throw new Error('Antigravity OAuth token expired or revoked (HTTP 401)');
    }
    const tierInfo = loadRes.status >= 200 && loadRes.status < 300
        ? parseLoadCodeAssist(loadRes.body)
        : { subscriptionTier: 'FREE' };
    const projectPayload = tierInfo.projectId !== undefined
        ? { project: tierInfo.projectId }
        : {};
    const [summaryRes, modelsRes] = await Promise.all([
        postWithFallback('/v1internal:retrieveUserQuotaSummary', accessToken, projectPayload, transport, options.env),
        postWithFallback('/v1internal:fetchAvailableModels', accessToken, projectPayload, transport, options.env),
    ]);
    if (modelsRes.status === 403) {
        throw new Error(`Account forbidden (HTTP 403): ${typeof modelsRes.body === 'string' ? modelsRes.body : JSON.stringify(modelsRes.body)}`);
    }
    if ((summaryRes.status < 200 || summaryRes.status >= 300) && (modelsRes.status < 200 || modelsRes.status >= 300)) {
        throw new Error(`Cloud Code quota endpoints failed (summary HTTP ${String(summaryRes.status)}, models HTTP ${String(modelsRes.status)})`);
    }
    const summaryGroups = summaryRes.status >= 200 && summaryRes.status < 300
        ? parseQuotaSummaryGroups(summaryRes.body)
        : [];
    const derived = modelsRes.status >= 200 && modelsRes.status < 300
        ? deriveAccountModels(modelsRes.body, summaryGroups, tierInfo.subscriptionTier)
        : {
            models: [],
            effortsByModel: {},
            maxTokensByModel: {},
            disabledModels: [],
            rawModels: [],
            argonEligible: checkArgonEligibility(summaryGroups, [], tierInfo.subscriptionTier),
        };
    const normalized = normalizeCloudCodeQuotaGroups(summaryGroups, derived.models, derived.rawModels, tierInfo.subscriptionTier, derived.argonEligible);
    return {
        ...(cred.email !== undefined ? { email: cred.email } : {}),
        ...(tierInfo.projectId !== undefined ? { projectId: tierInfo.projectId } : {}),
        subscriptionTier: tierInfo.subscriptionTier,
        ...(tierInfo.subscriptionName !== undefined ? { subscriptionName: tierInfo.subscriptionName } : {}),
        groups: normalized.groups,
        models: derived.models,
        effortsByModel: derived.effortsByModel,
        maxTokensByModel: derived.maxTokensByModel,
        disabledModels: derived.disabledModels,
        argonSharedWithGemini: normalized.argonSharedWithGemini,
    };
}
