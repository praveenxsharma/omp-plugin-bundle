/**
 * Route health of one conversation: the shadow-degradation fingerprint that
 * decides whether a degraded Argon answer is refused and re-asked, the per-turn
 * marks it accumulates, and the numbers the quota pill reads. Everything lives
 * in one object so a reset is a single replacement instead of a field-by-field
 * sweep.
 * @module omp-antigravity-acp/route-health
 */
import { evaluateDegradeFingerprint, } from "./usage-db.js";
/** Route-health state and the evaluations that advance it. */
export class RouteHealth {
    main;
    hasHealthyArgonCache = false;
    consecutiveDegradedTurns = 0;
    consecutiveBlockAlignedCache = 0;
    /** Degraded answers refused and re-asked; the quota pill shows this count as automatic re-answers. */
    interceptedSteps = 0;
    prevCacheRead = undefined;
    prevTotalInput = undefined;
    lastContextTokens = 0;
    degradeState = undefined;
    /** Last refused verdict, kept after the live state clears so a healed route still shows what was refused. */
    lastInterceptedState = undefined;
    turnDegradeHit = undefined;
    turnEvaluatedSteps = 0;
    turnSawExactPrefixCache = false;
    /**
     * @param main - whether this is the DSH session's main conversation, the only
     * one whose live degradation state is published.
     */
    constructor(main) {
        this.main = main;
    }
    /**
     * Clear the per-turn marks at the start of one ACP turn; session-wide rolling
     * state survives.
     */
    beginTurn() {
        this.turnDegradeHit = undefined;
        this.turnEvaluatedSteps = 0;
        this.turnSawExactPrefixCache = false;
    }
    /**
     * A fresh object with the same `main` flag.
     * @param options - fields carried over instead of cleared; callers that keep
     * a process's history of refused answers pass them here.
     * @returns the replacement state.
     */
    reset(options = {}) {
        const next = new RouteHealth(this.main);
        if (options.keep?.includes('interceptedSteps') === true)
            next.interceptedSteps = this.interceptedSteps;
        if (options.keep?.includes('lastInterceptedState') === true)
            next.lastInterceptedState = this.lastInterceptedState;
        return next;
    }
    /**
     * Evaluate one model step and fold its verdict into the rolling state.
     * @param input - the step and how it should be recorded.
     * @returns the verdict, evaluated or not.
     */
    observeEvaluatedStep(input) {
        const verdict = evaluateDegradeFingerprint({
            model: input.model,
            effort: input.effort,
            step: input.step,
            ...(input.cwmEstTokens !== undefined ? { cwmEstTokens: input.cwmEstTokens } : {}),
            isToolStep: input.isToolStep,
            ...(this.prevCacheRead !== undefined ? { prevCacheRead: this.prevCacheRead } : {}),
            ...(this.prevTotalInput !== undefined ? { prevTotalInput: this.prevTotalInput } : {}),
            priorBlockAlignedCount: this.consecutiveBlockAlignedCache,
        });
        if (!verdict.evaluated)
            return verdict;
        if (verdict.contextTokens > 0)
            this.lastContextTokens = verdict.contextTokens;
        this.prevCacheRead = input.step.cachedReadTokens;
        this.prevTotalInput = verdict.contextTokens;
        this.turnEvaluatedSteps += 1;
        this.consecutiveBlockAlignedCache = verdict.blockAlignedCache ? this.consecutiveBlockAlignedCache + 1 : 0;
        if (verdict.degraded) {
            if (input.recordUninterceptedHit) {
                if (this.turnDegradeHit === undefined || verdict.score >= this.turnDegradeHit.score) {
                    this.turnDegradeHit = verdict;
                }
                if (this.main) {
                    this.degradeState = { verdict: this.turnDegradeHit, model: input.model, updatedAt: new Date().toISOString() };
                }
            }
        }
        else {
            if (verdict.exactPrefixCache) {
                this.turnSawExactPrefixCache = true;
                this.hasHealthyArgonCache = true;
            }
            if (this.main && this.turnDegradeHit === undefined) {
                this.degradeState = undefined;
            }
        }
        return verdict;
    }
    /**
     * Fold one decoded `gen_metadata` batch into the rolling state. The batch is the
     * merged read that also reports the step's usage, so one generation is judged once.
     * @param model - model that produced the batch.
     * @param effort - resolved reasoning effort.
     * @param genBatch - decoded batch of billed rows.
     * @param isToolStep - whether the turn is attempting a tool call.
     * @param isInterceptable - whether the batch's last record could still be refused.
     * @returns the verdict of the batch's last record, when any.
     */
    observeGenBatchHealth(model, effort, genBatch, isToolStep, isInterceptable = isToolStep) {
        let latest;
        for (const [idx, rec] of genBatch.steps.entries()) {
            const isLast = idx === genBatch.steps.length - 1;
            latest = this.observeEvaluatedStep({
                model,
                effort,
                step: rec,
                cwmEstTokens: rec.cwmEstTokens,
                isToolStep: isLast && isToolStep,
                recordUninterceptedHit: !(isLast && isInterceptable),
            });
        }
        return latest;
    }
    /**
     * Fold `steps`-table rows into the rolling state, for the sessions an old `agy`
     * keeps without `gen_metadata`, and for the tail steps a new `agy` never billed.
     * @param model - model that produced the batch.
     * @param effort - resolved reasoning effort.
     * @param batch - decoded batch.
     */
    observeStepBatchHealth(model, effort, batch) {
        for (const step of batch.steps) {
            this.observeEvaluatedStep({ model, effort, step, cwmEstTokens: undefined, isToolStep: false, recordUninterceptedHit: true });
        }
    }
    /**
     * Settle one finished turn: a turn with no degraded hit clears the live state
     * and the turn streak, any hit promotes it.
     * @param model - model that served the turn.
     */
    finalizeTurnHealth(model) {
        if (!this.main)
            return;
        if (!/argon/i.test(model)) {
            this.degradeState = undefined;
            return;
        }
        if (this.turnEvaluatedSteps === 0)
            return;
        if (this.turnDegradeHit !== undefined) {
            this.consecutiveDegradedTurns += 1;
            this.degradeState = { verdict: this.turnDegradeHit, model, updatedAt: new Date().toISOString() };
            return;
        }
        this.consecutiveDegradedTurns = 0;
        if (this.turnSawExactPrefixCache)
            this.hasHealthyArgonCache = true;
        this.degradeState = undefined;
    }
    /**
     * Record a degraded attempt the plugin refuses to deliver, keeping the
     * refused verdict after the live state clears.
     * @param verdict - the degraded fingerprint.
     * @param model - model that produced it.
     */
    noteDegradedAttempt(verdict, model) {
        const nowIso = new Date().toISOString();
        this.lastInterceptedState = { verdict, model, updatedAt: nowIso };
        this.degradeState = { verdict, model, updatedAt: nowIso };
    }
    /**
     * Health numbers to publish, preferring the live state and falling back to
     * the last refused verdict while the route counts as healed.
     * @returns the snapshot, or undefined when this conversation has no verdict.
     */
    snapshot() {
        const active = this.degradeState;
        const healed = active === undefined && this.interceptedSteps > 0 ? this.lastInterceptedState : undefined;
        const state = active ?? healed;
        if (state === undefined)
            return undefined;
        const degraded = active !== undefined && state.verdict.degraded;
        return {
            model: state.model,
            degraded,
            score: degraded ? state.verdict.score : 0,
            signals: state.verdict.signals.map(s => ({ ...s })),
            streamTps: state.verdict.streamTps,
            wallTps: state.verdict.wallTps,
            ttftSeconds: state.verdict.ttftSeconds,
            thoughtTokens: state.verdict.thoughtTokens,
            contextTokens: this.lastContextTokens > 0 ? this.lastContextTokens : state.verdict.contextTokens,
            consecutiveDegradedTurns: this.consecutiveDegradedTurns,
            interceptedSteps: this.interceptedSteps,
            hasHealthyArgonCache: this.hasHealthyArgonCache,
            updatedAt: state.updatedAt,
        };
    }
}
