/**
 * Small async primitives shared by the adapter: deferred values, an
 * unbounded event queue with abortable waits, and a keyed mutex.
 * @module omp-antigravity-acp/util
 */
import { createHash } from 'node:crypto';
/**
 * Create a deferred value.
 * @returns the deferred handle.
 */
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // A rejection nobody awaits is expected when a parked call is abandoned.
    promise.catch(() => undefined);
    const handle = {
        promise,
        settled: false,
        resolve: (value) => { if (!handle.settled) {
            handle.settled = true;
            resolve(value);
        } },
        reject: (error) => { if (!handle.settled) {
            handle.settled = true;
            reject(error);
        } },
    };
    return handle;
}
/** Unbounded FIFO with one consumer that can wait with a deadline or abort signal. */
export class AsyncQueue {
    items = [];
    waiter;
    /**
     * Append one item.
     * @param item - the queued value.
     */
    push(item) {
        this.items.push(item);
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }
    /** Number of queued items. */
    get size() {
        return this.items.length;
    }
    /**
     * Inspect the head without removing it.
     * @returns the head item.
     */
    peek() {
        return this.items[0];
    }
    /**
     * Remove the head item.
     * @returns the head item.
     */
    shift() {
        return this.items.shift();
    }
    /**
     * Wait until an item is available.
     * @param signal - aborts the wait.
     * @param timeoutMs - resolve false after this delay.
     * @returns whether an item is available.
     */
    async wait(signal, timeoutMs) {
        if (this.items.length > 0)
            return true;
        if (signal?.aborted === true)
            return false;
        return new Promise((resolve) => {
            let timer;
            const finish = (value) => {
                if (timer !== undefined)
                    clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                if (this.waiter === wake)
                    this.waiter = undefined;
                resolve(value);
            };
            const wake = () => finish(true);
            const onAbort = () => finish(false);
            this.waiter = wake;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (timeoutMs !== undefined)
                timer = setTimeout(() => finish(this.items.length > 0), timeoutMs);
        });
    }
}
/** Serializes async sections per key. */
export class KeyedMutex {
    tails = new Map();
    /**
     * Acquire the lock for one key.
     * @param key - lock key.
     * @returns the release function.
     */
    async acquire(key) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        return () => {
            release();
            if (this.tails.get(key) === tail)
                this.tails.delete(key);
        };
    }
}
/**
 * Stable short digest of a JSON-serializable value.
 * @param value - hashed value.
 * @returns hex digest prefix.
 */
export function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
/**
 * Sleep for a duration.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
