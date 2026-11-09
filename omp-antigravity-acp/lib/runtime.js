/**
 * Process, session, and conversation orchestration for the Antigravity ACP
 * provider. One `agy acp` front serves every conversation; each DSH session
 * (and each auxiliary purpose within it) owns one ACP session whose history
 * advances incrementally, so subagents and the main conversation run
 * concurrently without sharing a turn.
 * @module omp-antigravity-acp/runtime
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LlmError } from "./host-types.js";
import { AcpProcess } from "./acp-process.js";
import { applyModelAndEffort, detachBridge, freshReanswer, historyPrefixIntact, isOwnMessage, MAIN_PURPOSE, mountBridge, pendingInput, permissionState, planPrompt, } from "./acp-session.js";
import { AccountPool, accountProfileOf, accountVisibleModels, buildLayouts, ensureLayout, familyForModel, loginCommand, pluginHome, proxyUrlFromEnv, readAccountEmail, SYSTEM_ACCOUNT_ID, TRANSIENT_COOLDOWN_MS, } from "./accounts.js";
import { ModelCatalog, intersectVisible, isListedModel, nearestEffort } from "./catalog.js";
import { asEffort, current } from "./config.js";
import { AcpTurn, AWAIT_TOOL, AWAIT_TOOL_NAME, CALL_TOOL, CALL_TOOL_NAME, degradedExhaustedError, degradedRouteError, isReanswerFailure, pumpStep, relayNotice } from "./conversation.js";
import { unlockAccountKeychain } from "./credential.js";
import { AGENT_TOOL_PREFIX, inputPrompt, LOCKED_REPLAY_BUDGET_BYTES, renderFullToolContracts, renderTranscript, replayPrompt, splitSystem, UNLOCKED_REPLAY_BUDGET_BYTES, } from "./history.js";
import { labeled } from "./labels.js";
import { JsonRpcClosedError, JsonRpcRemoteError } from "./jsonrpc.js";
import { McpBridge } from "./mcp-bridge.js";
import { assertSupportedAgyVersion, BRIDGE_AGENT, checkUnlock, defaultPatchScript, GPT_OSS_CONTEXT_WINDOW, LOCKED_CONTEXT_WINDOW, readVersion, resolveAgyBinary, syncOAuthToken, UNLOCKED_CONTEXT_WINDOW, } from "./preflight.js";
import { groupForModel, isWeeklyBucket, QuotaReader, resolveModelQuota } from "./quota.js";
import { RouteHealth } from "./route-health.js";
import { SessionStore } from "./session-store.js";
import { newSlot, rebaseSlot, slotDeniesModel, slotDisablesModel } from "./slots.js";
import { answerPermission as decidePermission, consumeToolDelta, resolveActiveToolSchemas, toBridgeTools, MAX_EAGER_BRIDGE_TOOL_BYTES, } from "./tool-bridge.js";
import { hasGenMetadata, peekMaxGenMetadataIdx, peekMaxModelStepIdx, readGenUsageAfter, readModelStepTail, readModelStepsAfter, sessionDbPath, } from "./usage-db.js";
import { delay, digest, KeyedMutex } from "./util.js";
// The tool-bridge helpers stay importable from this module for existing consumers.
export { compactBridgeTool, consumeToolDelta, MAX_EAGER_BRIDGE_TOOL_BYTES, resolveActiveToolSchemas } from "./tool-bridge.js";
/** Parked calls answer with a still-running notice before Gemini cache TTL expiry and agy's 180-second MCP deadline. */
export const DEFAULT_RELAY_AFTER_MS = 85_000;
/** Automatic re-answers granted for one identical request before a degraded answer is delivered as it is. */
const MAX_REANSWERS_PER_REQUEST = 2;
/** Failure text of a provider whose account list is empty, which only the settings page can fix. */
const NO_ACCOUNT_MESSAGE = 'No Antigravity account is available. Run /agy-login or /agy-accounts add <id>.';
const CONTINUE_PROMPT = 'Continue exactly where your previous output stopped. Do not repeat any earlier text.';
const REROLL_CONTINUATION_PROMPT = '[HARNESS_NOTICE] Your previous attempt was discarded before reaching the user because upstream routed it to a degraded fallback node without executing any tools. Disregard any prior unexecuted draft, inspect the full context and workspace with your tools as needed, and complete my latest request above from scratch.';
/** Owner of the ACP processes, the MCP bridge, and every conversation. */
export class AntigravityRuntime {
    host;
    bridge;
    catalog;
    quota;
    /** Gemini home of the account that owns the shared model catalog. */
    primaryHome;
    sessions;
    pool;
    slots = new Map();
    logins = new Map();
    binary;
    lastError;
    lastAccount;
    conversations = new Map();
    tenants = new Map();
    /** Per-turn call-id tags already issued or observed in history; keeps `<rootCallId>:ptc:<n>` unique session-wide. */
    usedTurnTags = new Set();
    mutex = new KeyedMutex();
    /** Serializes capacity checks and session creation so concurrent requests cannot overshoot maxLiveSessions. */
    capacityMutex = new KeyedMutex();
    /** Serializes pre-execution `gen_metadata` checks for parallel tool calls within the same conversation. */
    gateMutex = new KeyedMutex();
    sweeper;
    lastTurn;
    overrides = {};
    disposed = false;
    /** @param host - host services. */
    constructor(host) {
        this.host = host;
        const layouts = this.resolveLayouts(host.config);
        this.pool = new AccountPool(layouts);
        for (const layout of layouts) {
            this.slots.set(layout.id, newSlot(layout));
        }
        // The plugin's own data (session index, catalog cache) lives in the primary
        // account's directory when there is one. A provider with no account at all
        // keeps it under the plugin home, so a list the user emptied still boots and
        // can gain an account from the settings page afterwards.
        this.primaryHome = (this.pool.get(SYSTEM_ACCOUNT_ID) ?? layouts[0])?.geminiDir ?? pluginHome(host.config.home);
        this.sessions = new SessionStore(join(this.primaryHome, 'session-index.json'));
        this.catalog = new ModelCatalog(join(this.primaryHome, 'catalog.json'));
        this.catalog.applyVisibility(this.providerVisible());
        this.bridge = new McpBridge({
            listTools: tenantKey => this.listTools(tenantKey),
            callTool: request => this.callTool(request),
            authorize: (tenantKey, bearerToken) => this.authorizeTenant(tenantKey, bearerToken),
        }, { keepAliveMs: host.config.keepAliveMs, log: message => host.log.info(message) });
        this.quota = new QuotaReader(() => this.binary, host.runCommand, host.config.quotaTtlMs);
        void this.refreshAccountEmails();
        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref?.();
    }
    /**
     * Record the binding of one conversation so a later process can resume it.
     * Only a main conversation that is clean and fully identified is durable.
     * @param conv - the conversation to record.
     */
    persistConversation(conv) {
        if (conv.purpose !== MAIN_PURPOSE
            || conv.dshSessionId === undefined
            || conv.key.startsWith('anon-')
            || conv.sessionId === undefined
            || conv.accountId === undefined
            || conv.systemHash === undefined
            || conv.knownIds === undefined
            || conv.dirty) {
            return;
        }
        this.sessions.save(conv.dshSessionId, {
            acpSessionId: conv.sessionId,
            accountId: conv.accountId,
            systemHash: conv.systemHash,
            knownIds: [...conv.knownIds],
            advertisedTools: conv.advertisedTools.map(t => ({ ...t })),
            knownTools: [...conv.knownTools.entries()],
            issuedIds: [...conv.issuedIds],
        });
    }
    /**
     * Build the account layouts, degrading to the machine account when the
     * declared list is malformed: one bad entry must not take the provider down.
     */
    resolveLayouts(config) {
        const accounts = this.overrides.accounts ?? current(config.accounts) ?? [];
        try {
            return buildLayouts({ home: config.home, accounts });
        }
        catch (error) {
            this.host.log.warn(`antigravity-acp: ${error instanceof Error ? error.message : String(error)}; falling back to the machine account only`);
            return buildLayouts({
                home: config.home,
                accounts: [{ id: SYSTEM_ACCOUNT_ID, displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [] }],
            });
        }
    }
    /** Configured context window (0 = auto). */
    configuredContextWindow() {
        return this.overrides.contextWindow ?? current(this.host.config.contextWindow);
    }
    /**
     * Declared context window of every family.
     * @returns tokens.
     */
    contextWindow() {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        return this.primaryPreflight()?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
    }
    /**
     * Declared context window of one family: a global default, narrowed by every
     * account that can serve the model. An account may only shrink the window,
     * never widen it beyond the global value. Claude 5.5 shares the 1M pool when
     * the binary is unlocked; GPT-OSS 120B keeps its own 128K-class window.
     * @param model - family id.
     * @returns tokens.
     */
    contextWindowFor(model) {
        const fallback = this.baseContextWindow(model);
        const candidates = this.pool.list().filter(layout => layout.enabled && this.servesModel(layout.id, model));
        if (candidates.length === 0)
            return fallback;
        const windows = candidates.map(layout => layout.contextWindow > 0 ? Math.min(layout.contextWindow, fallback) : fallback);
        return Math.min(...windows);
    }
    baseContextWindow(model) {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        if (model.startsWith('gpt-oss'))
            return GPT_OSS_CONTEXT_WINDOW;
        const discovered = this.catalog.maxTokensFor(model);
        const ceiling = this.primaryPreflight()?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
        return discovered !== undefined && discovered > 0 ? Math.min(discovered, ceiling) : ceiling;
    }
    /**
     * Effort one family will actually run at: the nearest offered effort, or the
     * one baked into a fixed-variant id such as `gpt-oss-120b-medium`.
     * @param model - family id.
     * @param requested - effort the caller asked for.
     * @returns the effort to apply.
     */
    effectiveEffort(model, requested) {
        const offered = this.catalog.effortsFor(model);
        if (offered.length > 0)
            return nearestEffort(requested, offered);
        return this.catalog.fixedEffort(model) ?? requested;
    }
    /** Default effort. */
    defaultEffort() {
        return this.overrides.defaultEffort ?? current(this.host.config.defaultEffort);
    }
    /** Maximum automatic long-decode continuations. */
    longDecodeContinuations() {
        return this.overrides.longDecodeContinuations ?? current(this.host.config.longDecodeContinuations);
    }
    /** Provider-level model allowlist; empty offers every advertised family. */
    providerVisible() {
        return accountVisibleModels(this.overrides.visibleModels ?? current(this.host.config.visibleModels));
    }
    /**
     * Model ids one account may serve.
     * @param accountId - account key, or undefined for the provider ceiling.
     * @returns the effective ids; empty means every advertised family.
     */
    effectiveVisible(accountId) {
        const provider = this.providerVisible();
        if (accountId === undefined)
            return provider;
        const layout = this.slots.get(accountId)?.layout;
        if (layout === undefined)
            return provider;
        return intersectVisible(provider, accountVisibleModels(layout.visibleModels));
    }
    /**
     * Whether an account may serve one family.
     * @param accountId - account key, or undefined for the provider ceiling.
     * @param model - family id.
     * @returns true when the provider and the account both offer it.
     */
    servesModel(accountId, model) {
        const provider = this.providerVisible();
        if (!isListedModel(model, provider))
            return false;
        if (accountId === undefined)
            return true;
        const layout = this.slots.get(accountId)?.layout;
        if (layout === undefined)
            return true;
        return isListedModel(model, accountVisibleModels(layout.visibleModels));
    }
    /**
     * Apply live runtime settings immediately and notify catalog observers.
     * @param patch - updated fields.
     * @returns updated status.
     */
    configure(patch) {
        const next = { ...patch };
        if (next.visibleModels !== undefined)
            next.visibleModels = accountVisibleModels(next.visibleModels);
        let accounts = next.accounts;
        if (accounts !== undefined) {
            const declared = accounts;
            // Re-resolve through the layouts so auto-assigned ids and normalized
            // remarks are what gets stored, and the machine entry keeps `system`.
            accounts = buildLayouts({ home: this.host.config.home, accounts: declared }).map((layout, index) => accountProfileOf(layout, layout.system ? declared[index]?.displayName : undefined));
        }
        this.overrides = { ...this.overrides, ...next, ...accounts !== undefined ? { accounts } : {} };
        if (next.accounts !== undefined)
            this.applyAccounts();
        if (next.visibleModels !== undefined)
            this.catalog.applyVisibility(this.providerVisible());
        this.host.onModelsChanged();
        return this.status();
    }
    applyAccounts() {
        const layouts = this.resolveLayouts(this.host.config);
        this.pool.sync(layouts);
        const live = new Set(layouts.map(layout => layout.id));
        for (const [id, slot] of [...this.slots]) {
            if (live.has(id))
                continue;
            for (const conv of this.conversations.values()) {
                if (conv.accountId !== id)
                    continue;
                void this.resetSession(conv);
                conv.accountId = undefined;
            }
            slot.process?.stop();
            this.slots.delete(id);
        }
        for (const layout of layouts) {
            const slot = this.slots.get(layout.id);
            if (slot === undefined) {
                this.slots.set(layout.id, newSlot(layout));
                continue;
            }
            if (rebaseSlot(slot, layout) && slot.process !== undefined) {
                slot.process.stop();
                slot.process = undefined;
                slot.starting = undefined;
                slot.state = 'idle';
            }
        }
        this.quota.clear();
        this.recomputeUnionCatalog();
        void this.refreshAccountEmails();
    }
    applyQuotaToSlot(slot, snapshot) {
        if (snapshot.subscriptionTier !== undefined)
            slot.subscriptionTier = snapshot.subscriptionTier;
        if (snapshot.subscriptionName !== undefined)
            slot.subscriptionName = snapshot.subscriptionName;
        if (snapshot.disabledModels !== undefined)
            slot.disabledModels = [...snapshot.disabledModels];
        if (snapshot.effortsByModel !== undefined)
            slot.effortsByModel = { ...snapshot.effortsByModel };
        if (snapshot.maxTokensByModel !== undefined)
            slot.maxTokensByModel = { ...snapshot.maxTokensByModel };
        if (snapshot.availableModels !== undefined && snapshot.availableModels.length > 0) {
            slot.availableModels = snapshot.availableModels.map(m => ({ ...m }));
        }
        for (const group of snapshot.groups) {
            const weekly = group.buckets.find(b => isWeeklyBucket(b) && !b.disabled);
            if (weekly !== undefined && weekly.remainingFraction <= 0.005 && weekly.resetTime.length > 0) {
                const key = group.kind === 'argon'
                    ? 'argon'
                    : (group.kind === 'claude' ? 'claude' : 'gemini');
                this.pool.exhaustFor(slot.layout.id, key, weekly.resetTime);
                if (key === 'claude')
                    this.pool.exhaustFor(slot.layout.id, 'gpt-oss', weekly.resetTime);
            }
        }
        if (this.recomputeUnionCatalog())
            this.host.onModelsChanged();
    }
    recomputeUnionCatalog() {
        const inventories = [];
        const effortsByModel = {};
        const maxTokensByModel = {};
        for (const slot of this.slots.values()) {
            if (!slot.layout.enabled || slot.availableModels === undefined || slot.availableModels.length === 0)
                continue;
            inventories.push(slot.availableModels);
            for (const [id, efforts] of Object.entries(slot.effortsByModel ?? {})) {
                if (effortsByModel[id] === undefined || efforts.length > effortsByModel[id].length) {
                    effortsByModel[id] = [...efforts];
                }
            }
            for (const [id, maxTokens] of Object.entries(slot.maxTokensByModel ?? {})) {
                maxTokensByModel[id] = Math.max(maxTokensByModel[id] ?? 0, maxTokens);
            }
        }
        if (inventories.length === 0)
            return false;
        return this.catalog.mergeAccountInventories(inventories, effortsByModel, maxTokensByModel, this.providerVisible());
    }
    observeSlotCatalog(slot, options, available) {
        const modelOption = options?.find(o => o.id === 'model' || o.category === 'model');
        if (modelOption?.options !== undefined && modelOption.options.length > 0) {
            slot.availableModels = modelOption.options.map(o => ({ id: o.value, name: o.name ?? o.value }));
            if (available !== undefined && available.length > 0) {
                const map = { ...(slot.effortsByModel ?? {}) };
                for (const model of slot.availableModels) {
                    const offered = ['low', 'medium', 'high'].filter(e => available.some(a => a.modelId === `${model.id}-${e}`));
                    map[model.id] = [...offered];
                }
                slot.effortsByModel = map;
            }
            if (this.recomputeUnionCatalog()) {
                this.host.onModelsChanged();
                return;
            }
        }
        if (this.catalog.observe(options, available, this.providerVisible())) {
            this.host.onModelsChanged();
        }
    }
    /**
     * Read the stored email and upstream Cloud Code tier/catalog/quota of every
     * configured account so newly added or restarted slots display their real
     * subscription tier and entitled models immediately.
     */
    async refreshAccountEmails() {
        await Promise.all([...this.slots.values()].map(async (slot) => {
            const email = await readAccountEmail(slot.layout, this.host.runCommand).catch(() => undefined);
            slot.email = email;
            if (email !== undefined && email.length > 0) {
                const snap = await this.quota.readFor(slot.layout.id, slot.env, false, slot.layout).catch(() => undefined);
                if (snap !== undefined && snap.status === 'ok') {
                    this.applyQuotaToSlot(slot, snap);
                }
            }
        }));
    }
    primaryPreflight() {
        for (const slot of this.slots.values())
            if (slot.preflight !== undefined)
                return slot.preflight;
        return undefined;
    }
    overallState() {
        const states = [...this.slots.values()].map(slot => slot.state);
        if (states.includes('ready'))
            return 'ready';
        if (states.includes('starting'))
            return 'starting';
        if (states.includes('error'))
            return 'error';
        return 'idle';
    }
    /**
     * Current status for diagnostics surfaces.
     * @returns the status snapshot.
     */
    status() {
        const preflight = this.primaryPreflight();
        const sessionHealth = this.collectSessionHealth();
        return {
            state: this.overallState(),
            ...this.lastError !== undefined ? { error: this.lastError } : {},
            ...preflight !== undefined ? {
                binary: preflight.binary,
                version: preflight.version,
                home: preflight.home,
                unlock: preflight.unlock,
            } : {},
            contextWindow: this.contextWindow(),
            configuredContextWindow: this.configuredContextWindow(),
            defaultEffort: this.defaultEffort(),
            longDecodeContinuations: this.longDecodeContinuations(),
            models: this.catalog.list().map(m => ({ ...m })),
            availableModels: this.catalog.availableModels().map(m => ({ ...m })),
            visibleModels: this.providerVisible(),
            efforts: [...this.catalog.effortList()],
            liveSessions: [...this.conversations.values()].filter(c => c.sessionId !== undefined).length,
            activeTurns: [...this.conversations.values()].filter(c => c.turn !== undefined && !c.turn.finished).length,
            accounts: this.accounts(),
            ...this.lastAccount !== undefined ? { lastAccount: this.lastAccount } : {},
            ...this.lastTurn !== undefined ? { lastTurn: this.lastTurn } : {},
            ...Object.keys(sessionHealth).length > 0 ? { sessionHealth } : {},
        };
    }
    /**
     * Read the live shadow-degradation health snapshot of one DSH session.
     * @param dshSessionId - DSH session id.
     * @returns health status when recorded, otherwise `undefined`.
     */
    sessionHealthFor(dshSessionId) {
        return this.collectSessionHealth()[dshSessionId];
    }
    collectSessionHealth() {
        const out = {};
        for (const conv of this.conversations.values()) {
            if (conv.purpose !== MAIN_PURPOSE || conv.dshSessionId === undefined || conv.sessionId === undefined)
                continue;
            const health = conv.health.snapshot();
            if (health === undefined)
                continue;
            out[conv.dshSessionId] = { sessionId: conv.dshSessionId, acpSessionId: conv.sessionId, ...health };
        }
        return out;
    }
    /**
     * Plan quota of one account, read through that account's own credential store.
     * @param accountId - account to read; defaults to the account that served the last step.
     * @param force - bypass the cache.
     * @returns the quota snapshot.
     */
    async quotaFor(accountId, force = false) {
        const id = accountId ?? this.lastAccount ?? SYSTEM_ACCOUNT_ID;
        const slot = this.slots.get(id);
        if (this.binary === undefined) {
            const target = slot ?? this.slots.get(SYSTEM_ACCOUNT_ID) ?? [...this.slots.values()][0];
            if (target !== undefined)
                await this.runPreflightSlot(target).catch(() => undefined);
        }
        if (slot === undefined)
            return this.quota.read(force);
        if (!slot.layout.system && process.platform === 'darwin')
            await unlockAccountKeychain(slot.layout, this.host.runCommand);
        const snapshot = await this.quota.readFor(id, slot.env, force, slot.layout);
        if (snapshot.status === 'ok')
            this.applyQuotaToSlot(slot, snapshot);
        return snapshot;
    }
    /**
     * Plan quota of the account that serves one model right now.
     *
     * A surface that reads "the account that served the last step" hands a model
     * another account's numbers: a Pro account that just ran a Flash turn lends
     * its untouched Gemini window to Argon, which that plan cannot spend at all.
     * Resolving the account with the scheduler's own rule keeps the number and
     * the model on one subscription, and the echoed `model` lets a caller drop an
     * answer that arrived after the user switched models.
     * @param model - model asked about.
     * @param force - bypass the cache.
     * @param sessionId - DSH session whose bound account should be preferred, so
     * the number belongs to the account this conversation actually spends.
     * @returns the snapshot plus the resolved account and the governing windows.
     */
    async quotaForModel(model, force = false, sessionId) {
        const layout = this.accountForModel(model, sessionId);
        if (layout === undefined) {
            const snapshot = await this.quota.read(force);
            return { ...snapshot, model, focus: resolveModelQuota(snapshot, model) };
        }
        const snapshot = this.withSlotEntitlements(layout.id, await this.quotaFor(layout.id, force));
        return {
            ...snapshot,
            accountId: layout.id,
            accountLabel: this.accountLabel(layout),
            model,
            focus: resolveModelQuota(snapshot, model),
        };
    }
    /**
     * Fold the entitlements the ACP front already reported into a CLI-read
     * snapshot, which carries windows only. Without this a Pro account whose
     * Argon is disabled upstream would look merely unlisted instead of denied.
     * @param accountId - account the snapshot belongs to.
     * @param snapshot - windows read through the account's credential store.
     * @returns the snapshot with the account's known entitlements filled in.
     */
    withSlotEntitlements(accountId, snapshot) {
        const slot = this.slots.get(accountId);
        if (slot === undefined)
            return snapshot;
        const merged = { ...snapshot };
        if ((merged.availableModels === undefined || merged.availableModels.length === 0)
            && slot.availableModels !== undefined && slot.availableModels.length > 0) {
            merged.availableModels = slot.availableModels;
        }
        if (merged.disabledModels === undefined && slot.disabledModels !== undefined)
            merged.disabledModels = [...slot.disabledModels];
        if (merged.subscriptionTier === undefined && slot.subscriptionTier !== undefined)
            merged.subscriptionTier = slot.subscriptionTier;
        if (merged.subscriptionName === undefined && slot.subscriptionName !== undefined)
            merged.subscriptionName = slot.subscriptionName;
        if (merged.argonSharedWithGemini === undefined && slot.subscriptionTier === 'ULTRA')
            merged.argonSharedWithGemini = true;
        return merged;
    }
    /**
     * Account the scheduler would spend one model on, without reserving anything.
     * Preference order: an account that does not deny the model, then the
     * scheduler's own pick, then the best owner of the family when every
     * candidate is parked (its exhausted window is exactly what a person wants to
     * see), then any enabled account of the family.
     * @param model - model asked about.
     * @param sessionId - DSH session that owns the conversation being described.
     * @returns the account layout, or undefined when no account serves the model.
     */
    accountForModel(model, sessionId) {
        const family = familyForModel(model);
        const now = Date.now();
        // The session that already ran keeps its account, so the number belongs to
        // the subscription this conversation actually spends; a fresh conversation
        // follows the pool's own pick.
        const sticky = this.sessionAccount(sessionId) ?? this.lastAccount;
        // Attribution first: an account whose own announced catalog omits the model
        // cannot spend it, even before any other account has announced it — the
        // state right after a restart, or before the first warm-up. Scheduling stays
        // as tolerant as before; only what the pill reports is resolved here.
        const undenying = this.pool.choose(family, sticky, now, layout => !this.accountDeniesModel(layout.id, model) && this.slotCanServeModel(layout.id, model, now));
        if (undenying !== undefined)
            return undenying;
        const ready = this.pool.choose(family, sticky, now, layout => this.slotCanServeModel(layout.id, model, now));
        if (ready !== undefined)
            return ready;
        const parked = this.pool.choose(family, sticky, now);
        if (parked !== undefined)
            return parked;
        return this.pool.list().find(layout => layout.enabled && this.servesModel(layout.id, model));
    }
    /**
     * Account bound to the main conversation of one DSH session, when it has
     * already run a step.
     * @param sessionId - DSH session id.
     * @returns the account key, or undefined before the first step.
     */
    sessionAccount(sessionId) {
        if (sessionId === undefined || sessionId.length === 0)
            return undefined;
        for (const conv of this.conversations.values()) {
            if (conv.dshSessionId === sessionId && conv.purpose === MAIN_PURPOSE && conv.accountId !== undefined)
                return conv.accountId;
        }
        return undefined;
    }
    /**
     * Whether one account's own report rules out a model: it is in the announced
     * catalogue without the model, or upstream marked it disabled.
     * @param accountId - account key.
     * @param model - model asked about.
     * @returns true when the account positively cannot serve the model.
     */
    accountDeniesModel(accountId, model) {
        const slot = this.slots.get(accountId);
        if (slot === undefined)
            return false;
        return slotDeniesModel(slot, model);
    }
    /**
     * Human-readable attribution of one account: remark, then address, then key.
     * @param layout - account layout.
     * @returns the label a surface can show beside a quota number.
     */
    accountLabel(layout) {
        const remark = layout.label.trim();
        if (remark.length > 0)
            return remark;
        const email = this.slots.get(layout.id)?.email;
        if (email !== undefined && email.length > 0)
            return email;
        return layout.id;
    }
    /**
     * Every configured account with its live process state, cooldowns, and sign-in.
     * @returns one row per account in configured order.
     */
    accounts() {
        const sessions = new Map();
        for (const conv of this.conversations.values()) {
            if (conv.sessionId === undefined || conv.accountId === undefined)
                continue;
            sessions.set(conv.accountId, (sessions.get(conv.accountId) ?? 0) + 1);
        }
        return this.pool.list().map((layout) => {
            const slot = this.slots.get(layout.id);
            const ownAllow = accountVisibleModels(layout.visibleModels);
            const slotCatalog = slot?.availableModels ?? this.catalog.availableModels().map(m => ({ id: m.id, name: m.name }));
            const accountAvailable = slotCatalog.map(m => ({
                id: m.id,
                name: m.name,
                enabled: isListedModel(m.id, ownAllow),
            }));
            return {
                id: layout.id,
                label: layout.label,
                system: layout.system,
                enabled: layout.enabled,
                root: layout.root,
                home: layout.declaredHome,
                env: { ...layout.env },
                homeDir: layout.homeDir,
                geminiDir: layout.geminiDir,
                state: slot?.state ?? 'idle',
                error: slot?.error ?? undefined,
                cooldowns: this.pool.cooldowns(layout.id),
                sessions: sessions.get(layout.id) ?? 0,
                email: slot?.email ?? undefined,
                ...(slot?.subscriptionTier !== undefined ? { subscriptionTier: slot.subscriptionTier } : {}),
                ...(slot?.subscriptionName !== undefined ? { subscriptionName: slot.subscriptionName } : {}),
                availableModels: accountAvailable,
                ...(slot?.disabledModels !== undefined && slot.disabledModels.length > 0 ? { disabledModels: [...slot.disabledModels] } : {}),
                contextWindow: layout.contextWindow,
                visibleModels: [...layout.visibleModels],
                priority: layout.priority,
                weight: layout.weight,
                proxyUrl: proxyUrlFromEnv(layout.env),
                usage: {
                    inputTokens: slot?.usage.inputTokens ?? 0,
                    outputTokens: slot?.usage.outputTokens ?? 0,
                    totalTokens: slot?.usage.totalTokens ?? 0,
                },
            };
        });
    }
    /**
     * Run preflight and start one account's ACP front.
     * @param accountId - account to start; defaults to the first enabled one.
     * @returns the running process.
     */
    async ensureReady(accountId) {
        if (this.disposed)
            throw new LlmError(labeled('TRANSPORT', 'Antigravity provider was disposed'), 'TRANSPORT');
        const slot = accountId !== undefined ? this.slotFor(accountId) : this.defaultSlot();
        return this.ensureSlotReady(slot);
    }
    slotFor(accountId) {
        const slot = this.slots.get(accountId);
        if (slot === undefined)
            throw new LlmError(labeled('UNKNOWN_MODEL', `Unknown Antigravity account "${accountId}"`), 'UNKNOWN_MODEL');
        return slot;
    }
    defaultSlot() {
        for (const slot of this.slots.values())
            if (slot.layout.enabled)
                return slot;
        throw new LlmError(labeled('AUTH', 'No enabled Antigravity account is configured'), 'AUTH');
    }
    async ensureSlotReady(slot) {
        if (this.disposed)
            throw new LlmError(labeled('TRANSPORT', 'Antigravity provider was disposed'), 'TRANSPORT');
        if (slot.process?.alive === true)
            return slot.process;
        slot.starting ??= this.startSlot(slot).finally(() => { slot.starting = undefined; });
        return slot.starting;
    }
    /**
     * Warm one or all accounts and refresh their per-account catalogs.
     * @param accountId - optional single account to refresh.
     * @returns resolves when discovery finished.
     */
    async warmup(accountId) {
        // Nothing to discover while the account list is empty; the provider stays
        // idle until the settings page adds an account.
        if (this.pool.list().length === 0)
            return;
        if (accountId !== undefined) {
            const target = this.slotFor(accountId);
            target.email = await readAccountEmail(target.layout, this.host.runCommand).catch(() => undefined);
            if (target.email !== undefined && target.email.length > 0) {
                const snap = await this.quotaFor(target.layout.id, true);
                if (snap.status === 'ok' && snap.availableModels !== undefined && snap.availableModels.length > 0) {
                    this.lastError = undefined;
                    return;
                }
            }
            await this.warmupSlotViaAcp(target);
            return;
        }
        await this.refreshAccountEmails();
        const signedIn = [...this.slots.values()].filter(c => c.layout.enabled && typeof c.email === 'string' && c.email.length > 0);
        if (signedIn.length > 0) {
            const snapshots = await Promise.all(signedIn.map(s => this.quotaFor(s.layout.id, true).catch(() => undefined)));
            if (snapshots.some(s => s !== undefined && s.status === 'ok' && s.availableModels !== undefined && s.availableModels.length > 0)) {
                this.lastError = undefined;
                return;
            }
        }
        const slot = signedIn[0] ?? this.defaultSlot();
        await this.warmupSlotViaAcp(slot);
    }
    async warmupSlotViaAcp(slot) {
        try {
            const proc = await this.ensureSlotReady(slot);
            const result = await proc.newSession({
                cwd: slot.preflight?.workspace ?? slot.layout.workspace,
                mcpServers: [],
            }, { onUpdate: () => undefined }, 120_000);
            this.observeSlotCatalog(slot, result.configOptions, result.models?.availableModels);
            this.lastError = undefined;
            await proc.closeSession(result.sessionId);
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }
    /** Stop every session, every account process, the bridge, and pending sign-ins. */
    async dispose() {
        this.disposed = true;
        if (this.sweeper !== undefined)
            clearInterval(this.sweeper);
        for (const session of this.logins.values())
            session.child.terminate();
        this.logins.clear();
        for (const conv of this.conversations.values()) {
            if (conv.turn === undefined)
                this.persistConversation(conv);
            else
                conv.turn.abandon('The harness provider was unloaded.');
        }
        this.conversations.clear();
        this.tenants.clear();
        for (const slot of this.slots.values()) {
            slot.process?.stop();
            slot.process = undefined;
            slot.state = 'idle';
        }
        await this.bridge.close();
    }
    noteUsage(slot, usage) {
        if (usage === undefined)
            return;
        const input = Math.max(0, Math.round(usage.inputTokens ?? 0));
        const output = Math.max(0, Math.round(usage.outputTokens ?? 0));
        slot.usage.inputTokens += input;
        slot.usage.outputTokens += output;
        slot.usage.totalTokens += Math.max(0, Math.round(usage.totalTokens ?? input + output));
    }
    slotCanServeModel(accountId, model, now = Date.now()) {
        if (!this.servesModel(accountId, model))
            return false;
        if (/argon/i.test(model) && this.pool.cooldownMs(accountId, 'argon', now) > 0)
            return false;
        const slot = this.slots.get(accountId);
        if (slot === undefined)
            return true;
        if (slotDisablesModel(slot, model)) {
            return false;
        }
        if (slot.availableModels !== undefined && slot.availableModels.length > 0) {
            const anySlotListsModel = [...this.slots.values()].some(s => s.availableModels?.some(m => m.id === model) === true);
            if (anySlotListsModel && !slot.availableModels.some(m => m.id === model)) {
                return false;
            }
        }
        const cachedQuota = this.quota.peekFor(accountId);
        if (cachedQuota?.status === 'ok' && cachedQuota.groups.length > 0) {
            const group = groupForModel(cachedQuota.groups, model);
            const weekly = group?.buckets.find(b => isWeeklyBucket(b) && !b.disabled);
            if (weekly !== undefined && weekly.remainingFraction <= 0.005) {
                const resetMs = Date.parse(weekly.resetTime);
                if (!Number.isFinite(resetMs) || resetMs > now)
                    return false;
            }
        }
        return true;
    }
    /**
     * Stream one model step, failing over to another enabled account when the
     * chosen account hits a quota window or lacks model entitlement before any output is emitted.
     * @param options - the model request.
     * @yields stream chunks.
     */
    async *stream(options) {
        if (options.signal?.aborted === true) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
            return;
        }
        // An empty account list is a configuration the user can repair in one step
        // from the settings page, so it reports as a sign-in failure instead of
        // surfacing as a quota exhaustion with no account rows.
        if (!this.pool.list().some(layout => layout.enabled)) {
            throw new LlmError(labeled('AUTH', NO_ACCOUNT_MESSAGE), 'AUTH');
        }
        const declaredPurpose = options.purpose;
        const purpose = declaredPurpose !== undefined && declaredPurpose.length > 0 ? declaredPurpose : MAIN_PURPOSE;
        const scope = options.sessionId ?? `anon-${randomBytes(6).toString('hex')}`;
        const key = `${scope}|${purpose}`;
        const release = await this.mutex.acquire(key);
        const family = familyForModel(options.model);
        const cooldownKey = /argon/i.test(options.model) ? 'argon' : family;
        const attempted = new Set();
        let conv;
        let emitted = false;
        try {
            conv = await this.acquireConversation(key, purpose, options.sessionId);
            conv.lastUsed = Date.now();
            for (;;) {
                const now = Date.now();
                const liveByAccount = new Map();
                for (const c of this.conversations.values()) {
                    if (c.sessionId !== undefined && c.accountId !== undefined) {
                        liveByAccount.set(c.accountId, (liveByAccount.get(c.accountId) ?? 0) + 1);
                    }
                }
                const layout = this.pool.choose(family, conv.accountId, now, candidate => !attempted.has(candidate.id) && this.slotCanServeModel(candidate.id, options.model, now), id => liveByAccount.get(id) ?? 0);
                if (layout === undefined)
                    throw this.poolExhausted(family, attempted, options.model, cooldownKey);
                const slot = this.slotFor(layout.id);
                try {
                    for await (const chunk of this.attempt(conv, slot, options)) {
                        emitted = true;
                        yield chunk;
                    }
                    return;
                }
                catch (error) {
                    if (emitted || attempted.has(layout.id))
                        throw error;
                    if (isUnknownModelFailure(error)) {
                        slot.disabledModels = [...new Set([...(slot.disabledModels ?? []), options.model])];
                        await this.failover(conv, slot, options.model, attempted, {
                            reject: () => error,
                            log: `antigravity-acp: account "${layout.id}" is not entitled to ${options.model}; failing over to another account`,
                            reason: 'The account serving this conversation does not offer the requested model.',
                        });
                        continue;
                    }
                    // Degraded-route failures ask the harness retry layer for the identical
                    // request instead of upstream quota: they must never cool an account
                    // down, park one, or fail the step over to another account.
                    if (isReanswerFailure(error))
                        throw error;
                    const code = failureCode(error);
                    if (code === 'RATE_LIMIT') {
                        // Upstream overload, not an exhausted window: cool the account for
                        // the stated delay and fail over when someone else can serve the
                        // model; with no other account, rethrow so the harness retry layer
                        // asks upstream again instead of burning a whole family window.
                        const message = error instanceof Error ? error.message : String(error);
                        const retryAfterMs = retryAfterMsFromError(error);
                        await this.failover(conv, slot, options.model, attempted, {
                            reject: () => new LlmError(message, 'RATE_LIMIT', {
                                cause: error,
                                ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
                            }),
                            cool: () => {
                                const transientKey = cooldownKey === 'argon' && slot.subscriptionTier !== 'ULTRA' ? 'argon' : family;
                                this.pool.exhaust(layout.id, transientKey, Date.now() + (retryAfterMs ?? TRANSIENT_COOLDOWN_MS), message);
                            },
                            log: `antigravity-acp: account "${layout.id}" is briefly rate limited on ${options.model} (${message}); cooling down and moving to the next account`,
                            reason: 'The account serving this conversation is briefly rate limited.',
                        });
                        continue;
                    }
                    if (!isQuotaFailure(error))
                        throw error;
                    const message = error instanceof Error ? error.message : String(error);
                    await this.failover(conv, slot, options.model, attempted, {
                        cool: () => {
                            const parkKey = cooldownKey === 'argon' && slot.subscriptionTier !== 'ULTRA' ? 'argon' : family;
                            this.pool.exhaustFor(layout.id, parkKey, resetTimeFromError(error), message);
                        },
                        log: `antigravity-acp: account "${layout.id}" cannot serve ${options.model} (${message}); moving to the next account`,
                        reason: 'The account serving this conversation ran out of quota.',
                    });
                }
            }
        }
        finally {
            release();
            if (conv !== undefined) {
                conv.opening = false;
                await this.afterStep(conv);
            }
        }
    }
    /**
     * Move one failed step to the next account: record the failure on the account
     * that served it, then reset the conversation so the retry opens a fresh ACP
     * session elsewhere.
     * @param conv - the conversation being served.
     * @param slot - the account whose attempt failed.
     * @param model - requested model id.
     * @param attempted - accounts already tried in this step.
     * @param outcome.reject - builds the error rethrown when no other account can serve the step; omitted when the account is parked unconditionally.
     * @param outcome.cool - records this account's own cooldown; omitted when the failure already marked the account (a model denial).
     * @param outcome.log - warning line for the server log.
     * @param outcome.reason - why the abandoned turn was dropped.
     */
    async failover(conv, slot, model, attempted, outcome) {
        if (outcome.reject !== undefined && !this.hasAnotherAccount(slot.layout.id, attempted, model))
            throw outcome.reject();
        attempted.add(slot.layout.id);
        outcome.cool?.();
        this.host.log.warn(outcome.log);
        this.dropTurn(conv, outcome.reason);
        await this.resetSession(conv);
        conv.accountId = undefined;
    }
    /**
     * Whether an account other than the failed one could still serve this step.
     * @param accountId - account whose attempt failed.
     * @param attempted - accounts already tried in this step.
     * @param model - requested model id.
     * @returns true when one enabled, untried account can serve the model now.
     */
    hasAnotherAccount(accountId, attempted, model) {
        const now = Date.now();
        return this.pool.list().some(c => c.enabled && c.id !== accountId && !attempted.has(c.id) && this.slotCanServeModel(c.id, model, now));
    }
    /** One attempt of a step on one account; throws when that account cannot serve it. */
    async *attempt(conv, slot, options) {
        const proc = await this.ensureSlotReady(slot);
        if (conv.accountId !== slot.layout.id) {
            this.dropTurn(conv, 'Rebuilding on another account.');
            await this.resetSession(conv);
            conv.accountId = slot.layout.id;
        }
        const split = splitSystem(options);
        const activeSchemas = resolveActiveToolSchemas(options.tools, split.messages);
        const tools = toBridgeTools(activeSchemas);
        conv.toolNames = new Set(tools.map(t => t.name));
        const effort = this.effectiveEffort(options.model, asEffort(options.reasoningEffort) ?? this.defaultEffort());
        const key = reanswerKey(options, split.system);
        if (conv.reanswer.key !== key) {
            // A different request: a pending re-answer is stale, this one starts fresh.
            conv.reanswer.key = key;
            conv.reanswer.granted = 0;
            conv.reanswer.blocks = [];
            conv.reanswer.awaiting = false;
            conv.reanswer.freshSession = false;
        }
        if (conv.reanswer.awaiting) {
            yield* this.reanswer(conv, slot, proc, options, effort, split.system, activeSchemas, tools);
            return;
        }
        if (conv.turn !== undefined && conv.turn.pendingCalls.size > 0) {
            if (!historyPrefixIntact(conv, split.system, split.messages)) {
                this.dropTurn(conv, 'The conversation history was compacted or rewritten; rebuilding the session from the harness history.');
            }
            else {
                const resumed = await this.deliverResults(conv, slot, split.messages, proc, tools);
                if (resumed) {
                    yield* this.pump(conv, slot, proc, options, effort, { nextKnownIds: messageIds(split.messages) });
                    return;
                }
                this.dropTurn(conv, 'The conversation history changed; the harness restarted this turn.');
            }
        }
        else if (conv.turn !== undefined) {
            this.dropTurn(conv, 'Superseded by a newer request.');
        }
        let resumedFromDisk = false;
        if (conv.sessionId === undefined && !conv.dirty && conv.purpose === MAIN_PURPOSE && conv.dshSessionId !== undefined) {
            resumedFromDisk = await this.tryResumePersistedSession(conv, slot, split.system, split.messages, activeSchemas, proc);
        }
        const plan = planPrompt(conv, split.system, split.messages, this.host.config.provider);
        if (plan.rebuild)
            await this.resetSession(conv);
        const freshSession = conv.sessionId === undefined;
        if (freshSession) {
            conv.systemHash = digest(split.system);
            await this.openSession(conv, slot, split.system, activeSchemas, tools, proc);
        }
        const switched = await this.select(conv, proc, options.model, effort);
        const settleMs = this.host.config.coldSwitchSettleMs ?? 80;
        if ((freshSession || resumedFromDisk) && switched && settleMs > 0) {
            await new Promise(resolve => setTimeout(resolve, settleMs));
        }
        const replayBudget = slot.preflight?.unlock.status === 'unlocked'
            ? UNLOCKED_REPLAY_BUDGET_BYTES
            : LOCKED_REPLAY_BUDGET_BYTES;
        let blocks;
        if (plan.rebuild) {
            blocks = await replayPrompt(plan.history, plan.input, this.host.readImage, replayBudget);
        }
        else {
            blocks = await inputPrompt(plan.input, this.host.readImage, { omitPureToolUpdates: true });
            const toolDelta = consumeToolDelta(conv, tools);
            if (toolDelta.length > 0)
                blocks.unshift({ type: 'text', text: `${toolDelta}\n\n` });
        }
        const nextKnownIds = messageIds(split.messages);
        conv.reportedToolCalls.clear();
        conv.turn = new AcpTurn(this.nextTurnTag(split.messages));
        conv.health.beginTurn();
        // Record the request this prompt belongs to; a rebuild above (which
        // replaced the whole bookkeeping object) already cleared it.
        conv.reanswer.key = key;
        conv.reanswer.blocks = blocks;
        conv.reanswer.awaiting = false;
        conv.reanswer.freshSession = false;
        if (conv.sessionId !== undefined)
            this.pinUsageCursors(conv, sessionDbPath(slot.layout.geminiDir, conv.sessionId));
        this.lastAccount = slot.layout.id;
        this.pool.touch(slot.layout.id);
        this.startPrompt(conv, proc, blocks);
        yield* this.pump(conv, slot, proc, options, effort, { nextKnownIds });
    }
    /**
     * Re-send one request that DSH retried after a degraded attempt: continue the
     * warm ACP session with the reroll notice, or — when the degraded attempt
     * never completed a round in a cold session — replace it and re-send the
     * original prompt.
     * @param conv - the conversation whose bookkeeping holds the pending record.
     * @param slot - account serving this conversation.
     * @param proc - its ACP front.
     * @param options - the repeated request.
     * @param effort - resolved reasoning effort.
     * @param system - request system text.
     * @param activeSchemas - tools active for this step.
     * @param tools - their bridge descriptors.
     * @yields stream chunks of the re-answer.
     */
    async *reanswer(conv, slot, proc, options, effort, system, activeSchemas, tools) {
        const state = conv.reanswer;
        const fresh = state.freshSession || conv.sessionId === undefined;
        const original = state.blocks;
        state.awaiting = false;
        state.freshSession = false;
        conv.reportedToolCalls.clear();
        conv.health.beginTurn();
        conv.turn = new AcpTurn(this.nextTurnTag(options.messages));
        let blocks;
        if (fresh) {
            // Only a session that never finished a round is replaced: its poisoned
            // first turn cannot be continued, so the original input is re-sent.
            await this.resetSession(conv);
            conv.reanswer.key = state.key;
            conv.reanswer.granted = state.granted;
            conv.reanswer.blocks = original;
            conv.systemHash = digest(system);
            // Tag the replayed system text so the fresh session's first 2048-token block hashes
            // differently upstream: the fallback pool's prefix cache no longer matches this request.
            await this.openSession(conv, slot, `[reanswer:${conv.tag}:${state.granted}]\n\n${system}`, activeSchemas, tools, proc);
            const freshDb = sessionDbPath(slot.layout.geminiDir, conv.sessionId);
            this.pinUsageCursors(conv, freshDb);
            await this.select(conv, proc, options.model, effort);
            blocks = original.length > 0 ? original : [{ type: 'text', text: REROLL_CONTINUATION_PROMPT }];
        }
        else {
            conv.promptGen++;
            await Promise.race([conv.promptSettled, delay(3_000)]);
            blocks = [{ type: 'text', text: REROLL_CONTINUATION_PROMPT }];
        }
        this.lastAccount = slot.layout.id;
        this.pool.touch(slot.layout.id);
        this.startPrompt(conv, proc, blocks);
        yield* this.pump(conv, slot, proc, options, effort, { nextKnownIds: messageIds(options.messages) });
    }
    async tryResumePersistedSession(conv, slot, system, messages, activeSchemas, proc) {
        const dshId = conv.dshSessionId;
        if (dshId === undefined)
            return false;
        const persisted = this.sessions.get(dshId);
        if (persisted === undefined || persisted.accountId !== slot.layout.id)
            return false;
        if (persisted.systemHash !== digest(system)) {
            this.sessions.forget(dshId);
            return false;
        }
        if (persisted.knownIds.length > messages.length
            || !persisted.knownIds.every((id, idx) => messages[idx]?.id === id)) {
            this.sessions.forget(dshId);
            return false;
        }
        const issued = new Set(persisted.issuedIds);
        const rest = pendingInput(messages.slice(persisted.knownIds.length), message => isOwnMessage(message, this.host.config.provider, issued));
        if (rest.length === 0) {
            this.sessions.forget(dshId);
            return false;
        }
        const caps = proc.initializeResult?.agentCapabilities;
        const dbExists = existsSync(sessionDbPath(slot.layout.geminiDir, persisted.acpSessionId));
        if (!dbExists && caps?.loadSession !== true && caps?.sessionCapabilities?.load === undefined) {
            return false;
        }
        conv.reportedToolCalls.clear();
        conv.advertisedTools = persisted.advertisedTools.map(t => ({ ...t }));
        conv.advertisedToolNames = new Set(persisted.advertisedTools.map(t => t.name));
        conv.knownTools = new Map(persisted.knownTools);
        const mount = mountBridge(conv, {
            bridgeUrl: this.bridge.url,
            system,
            toolContracts: renderFullToolContracts(activeSchemas, MAX_EAGER_BRIDGE_TOOL_BYTES),
            registerTenant: (tenantKey, tenant) => this.tenants.set(tenantKey, tenant),
            observeConfigOptions: options => this.observeSlotCatalog(slot, options, undefined),
            permission: request => this.answerPermission(conv, request),
            warn: message => this.host.log.warn(message),
        });
        try {
            const result = await proc.loadSession({
                sessionId: persisted.acpSessionId,
                cwd: slot.layout.workspace,
                mcpServers: mount.mcpServers,
                _meta: { antigravity: { systemPrompt: { append: mount.systemAppend } } },
            }, mount.listener, 60_000);
            conv.sessionId = result.sessionId || persisted.acpSessionId;
            conv.process = proc;
            conv.configOptions = result.configOptions ?? [];
            conv.systemHash = persisted.systemHash;
            conv.knownIds = [...persisted.knownIds];
            conv.issuedIds = new Set(persisted.issuedIds);
            conv.model = undefined;
            conv.effort = undefined;
            conv.dirty = false;
            this.observeSlotCatalog(slot, result.configOptions, result.models?.availableModels);
            return true;
        }
        catch (error) {
            detachBridge(conv, tenant => this.releaseTenant(tenant));
            this.sessions.forget(dshId);
            this.host.log.info(`antigravity-acp: session/load unavailable for ${persisted.acpSessionId} (${error instanceof Error ? error.message : String(error)}); falling back to session/new`);
            return false;
        }
    }
    /** Explain why no account could serve a step, one line per account. */
    poolExhausted(family, attempted, model, cooldownKey) {
        const now = Date.now();
        let retryAfterMs;
        const rows = this.pool.list().map((layout) => {
            const failed = attempted.has(layout.id) ? ' (failed this step)' : '';
            if (!layout.enabled)
                return `${layout.id} disabled${failed}`;
            if (!this.servesModel(layout.id, model) || this.accountDeniesModel(layout.id, model)) {
                return `${layout.id} not entitled to ${model}${failed}`;
            }
            const familyRemaining = this.pool.cooldownMs(layout.id, family, now);
            const argonRemaining = cooldownKey === 'argon' || /argon/i.test(model) ? this.pool.cooldownMs(layout.id, 'argon', now) : 0;
            const remaining = Math.max(familyRemaining, argonRemaining);
            if (remaining <= 0)
                return `${layout.id} unavailable${failed}`;
            const parkedBucket = argonRemaining > familyRemaining ? 'argon' : family;
            const reason = this.pool.cooldownReason(layout.id, parkedBucket, now);
            const detail = reason === undefined || reason.length === 0 ? '' : ` (last error: ${reason.slice(0, 160)})`;
            const parked = `${layout.id} parked ${Math.ceil(remaining / 60_000)}m${detail}${failed}`;
            retryAfterMs = retryAfterMs === undefined ? remaining : Math.min(retryAfterMs, remaining);
            return parked;
        });
        const message = `No Antigravity account can serve ${model} right now: ${rows.length > 0 ? rows.join('; ') : 'none configured'}`;
        return new LlmError(labeled('RATE_LIMIT', message), 'RATE_LIMIT', retryAfterMs === undefined ? undefined : { providerRetryAfterMs: retryAfterMs });
    }
    async acquireConversation(key, purpose, dshSessionId) {
        const existing = this.conversations.get(key);
        if (existing !== undefined) {
            existing.opening = true;
            return existing;
        }
        const unlock = await this.capacityMutex.acquire('capacity');
        try {
            const again = this.conversations.get(key);
            if (again !== undefined) {
                again.opening = true;
                return again;
            }
            const max = Math.max(1, this.host.config.maxLiveSessions);
            if (this.conversations.size >= max) {
                const idle = [...this.conversations.values()]
                    .filter(c => c.turn === undefined && !c.opening)
                    .sort((a, b) => a.lastUsed - b.lastUsed);
                while (this.conversations.size >= max && idle.length > 0) {
                    const victim = idle.shift();
                    this.persistConversation(victim);
                    this.conversations.delete(victim.key);
                    await this.resetSession(victim, true);
                }
            }
            if (this.conversations.size >= max) {
                throw new LlmError(labeled('RATE_LIMIT', `CAPACITY_EXCEEDED: maxLiveSessions (${max}) reached`), 'RATE_LIMIT');
            }
            const conv = this.createConversation(key, purpose, dshSessionId);
            conv.opening = true;
            return conv;
        }
        finally {
            unlock();
        }
    }
    createConversation(key, purpose, dshSessionId) {
        const cleanDshId = dshSessionId !== undefined && dshSessionId.length > 0 ? dshSessionId : undefined;
        const persistedAccount = purpose === MAIN_PURPOSE && cleanDshId !== undefined
            ? this.sessions.get(cleanDshId)?.accountId
            : undefined;
        const conv = {
            key,
            dshSessionId: cleanDshId,
            purpose,
            tag: randomBytes(3).toString('hex'),
            accountId: persistedAccount !== undefined && this.slots.has(persistedAccount) ? persistedAccount : undefined,
            tenantKey: undefined,
            tenantSecret: undefined,
            sessionId: undefined,
            process: undefined,
            configOptions: [],
            systemHash: undefined,
            advertisedTools: [],
            advertisedToolNames: new Set(),
            knownTools: new Map(),
            toolNames: new Set(),
            reportedToolCalls: new Map(),
            opening: false,
            usageSource: undefined,
            genMetaCursor: -1,
            usageCursor: -1,
            backfilledSteps: 0,
            health: new RouteHealth(purpose === MAIN_PURPOSE),
            reanswer: freshReanswer(),
            promptGen: 0,
            promptSettled: Promise.resolve(),
            knownIds: undefined,
            issuedIds: new Set(),
            turn: undefined,
            dirty: false,
            lastUsed: Date.now(),
            model: undefined,
            effort: undefined,
        };
        this.conversations.set(key, conv);
        return conv;
    }
    async startSlot(slot) {
        slot.state = 'starting';
        slot.error = undefined;
        try {
            const preflight = await this.runPreflightSlot(slot);
            await this.bridge.start();
            const argv = [
                preflight.binary, 'acp',
                '--gemini-dir', preflight.home,
                '--app-data-dir', 'agy',
                '--agent', BRIDGE_AGENT,
                '--process-per-session',
                '--disable-telemetry',
                '--log-file', preflight.logFile,
            ];
            const proc = new AcpProcess({
                argv,
                cwd: preflight.workspace,
                spawn: this.host.spawnAcp,
                env: slot.env,
                clientName: 'jetbrains.dsh',
                clientVersion: '0.1.0',
                log: message => this.host.log.warn(message),
            });
            proc.onExit(error => this.onProcessExit(proc, error));
            await proc.start(120_000);
            slot.process = proc;
            slot.state = 'ready';
            slot.readyAt = Date.now();
            this.lastError = undefined;
            return proc;
        }
        catch (error) {
            slot.state = 'error';
            slot.error = error instanceof Error ? error.message : String(error);
            this.lastError = slot.error;
            throw mapError(error);
        }
    }
    runPreflightSlot(slot) {
        if (slot.preflight !== undefined)
            return Promise.resolve(slot.preflight);
        slot.preflightPromise ??= (async () => {
            const config = this.host.config;
            const binary = resolveAgyBinary(config.command);
            this.binary = binary;
            const version = await readVersion(binary, this.host.runCommand);
            assertSupportedAgyVersion(version, binary);
            const script = config.patchScript.length > 0 ? config.patchScript : defaultPatchScript();
            const unlock = await checkUnlock(binary, script, config.autoPatch, this.host.runCommand);
            this.host.log.info(`antigravity-acp: [${slot.layout.id}] ${unlock.detail}`);
            await ensureLayout(slot.layout, this.host.runCommand);
            const email = await readAccountEmail(slot.layout, this.host.runCommand).catch(() => undefined);
            slot.email = email;
            const result = {
                binary,
                version,
                home: slot.layout.geminiDir,
                workspace: slot.layout.workspace,
                logFile: slot.layout.logFile,
                unlock,
            };
            slot.preflight = result;
            this.host.onModelsChanged();
            return result;
        })().finally(() => { slot.preflightPromise = undefined; });
        return slot.preflightPromise;
    }
    onProcessExit(proc, error) {
        for (const slot of this.slots.values()) {
            if (slot.process !== proc)
                continue;
            slot.process = undefined;
            if (!this.disposed) {
                slot.state = 'error';
                slot.error = error.message;
                this.lastError = error.message;
                this.host.log.warn(`antigravity-acp: [${slot.layout.id}] ${error.message}`);
            }
        }
        for (const conv of this.conversations.values()) {
            if (conv.process !== proc)
                continue;
            const crashedMidTurn = conv.turn !== undefined && !conv.turn.finished;
            if (crashedMidTurn) {
                this.sessions.forget(conv.dshSessionId);
                conv.turn?.events.push({ kind: 'error', error: new LlmError(labeled('TRANSPORT', `Antigravity ACP process exited: ${error.message}`), 'TRANSPORT') });
            }
            else {
                this.persistConversation(conv);
            }
            this.releaseTenant(conv);
            conv.sessionId = undefined;
            conv.process = undefined;
            conv.tenantKey = undefined;
            conv.tenantSecret = undefined;
            conv.advertisedTools = [];
            conv.advertisedToolNames.clear();
            conv.knownTools.clear();
            conv.reportedToolCalls.clear();
            this.resetUsageReading(conv);
            // Same process, same session history of refused answers: keep what the
            // pill already reported about them.
            conv.health = conv.health.reset({ keep: ['interceptedSteps', 'lastInterceptedState'] });
            conv.reanswer = freshReanswer();
            conv.dirty = crashedMidTurn;
        }
    }
    async openSession(conv, slot, system, activeSchemas, tools, proc) {
        syncOAuthToken(slot.layout.geminiDir, slot.layout.homeDir);
        conv.reportedToolCalls.clear();
        conv.advertisedTools = [...tools];
        conv.advertisedToolNames = new Set(tools.map(t => t.name));
        conv.knownTools = new Map(tools.map(t => [t.name, digest(t)]));
        const mount = mountBridge(conv, {
            bridgeUrl: this.bridge.url,
            system,
            toolContracts: renderFullToolContracts(activeSchemas, MAX_EAGER_BRIDGE_TOOL_BYTES),
            registerTenant: (tenantKey, tenant) => this.tenants.set(tenantKey, tenant),
            observeConfigOptions: options => this.observeSlotCatalog(slot, options, undefined),
            permission: request => this.answerPermission(conv, request),
            warn: message => this.host.log.warn(message),
        });
        try {
            const result = await proc.newSession({
                cwd: slot.layout.workspace,
                mcpServers: mount.mcpServers,
                _meta: { antigravity: { systemPrompt: { append: mount.systemAppend } } },
            }, mount.listener, 120_000);
            conv.sessionId = result.sessionId;
            conv.process = proc;
            conv.configOptions = result.configOptions ?? [];
            conv.model = undefined;
            conv.effort = undefined;
            this.resetUsageReading(conv);
            conv.dirty = false;
            conv.issuedIds.clear();
            this.observeSlotCatalog(slot, result.configOptions, result.models?.availableModels);
        }
        catch (error) {
            detachBridge(conv, tenant => this.releaseTenant(tenant));
            throw mapError(error);
        }
    }
    /** Constant-time check of one tenant's current bearer credential. */
    authorizeTenant(tenantKey, bearerToken) {
        if (tenantKey === undefined || bearerToken === undefined)
            return false;
        const secret = this.tenants.get(tenantKey)?.tenantSecret;
        if (secret === undefined)
            return false;
        const left = Buffer.from(bearerToken, 'utf8');
        const right = Buffer.from(secret, 'utf8');
        if (left.length !== right.length) {
            timingSafeEqual(left, left);
            return false;
        }
        return timingSafeEqual(left, right);
    }
    releaseTenant(conv) {
        if (conv.tenantKey === undefined)
            return;
        this.tenants.delete(conv.tenantKey);
        this.bridge.forgetTenant(conv.tenantKey);
    }
    answerPermission(conv, request) {
        return decidePermission(permissionState(conv), request, {
            hasHandshake: tenantKey => this.bridge.hasHandshake(tenantKey),
            warn: message => this.host.log.warn(message),
        });
    }
    async select(conv, proc, model, effort) {
        if (!this.servesModel(conv.accountId, model)) {
            throw new LlmError(labeled('UNKNOWN_MODEL', `Antigravity account "${conv.accountId ?? 'auto'}" is not allowed to serve model "${model}".`), 'UNKNOWN_MODEL');
        }
        return applyModelAndEffort(conv, proc, model, effort, {
            selectableEfforts: id => this.catalog.effortsFor(id),
            fail: mapError,
        });
    }
    async resetSession(conv, keepPersisted = false) {
        if (!keepPersisted)
            this.sessions.forget(conv.dshSessionId);
        if (conv.sessionId !== undefined && conv.process !== undefined) {
            void conv.process.closeSession(conv.sessionId);
        }
        this.releaseTenant(conv);
        conv.sessionId = undefined;
        conv.tenantKey = undefined;
        conv.tenantSecret = undefined;
        conv.process = undefined;
        conv.advertisedTools = [];
        conv.advertisedToolNames.clear();
        conv.knownTools.clear();
        conv.reportedToolCalls.clear();
        this.resetUsageReading(conv);
        conv.health = conv.health.reset();
        conv.reanswer = freshReanswer();
        conv.knownIds = undefined;
        conv.dirty = false;
    }
    startPrompt(conv, proc, blocks) {
        const turn = conv.turn;
        const generation = ++conv.promptGen;
        const p = proc.prompt(conv.sessionId, blocks).then((result) => {
            if (conv.turn === turn && conv.promptGen === generation)
                turn.events.push({ kind: 'done', result });
        }, (error) => {
            if (conv.turn === turn && conv.promptGen === generation)
                turn.events.push({ kind: 'error', error: mapError(error) });
        });
        conv.promptSettled = p.then(() => undefined, () => undefined);
    }
    /**
     * Start one turn's usage reading after everything the session DB already holds:
     * the merged `gen_metadata` cursor and, for the legacy fallback only, the `steps`
     * cursor. Each entry point re-pins both, so no turn reports an earlier turn's rows.
     * @param conv - the conversation starting a turn.
     * @param dbPath - path to its session DB.
     */
    pinUsageCursors(conv, dbPath) {
        conv.genMetaCursor = peekMaxGenMetadataIdx(dbPath);
        conv.usageCursor = peekMaxModelStepIdx(dbPath);
    }
    /**
     * Forget everything known about one ACP session's usage reading: its cursors, the
     * table it reads, and the steps already back-filled from `steps`.
     * @param conv - the conversation whose ACP session is replaced.
     */
    resetUsageReading(conv) {
        conv.usageSource = undefined;
        conv.genMetaCursor = -1;
        conv.usageCursor = -1;
        conv.backfilledSteps = 0;
    }
    /**
     * Which table reports this ACP session's per-step usage. Decided once per session,
     * when the session DB exists: a DB carrying `gen_metadata` rows is read only through
     * the merged generation path, so one generation is never billed by both paths; an
     * old `agy` without the table keeps reading `steps`, exactly as before.
     * @param conv - the conversation being read.
     * @param dbPath - path to its session DB.
     * @returns the source, or `undefined` while the DB does not exist yet.
     */
    usageSource(conv, dbPath) {
        if (conv.usageSource !== undefined)
            return conv.usageSource;
        if (!existsSync(dbPath))
            return undefined;
        conv.usageSource = hasGenMetadata(dbPath) ? 'gen' : 'steps';
        return conv.usageSource;
    }
    /**
     * The one read path: read the generations committed since the last read, judge their
     * route health, and stage their usage for the DSH step that is ending. The same batch
     * therefore reports the usage and feeds the fingerprint without being read twice.
     * @param conv - the conversation reading its own session DB.
     * @param dbPath - path to that session DB.
     * @param model - model that produced the generations.
     * @param effort - resolved reasoning effort.
     * @param options - whether the ending step is a tool step, whether its last
     * generation could still be refused, and how many polls to allow while the expected
     * row has not been committed yet.
     * @returns the verdict of the last billed generation, when any.
     */
    async readGenStepSample(conv, dbPath, model, effort, options) {
        let batch = readGenUsageAfter(dbPath, conv.genMetaCursor);
        for (let attempt = 0; batch === undefined && attempt < (options.polls ?? 3); attempt++) {
            await delay(15);
            batch = readGenUsageAfter(dbPath, conv.genMetaCursor);
        }
        if (batch === undefined)
            return undefined;
        // The cursor advances past the all-zero rows too: a failed or refused request has
        // no step behind it, and its row must never be read a second time.
        conv.genMetaCursor = batch.maxIdx;
        if (batch.calls === 0)
            return undefined;
        conv.turn?.stageStepUsage(batch);
        return conv.health.observeGenBatchHealth(model, effort, batch, options.isToolStep, options.isInterceptable ?? options.isToolStep);
    }
    /**
     * Reconcile one finished ACP turn: when the session DB holds more completed model
     * steps than billed `gen_metadata` rows, `agy` never committed the last steps'
     * generation rows, so their usage is back-filled from `steps` and judged without the
     * pre-send context estimate. Each table is counted in its own coordinates (the two
     * `idx` columns are unrelated), so a gap is found by count and reported once.
     * @param conv - the conversation whose turn just ended.
     * @param dbPath - path to its session DB.
     * @param model - model that produced the steps.
     * @param effort - resolved reasoning effort.
     */
    reconcileTurnUsage(conv, dbPath, model, effort) {
        const stepsDone = readModelStepsAfter(dbPath, -1)?.calls ?? 0;
        const genBilled = readGenUsageAfter(dbPath, -1)?.calls ?? 0;
        const missing = stepsDone - genBilled - conv.backfilledSteps;
        if (missing <= 0)
            return;
        const gap = readModelStepTail(dbPath, missing);
        if (gap === undefined)
            return;
        conv.backfilledSteps += gap.calls;
        conv.turn?.stageStepUsage(gap);
        conv.health.observeStepBatchHealth(model, effort, gap);
        this.host.log.warn(`antigravity-acp: usage-gap ${basename(dbPath)}: back-filled ${gap.usage.totalTokens ?? 0} tokens from ${gap.calls} completed step(s) that gen_metadata never billed (${stepsDone} steps, ${genBilled} billed generations)`);
    }
    async *pump(conv, slot, proc, options, effort, ctx) {
        const turn = conv.turn;
        const holdZeroThoughtText = conv.purpose === MAIN_PURPOSE && /argon/i.test(options.model) && effort === 'high';
        let finishKind;
        try {
            for await (const chunk of pumpStep(turn, {
                parkSettleMs: this.host.config.parkSettleMs,
                maxContinuations: this.longDecodeContinuations(),
                holdZeroThoughtText,
                continuePrompt: () => proc.prompt(conv.sessionId, [{ type: 'text', text: CONTINUE_PROMPT }]),
                cancel: () => {
                    if (conv.sessionId !== undefined)
                        proc.cancel(conv.sessionId);
                },
                recordUsage: (usage, steps) => {
                    this.lastTurn = { model: options.model, effort, steps, ...usage !== undefined ? { usage } : {}, at: new Date().toISOString() };
                },
                verifyEndTurn: async () => {
                    if (conv.purpose !== MAIN_PURPOSE || !/argon/i.test(options.model) || conv.sessionId === undefined) {
                        return 'ok';
                    }
                    const dbPath = sessionDbPath(slot.layout.geminiDir, conv.sessionId);
                    if (!existsSync(dbPath))
                        return 'ok';
                    if (this.usageSource(conv, dbPath) !== 'gen')
                        return 'ok';
                    // The merged read both reports this step's usage and judges its route, so
                    // the answer is refused before the usage chunk is ever produced.
                    const verdict = await this.readGenStepSample(conv, dbPath, options.model, effort, {
                        isToolStep: false,
                        isInterceptable: false,
                    });
                    if (verdict?.degraded !== true)
                        return 'ok';
                    conv.health.noteDegradedAttempt(verdict, options.model);
                    if (conv.reanswer.granted >= MAX_REANSWERS_PER_REQUEST) {
                        // The budget is spent: deliver this degraded answer as it is.
                        return 'ok';
                    }
                    conv.health.interceptedSteps += 1;
                    conv.reanswer.granted += 1;
                    conv.reanswer.awaiting = true;
                    conv.reanswer.freshSession = false;
                    // The refused answer is never delivered, so its usage is never reported.
                    turn.discardStagedUsage();
                    return 'degrade';
                },
                consumeStepUsage: async (sampleOptions) => {
                    const currentSessionId = conv.sessionId;
                    const dbPath = sessionDbPath(slot.layout.geminiDir, currentSessionId);
                    if (!existsSync(dbPath))
                        return undefined;
                    const source = this.usageSource(conv, dbPath);
                    if (source === 'steps') {
                        // Legacy fallback for an old `agy` without `gen_metadata`: completed steps
                        // stay the only usage and health source, exactly as before the merge.
                        let batch = readModelStepsAfter(dbPath, conv.usageCursor);
                        for (let attempt = 0; batch === undefined && attempt < 3; attempt++) {
                            await delay(25);
                            batch = readModelStepsAfter(dbPath, conv.usageCursor);
                        }
                        if (batch === undefined)
                            return undefined;
                        conv.usageCursor = batch.maxIdx;
                        conv.health.observeStepBatchHealth(options.model, effort, batch);
                        turn.recordStepBatch(batch);
                        const lastStep = batch.steps[batch.steps.length - 1];
                        if (batch.steps.length > 1 && lastStep !== undefined) {
                            const sumOut = batch.usage.outputTokens ?? 0;
                            const sumThought = batch.usage.thoughtTokens ?? 0;
                            const latestUsage = {
                                inputTokens: lastStep.inputTokens,
                                outputTokens: sumOut,
                                cachedReadTokens: lastStep.cachedReadTokens,
                                cachedWriteTokens: lastStep.cachedWriteTokens,
                                thoughtTokens: sumThought,
                                totalTokens: lastStep.inputTokens + lastStep.cachedReadTokens + lastStep.cachedWriteTokens + sumOut,
                            };
                            return { usage: latestUsage, calls: 1 };
                        }
                        return { usage: batch.usage, calls: batch.calls };
                    }
                    if (source !== 'gen')
                        return undefined;
                    // A tool step already read its generation in the gate and a text step in the
                    // end-of-turn check; reading again would only find an empty cursor.
                    if (!turn.hasStagedUsage()) {
                        await this.readGenStepSample(conv, dbPath, options.model, effort, { isToolStep: false, isInterceptable: false });
                    }
                    if (sampleOptions.final) {
                        // Last step of the ACP turn: the only point where a tail `gen_metadata`
                        // never billed can still be reported inside this step's usage.
                        this.reconcileTurnUsage(conv, dbPath, options.model, effort);
                    }
                    const staged = turn.takeStepUsage();
                    if (staged === undefined)
                        return undefined;
                    turn.recordStepBatch(staged);
                    const lastStep = staged.steps[staged.steps.length - 1];
                    if (staged.steps.length > 1 && lastStep !== undefined) {
                        const sumOut = staged.usage.outputTokens ?? 0;
                        const sumThought = staged.usage.thoughtTokens ?? 0;
                        const latestUsage = {
                            inputTokens: lastStep.inputTokens,
                            outputTokens: sumOut,
                            cachedReadTokens: lastStep.cachedReadTokens,
                            cachedWriteTokens: lastStep.cachedWriteTokens,
                            thoughtTokens: sumThought,
                            totalTokens: lastStep.inputTokens + lastStep.cachedReadTokens + lastStep.cachedWriteTokens + sumOut,
                        };
                        return { usage: latestUsage, calls: 1 };
                    }
                    return { usage: staged.usage, calls: staged.calls };
                },
            }, options.signal)) {
                if (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
                    conv.issuedIds.add(chunk.block.id);
                if (chunk.type === 'usage')
                    this.noteUsage(slot, chunk.usage);
                if (chunk.type === 'finish')
                    finishKind = chunk.reason.kind;
                yield chunk;
            }
        }
        catch (error) {
            if (isReanswerFailure(error)) {
                // A degraded step keeps its ACP session: only the answer was refused.
                // Nothing is persisted or forgotten, so the harness retry re-asks the
                // identical request and the plugin can re-answer in place.
                conv.promptGen++;
                conv.reportedToolCalls.clear();
                conv.turn = undefined;
                if (failureCode(error) === 'DEGRADED_ROUTE')
                    conv.knownIds = ctx.nextKnownIds;
                await Promise.race([conv.promptSettled, delay(3_000)]);
                throw error;
            }
            conv.reportedToolCalls.clear();
            conv.turn = undefined;
            conv.dirty = true;
            this.sessions.forget(conv.dshSessionId);
            throw mapError(error);
        }
        if (finishKind === 'tool-calls') {
            conv.knownIds = ctx.nextKnownIds;
            return;
        }
        if (finishKind === 'aborted') {
            await turnSettled(turn, 5_000);
            conv.dirty = true;
            this.sessions.forget(conv.dshSessionId);
        }
        else {
            conv.knownIds = ctx.nextKnownIds;
            conv.reanswer.rounds += 1;
            conv.health.finalizeTurnHealth(options.model);
            this.persistConversation(conv);
        }
        conv.reportedToolCalls.clear();
        conv.turn = undefined;
    }
    async deliverResults(conv, slot, messages, proc, tools) {
        const turn = conv.turn;
        const results = new Map();
        let last = -1;
        messages.forEach((message, index) => {
            if (message.role === 'tool' && turn.pendingCalls.has(message.toolCallId)) {
                results.set(message.toolCallId, message);
                last = Math.max(last, index);
            }
        });
        if (results.size !== turn.pendingCalls.size)
            return false;
        const extras = messages.slice(last + 1);
        if (extras.some(m => m.role === 'assistant' || m.role === 'tool'))
            return false;
        const nonPureExtras = extras.filter(m => !(m.role === 'developer' && m.content.length > 0 && m.content.every(b => b.type === 'tool-addition' || b.type === 'tool-removal')));
        const extraText = nonPureExtras.length > 0 ? renderTranscript(nonPureExtras) : '';
        const toolDelta = consumeToolDelta(conv, tools);
        const suffix = [toolDelta, extraText].filter(Boolean).join('\n\n');
        const pending = [...turn.pendingCalls.values()];
        turn.pendingCalls.clear();
        if (turn.finished || !this.isTurnLive(turn)) {
            const transcript = renderTranscript(pending.map(call => results.get(call.id)));
            conv.reportedToolCalls.clear();
            conv.turn = new AcpTurn(this.nextTurnTag(messages));
            if (conv.sessionId !== undefined)
                this.pinUsageCursors(conv, sessionDbPath(slot.layout.geminiDir, conv.sessionId));
            this.startPrompt(conv, proc, [{ type: 'text', text: `${transcript}${suffix ? `\n\n${suffix}` : ''}\n\nContinue the task with these tool results.` }]);
            return true;
        }
        for (const [index, call] of pending.entries()) {
            const message = results.get(call.id);
            const result = await this.toBridgeResult(message.content, message.isError === true);
            if (index === pending.length - 1 && suffix.length > 0)
                result.content.push({ type: 'text', text: `\n\n${suffix}` });
            call.result.resolve(result);
        }
        return true;
    }
    isTurnLive(turn) {
        const head = turn.events.peek();
        return head?.kind !== 'done' && head?.kind !== 'error';
    }
    async toBridgeResult(content, isError) {
        const items = [];
        for (const block of content) {
            if (block.type === 'text') {
                if (block.text.length > 0)
                    items.push({ type: 'text', text: block.text });
            }
            else if (block.type === 'image' && block.offloaded !== true && this.host.canReadImages()) {
                const image = await this.host.readImage(block);
                if (image !== undefined)
                    items.push({ type: 'image', data: image.data, mimeType: image.mimeType });
                else {
                    const id = 'attachment' in block && block.attachment !== undefined ? block.attachment.attachmentId : 'inline';
                    items.push({ type: 'text', text: `[image ${id} unavailable]` });
                }
            }
            else {
                const rendered = renderTranscript([{ role: 'user', content: [block] }]);
                if (rendered.length > 0)
                    items.push({ type: 'text', text: rendered });
            }
        }
        if (items.length === 0)
            items.push({ type: 'text', text: '(no output)' });
        return { content: items, ...isError ? { isError: true } : {} };
    }
    dropTurn(conv, reason) {
        const turn = conv.turn;
        if (turn === undefined)
            return;
        if (!turn.finished && conv.sessionId !== undefined)
            conv.process?.cancel(conv.sessionId);
        turn.abandon(reason);
        conv.turn = undefined;
        conv.dirty = true;
        conv.reportedToolCalls.clear();
        this.sessions.forget(conv.dshSessionId);
    }
    isIdle(conv) {
        return conv.turn === undefined && !conv.opening;
    }
    async afterStep(conv) {
        conv.lastUsed = Date.now();
        const idle = this.isIdle(conv);
        if (idle && (conv.purpose !== MAIN_PURPOSE || conv.key.startsWith('anon-'))) {
            await this.resetSession(conv);
            this.conversations.delete(conv.key);
            return;
        }
        if (idle && conv.sessionId === undefined && this.conversations.get(conv.key) === conv) {
            this.conversations.delete(conv.key);
        }
    }
    listTools(tenantKey) {
        const conv = tenantKey === undefined ? undefined : this.tenants.get(tenantKey);
        if (conv === undefined)
            return [];
        return [...conv.advertisedTools, AWAIT_TOOL, CALL_TOOL];
    }
    /**
     * Judge the `gen_metadata` row of the generation that is about to run one
     * tool call. A degraded route never executes the tool: the call is refused,
     * the prompt is cancelled, and the step fails with `DEGRADED_ROUTE` so the
     * harness re-asks the identical request and the plugin re-answers.
     * @param conv - the conversation issuing the call.
     * @param turn - its live ACP turn.
     * @param signal - DSH cancellation of the MCP call.
     * @returns an error result that refuses the call, or undefined to allow it.
     */
    async evaluateToolGate(conv, turn, signal) {
        if (conv.purpose !== MAIN_PURPOSE
            || conv.sessionId === undefined
            || conv.accountId === undefined
            || !/argon/i.test(conv.model ?? '')) {
            return undefined;
        }
        const slot = this.slots.get(conv.accountId);
        if (slot === undefined)
            return undefined;
        const dbPath = sessionDbPath(slot.layout.geminiDir, conv.sessionId);
        if (!existsSync(dbPath))
            return undefined;
        if (this.usageSource(conv, dbPath) !== 'gen')
            return undefined;
        const model = conv.model ?? 'gemini-4-argon';
        const effort = conv.effort ?? this.defaultEffort();
        let verdict;
        const unlock = await this.gateMutex.acquire(conv.key);
        try {
            // The merged read judges the generation that is about to run this tool call and
            // stages its usage for the step that ends when the call is handed over.
            verdict = await this.readGenStepSample(conv, dbPath, model, effort, { isToolStep: true });
        }
        finally {
            unlock();
        }
        if (verdict?.degraded !== true)
            return undefined;
        if (signal.aborted)
            return { content: [{ type: 'text', text: 'The tool call was cancelled.' }], isError: true };
        conv.health.noteDegradedAttempt(verdict, model);
        // The refused generation is never delivered, so its usage is never reported.
        turn.discardStagedUsage();
        const exhausted = conv.reanswer.granted >= MAX_REANSWERS_PER_REQUEST;
        if (!exhausted) {
            conv.health.interceptedSteps += 1;
            conv.reanswer.granted += 1;
            conv.reanswer.awaiting = true;
            // Only a cold session that never finished a round cannot be continued in
            // place once its turn was cancelled mid-tool-call.
            conv.reanswer.freshSession = conv.reanswer.rounds === 0 && turn.toolSteps === 0;
        }
        if (conv.sessionId !== undefined)
            conv.process?.cancel(conv.sessionId);
        turn.events.push({ kind: 'error', error: exhausted ? degradedExhaustedError() : degradedRouteError() });
        return {
            content: [{
                    type: 'text',
                    text: exhausted
                        ? 'Upstream kept routing this attempt to a degraded fallback node; the harness aborted the step and this tool call was NOT executed.'
                        : 'Upstream routed this attempt to a degraded fallback node; the harness is re-answering the same request, so this tool call was NOT executed and no state changed.',
                }],
            isError: true,
        };
    }
    async callTool(request) {
        const conv = request.tenantKey !== undefined ? this.tenants.get(request.tenantKey) : undefined;
        if (conv === undefined) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (request.conversationId !== undefined && (conv.sessionId === undefined || request.conversationId !== conv.sessionId)) {
            return { content: [{ type: 'text', text: 'Tenant session mismatch.' }], isError: true };
        }
        const turn = conv.turn;
        if (turn === undefined || turn.finished) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (request.name === AWAIT_TOOL_NAME) {
            const callId = typeof request.arguments.call_id === 'string' ? request.arguments.call_id : '';
            const call = turn.calls.get(callId);
            if (call === undefined)
                return { content: [{ type: 'text', text: `Unknown harness call id ${callId}.` }], isError: true };
            turn.relaying = false;
            return this.awaitCall(turn, call, request.signal);
        }
        if (request.name === CALL_TOOL_NAME) {
            const rawTarget = typeof request.arguments.name === 'string' ? request.arguments.name.trim() : '';
            const targetName = rawTarget.startsWith(AGENT_TOOL_PREFIX) ? rawTarget.slice(AGENT_TOOL_PREFIX.length) : rawTarget;
            const rawArgs = request.arguments.arguments;
            const targetArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
                ? rawArgs
                : {};
            if (!conv.toolNames.has(targetName)) {
                return { content: [{ type: 'text', text: `The harness has no tool named ${targetName}.` }], isError: true };
            }
            const gated = await this.evaluateToolGate(conv, turn, request.signal);
            if (gated !== undefined)
                return gated;
            const call = turn.park(targetName, targetArgs);
            return this.awaitCall(turn, call, request.signal);
        }
        if (!conv.toolNames.has(request.name)) {
            return { content: [{ type: 'text', text: `The harness has no tool named ${request.name}.` }], isError: true };
        }
        const gated = await this.evaluateToolGate(conv, turn, request.signal);
        if (gated !== undefined)
            return gated;
        const call = turn.park(request.name, request.arguments);
        return this.awaitCall(turn, call, request.signal);
    }
    async awaitCall(turn, call, signal) {
        let timer;
        const relayAfterMs = this.host.relayAfterMs ?? this.host.config.relayAfterMs ?? DEFAULT_RELAY_AFTER_MS;
        const relay = new Promise(resolve => { timer = setTimeout(() => resolve('relay'), relayAfterMs); });
        const aborted = new Promise(resolve => {
            if (signal.aborted)
                resolve('aborted');
            else
                signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        try {
            const outcome = await Promise.race([call.result.promise, relay, aborted]);
            if (outcome === 'relay') {
                turn.relaying = true;
                return relayNotice(call);
            }
            if (outcome === 'aborted')
                return { content: [{ type: 'text', text: 'The tool call was cancelled.' }], isError: true };
            return outcome;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    sweep() {
        const ttl = this.host.config.idleSessionTtlMs;
        const now = Date.now();
        for (const conv of [...this.conversations.values()]) {
            if (this.isIdle(conv) && now - conv.lastUsed > ttl) {
                this.persistConversation(conv);
                void this.resetSession(conv, true);
                this.conversations.delete(conv.key);
            }
        }
        const busy = new Set();
        for (const conv of this.conversations.values()) {
            if (conv.sessionId !== undefined && conv.accountId !== undefined)
                busy.add(conv.accountId);
        }
        for (const slot of this.slots.values()) {
            if (slot.process === undefined || busy.has(slot.layout.id))
                continue;
            if (now - Math.max(this.pool.lastUsed(slot.layout.id), slot.readyAt) < ttl)
                continue;
            slot.process.stop();
            slot.process = undefined;
            slot.state = 'idle';
        }
    }
    /**
     * Prepare an account sandbox and start an interactive sign-in.
     * @param accountId - account to sign in.
     * @returns the authorization URL and a terminal command fallback.
     */
    async beginLogin(accountId) {
        const slot = this.slotFor(accountId);
        const binary = this.binary ?? resolveAgyBinary(this.host.config.command);
        this.binary = binary;
        await ensureLayout(slot.layout, this.host.runCommand);
        const command = loginCommand(slot.layout, binary);
        this.logins.get(accountId)?.child.terminate();
        this.logins.delete(accountId);
        const child = this.host.spawnAcp([binary, 'acp', '--login'], slot.layout.workspace, slot.env);
        const url = await readLoginUrl(child, 45_000);
        if (url.length === 0) {
            child.terminate();
            throw new LlmError(`Antigravity returned no sign-in URL for account "${accountId}". Run this in a terminal instead: ${command}`, 'AUTH');
        }
        void child.exited.then(() => { if (this.logins.get(accountId)?.child === child)
            this.logins.delete(accountId); });
        this.logins.set(accountId, { child, url });
        return { accountId, url, command };
    }
    /**
     * Finish an interactive sign-in with the authorization code from the browser.
     * @param accountId - account being signed in.
     * @param code - authorization code pasted from the browser.
     * @returns whether the account now holds a credential.
     */
    async completeLogin(accountId, code) {
        const session = this.logins.get(accountId);
        if (session === undefined)
            return { ok: false, email: undefined, error: 'No sign-in is pending for this account.' };
        const slot = this.slotFor(accountId);
        session.child.stdin.write(`${code.trim()}\n`);
        const outcome = await Promise.race([session.child.exited, delay(120_000).then(() => 'timeout')]);
        if (this.logins.get(accountId)?.child === session.child)
            this.logins.delete(accountId);
        if (outcome === 'timeout') {
            session.child.terminate();
            return { ok: false, email: undefined, error: 'The sign-in did not finish within 120 seconds.' };
        }
        let email = await readAccountEmail(slot.layout, this.host.runCommand).catch(() => undefined);
        for (let attempt = 0; email === undefined && outcome.code === 0 && attempt < 3; attempt++) {
            await delay(150);
            email = await readAccountEmail(slot.layout, this.host.runCommand).catch(() => undefined);
        }
        slot.email = email;
        this.quota.clear();
        const ok = email !== undefined || outcome.code === 0;
        return {
            ok,
            email,
            error: ok ? undefined : `agy exited with code ${String(outcome.code)} ${session.child.stderrTail()}`.trim(),
        };
    }
    /**
     * Abandon a pending sign-in.
     * @param accountId - account whose sign-in should stop.
     */
    cancelLogin(accountId) {
        const session = this.logins.get(accountId);
        if (session === undefined)
            return;
        this.logins.delete(accountId);
        session.child.terminate();
    }
    /**
     * Mint a fresh 48-bit hex turn tag (`agy_<tag>_<n>`) disjoint from every
     * call id already issued by this runtime or present in `messages`, so
     * multi-turn tool calls and derived `<rootCallId>:ptc:<n>` sub-call ids
     * never collide within a durable session.
     */
    nextTurnTag(messages) {
        collectUsedTurnTags(messages, this.usedTurnTags);
        for (;;) {
            const candidate = randomBytes(6).toString('hex');
            if (!this.usedTurnTags.has(candidate)) {
                this.usedTurnTags.add(candidate);
                return candidate;
            }
        }
    }
}
function collectUsedTurnTags(messages, into) {
    const recordId = (id) => {
        if (typeof id !== 'string')
            return;
        const match = /^agy_([0-9a-f]+)_/i.exec(id);
        if (match?.[1] !== undefined)
            into.add(match[1].toLowerCase());
    };
    for (const message of messages) {
        if (message.role === 'tool') {
            recordId(message.toolCallId);
        }
        else if (message.role === 'assistant') {
            for (const block of message.content) {
                if (block.type === 'tool-call')
                    recordId(block.id);
            }
        }
    }
}
async function readLoginUrl(child, timeoutMs) {
    let buffer = '';
    const match = () => /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(buffer)?.[0];
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(match() ?? '');
        };
        const onData = (chunk) => {
            buffer += chunk.toString();
            if (match() !== undefined)
                finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        child.stdout.on('data', onData);
        void child.exited.then(finish, finish);
    });
}
function isUnknownModelFailure(error) {
    return error?.code === 'UNKNOWN_MODEL';
}
function isQuotaFailure(error) {
    const code = error?.code;
    if (code === 'QUOTA' || code === 'RATE_LIMIT')
        return true;
    const message = error instanceof Error ? error.message : String(error);
    return /quota|resource.?exhausted|limit reached|exceeded your|rate.?limit|429|too many requests/i.test(message);
}
/**
 * Identity of one model request: its message ids, system digest, model, and
 * purpose. DSH's request-retry layer repeats a failed step with the identical
 * request, which is exactly what this key recognizes.
 * @param options - the request.
 * @param system - its system text.
 * @returns the opaque key.
 */
function reanswerKey(options, system) {
    return `${String(options.purpose ?? '')}|${options.model}|${digest(system)}|${messageIds(options.messages).join(',')}`;
}
/**
 * Stable failure code of an error. Errors raised inside the plugin already
 * carry one; anything else is classified through {@link mapError}, so a plain
 * transport failure is judged by the same wording the transcript would show.
 * @param error - the failure.
 * @returns the code, or undefined when none can be derived.
 */
function failureCode(error) {
    const own = error?.code;
    if (typeof own === 'string' && own.length > 0)
        return own;
    const mapped = mapError(error);
    return typeof mapped.code === 'string' && mapped.code.length > 0 ? mapped.code : undefined;
}
/**
 * Parse a duration such as `41.2s`, `45m`, or `2h3m4s` into milliseconds.
 * @param text - the duration token.
 * @returns the duration, or undefined when the token is not one.
 */
function parseDurationMs(text) {
    const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(text.trim());
    if (match === null)
        return undefined;
    const [, hours, minutes, seconds] = match;
    if (hours === undefined && minutes === undefined && seconds === undefined)
        return undefined;
    const ms = (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
/**
 * Delay upstream asked the caller to wait before retrying, when it stated one
 * in relative terms (`retry in 41.2s`, `reset after 2h3m4s`, `resets in 45m`,
 * `"retryDelay": "41s"`).
 * @param error - the failure.
 * @returns the delay in milliseconds, or undefined when unstated.
 */
function retryAfterMsFromError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const quoted = /"retryDelay"\s*:\s*"([^"]+)"/i.exec(message)?.[1];
    if (quoted !== undefined) {
        const ms = parseDurationMs(quoted);
        if (ms !== undefined)
            return ms;
    }
    const relative = /(?:retry|resets?)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?[hms])+)/i.exec(message)?.[1];
    return relative === undefined ? undefined : parseDurationMs(relative);
}
/**
 * Reset time an error reports, as an ISO timestamp. A stated absolute reset
 * wins; a relative delay is converted to `now + delay`.
 * @param error - the failure.
 * @returns the ISO reset timestamp, or undefined when unstated.
 */
