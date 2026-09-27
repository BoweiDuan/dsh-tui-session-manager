/**
 * Tiny append-only diagnostic log for the plugin.
 *
 * dsh-TUI's own plugin surface is hard to observe from outside the running
 * TUI: a scene registration shows up in the effect ledger, but a plain
 * `ctx.commands.register()` registration does not (only the mediated path
 * records `create command …`). This log closes that gap: it records what the
 * plugin actually did at each host boundary, so a "the command is missing"
 * report can be answered with facts from the live process.
 *
 * Rules: never throw, never grow without bound (64 KiB cap, then reset), and
 * never slow the caller meaningfully — this is a debugging aid, not a
 * feature of the plugin.
 *
 * @module dsh-tui-session-manager/debug
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Rotate the log once it exceeds this many bytes. */
const MAX_BYTES = 64 * 1024

/** Resolve `$DSH_TUI_HOME` the same way the rest of the plugin does. */
function logPath() {
  const raw = process.env.DSH_TUI_HOME?.trim()
  const dir = raw && raw.length > 0 ? raw : join(homedir(), '.dsh-tui')
  return join(dir, 'session-manager.log')
}

/**
 * Append one diagnostic line.
 *
 * @param {string} message - Line to record.
 * @returns {void}
 */
export function log(message) {
  try {
    const file = logPath()
    mkdirSync(join(file, '..'), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) writeFileSync(file, '')
    } catch {
      // Missing file: nothing to rotate.
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Diagnostics must never break the plugin.
  }
}

/** Render any thrown value as one line. */
export function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
