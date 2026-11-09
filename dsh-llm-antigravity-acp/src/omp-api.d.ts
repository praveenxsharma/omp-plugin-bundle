/**
 * Minimal ambient types so this plugin typechecks without a local OMP checkout.
 * Runtime loads the real `@oh-my-pi/*` packages from the omp process.
 */

declare module '@oh-my-pi/pi-ai' {
  export class AssistantMessageEventStream {
    push(event: unknown): void
    end(result?: unknown): void
    fail(err: unknown): void
  }
}

declare module '@oh-my-pi/pi-coding-agent' {
  export interface ExtensionAPI {
    registerProvider(name: string, config: Record<string, unknown>): void
    registerCommand(name: string, config: Record<string, unknown>): void
    on(event: string, handler: (...args: unknown[]) => unknown): void
    logger: { info(message: string): void; warn(message: string): void }
  }
}
