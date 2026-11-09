/**
 * Account slots: everything one configured account owns at runtime — its
 * sandbox layout, its environment overlay, its preflight facts, and its ACP
 * front. Pool, catalog, and host services stay with the runtime; only state and
 * rules that read the slot alone live here.
 * @module omp-antigravity-acp/slots
 */
import { accountEnv } from "./accounts.js";
/**
 * A fresh, idle slot for one account: its layout, its environment, and empty
 * process/preflight/entitlement state.
 * @param layout - account layout the slot serves.
 * @returns the new slot.
 */
export function newSlot(layout) {
    return {
        layout,
        env: accountEnv(layout),
        preflight: undefined,
        preflightPromise: undefined,
        process: undefined,
        starting: undefined,
        state: 'idle',
        error: undefined,
        readyAt: 0,
        email: undefined,
        subscriptionTier: undefined,
        subscriptionName: undefined,
        availableModels: undefined,
        effortsByModel: undefined,
        maxTokensByModel: undefined,
        disabledModels: undefined,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
}
/**
 * Repoint an existing slot at a re-resolved layout (its home, sandbox, and
 * environment), keeping the state that belongs to the account itself.
 * @param slot - slot to update in place.
 * @param layout - freshly resolved layout for the same account id.
 * @returns true when the environment overlay changed, so the caller can restart
 * a running ACP front that would otherwise keep the old one.
 */
export function rebaseSlot(slot, layout) {
    slot.layout = layout;
    const nextEnv = accountEnv(layout);
    const envChanged = JSON.stringify(slot.env) !== JSON.stringify(nextEnv);
    slot.env = nextEnv;
    return envChanged;
}
/**
 * Whether upstream marked one model disabled on an account. Argon is listed by
 * family name (`gemini-4-argon`), so one Argon entry covers every Argon variant
 * of that account.
 * @param slot - account slot.
 * @param model - model asked about.
 * @returns true when the account's own report disables the model.
 */
export function slotDisablesModel(slot, model) {
    return slot.disabledModels?.some(entry => entry === model || (/argon/i.test(entry) && /argon/i.test(model))) === true;
}
/**
 * Whether one account's own report rules out a model: upstream marked it
 * disabled, or the account announced a catalogue that lacks it.
 * @param slot - account slot.
 * @param model - model asked about.
 * @returns true when the account positively cannot serve the model.
 */
export function slotDeniesModel(slot, model) {
    if (slotDisablesModel(slot, model))
        return true;
    const listed = slot.availableModels;
    if (listed === undefined || listed.length === 0)
        return false;
    return !listed.some(entry => entry.id === model);
}