function resetTimeFromError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const absolute = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(message)?.[0];
    if (absolute !== undefined)
        return absolute;
    const delayMs = retryAfterMsFromError(error);
    return delayMs === undefined ? undefined : new Date(Date.now() + delayMs).toISOString();
}
function messageIds(messages) {
    return messages.map(m => m.id ?? '');
}
function turnSettled(turn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return (async () => {
        while ((turn.events.size > 0 || !turn.finished) && Date.now() < deadline) {
            const head = turn.events.peek();
            if (head?.kind === 'done' || head?.kind === 'error')
                return;
            await delay(100);
        }
    })();
}
/**
 * Map transport and agent failures onto stable DSH failure codes.
 * @param error - the failure.
 * @returns an LlmError.
 */
export function mapError(error) {
    if (error instanceof LlmError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JsonRpcClosedError)
        return new LlmError(labeled('TRANSPORT', `Antigravity ACP link closed: ${message}`), 'TRANSPORT', { cause: error });
    if (/authentication required|not logged in|unauthenticated|sign in/i.test(message)) {
        return new LlmError(labeled('AUTH', message), 'AUTH', { cause: error });
    }
    if (/quota|resource.?exhausted|limit reached|exceeded your/i.test(message))
        return new LlmError(labeled('QUOTA', message), 'QUOTA', { cause: error });
    if (/rate.?limit|429|too many requests|overloaded|capacity/i.test(message))
        return new LlmError(labeled('RATE_LIMIT', message), 'RATE_LIMIT', { cause: error });
    if (/context|too long|token limit|maximum.*tokens/i.test(message))
        return new LlmError(labeled('CONTEXT_WINDOW_EXCEEDED', message), 'CONTEXT_WINDOW_EXCEEDED', { cause: error });
    if (/timeout|timed out|deadline/i.test(message))
        return new LlmError(labeled('TIMEOUT', message), 'TIMEOUT', { cause: error });
    if (error instanceof JsonRpcRemoteError)
        return new LlmError(labeled('SERVER', `Antigravity: ${message}`), 'SERVER', { cause: error });
    return new LlmError(labeled('TRANSPORT', message), 'TRANSPORT', { cause: error });
}
