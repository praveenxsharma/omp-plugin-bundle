/**
 * Launch `agy acp` and one-shot CLI commands through Node child_process.
 * Replaces the DeepSeek Harness subprocess service.
 * @module omp-antigravity-acp/spawn
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { AcpChild, AcpSpawner } from './acp-process.ts'
import type { CommandRunner } from './preflight.ts'

const STDERR_CAP = 64 * 1024

/**
 * Spawn an ACP stdio process.
 * @param overlay - extra env merged over `process.env`; `HOME` defaults to the real home.
 */
export function createAcpSpawner(overlay?: Readonly<NodeJS.ProcessEnv>): AcpSpawner {
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: overlay?.HOME ?? homedir(), ...overlay }
  return (argv, cwd, env): AcpChild => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: env === undefined ? baseEnv : { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(stderr.length - STDERR_CAP)
    })
    if (child.stdin === null || child.stdout === null) {
      child.kill()
      throw new Error('antigravity-acp: ACP process has no stdio pipes')
    }
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: string | null }>()
    child.on('exit', (code, signal) => resolve({ code, signal: signal == null ? null : String(signal) }))
    child.on('error', (error: Error) => resolve({ code: null, signal: error.message }))
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      exited: promise,
      terminate: () => {
        child.kill()
      },
      stderrTail: () => stderr,
    }
  }
}

/**
 * Run a one-shot command with a timeout.
 * @param overlay - extra env; always sets `PYTHONUTF8=1`.
 */
export function createCommandRunner(overlay?: Readonly<NodeJS.ProcessEnv>): CommandRunner {
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: overlay?.HOME ?? homedir(), PYTHONUTF8: '1', ...overlay }
  return (argv, timeoutMs, env) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>()
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: homedir(),
      env: env === undefined ? baseEnv : { ...baseEnv, PYTHONUTF8: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr.length > 0 ? stderr : error.message })
    })
    return promise
  }
}
