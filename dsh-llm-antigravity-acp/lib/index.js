/**
 * Antigravity ACP provider for OMP.
 *
 * The extension drives the locally installed, signed-in official CLI through
 * its Agent Client Protocol server (`agy acp`). OMP owns tools, permissions,
 * compaction, and subagents. Requests never leave the official `agy` process
 * for Google's Cloud Code Assist HTTP API.
 *
 * OMP loads `./lib/extension.js` via `package.json#omp.extensions`. This
 * barrel does not import that graph so runtime tests stay free of `@oh-my-pi/*`.
 * @module omp-antigravity-acp
 */
export { Config } from "./config.js";
export { liveAccounts, name, inject, writeMigrationBack } from "./boot.js";
export { AntigravityAdapter } from "./adapter.js";
export { AntigravityRuntime } from "./runtime.js";
