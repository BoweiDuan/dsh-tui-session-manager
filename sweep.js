/**
 * Leftover sweep for deleted sessions.
 *
 * The host's `channel.deleteSession(id)` removes the session's log directory
 * and drops the id from the TUI's own `last-used` / agent-view maps plus the
 * resume marker. Four more places keep the same id and are *not* touched
 * there, which is what leaves ghost rows behind after a delete:
 *
 * 1. `$DSH_HOME/storages/session_projcache/sessions/<id>.json` — the DSH
 *    projection cache for the session.
 * 2. `$DSH_HOME/storages/workspace.json` — `tables.workspaces[*].sessionIds`
 *    and `global.archivedSessionIds`.
 * 3. `$DSH_TUI_HOME/session-index.json` — `entries[id]`, the TUI's own title
 *    cache rebuilt from logs.
 * 4. `$DSH_TUI_HOME/session-mounts.json` — `owners[*].sessionIds`.
 *
 * `last-used.json` and `agent-view-sessions.json` are swept too: the host
 * clears them, and repeating it is idempotent — a cheap hedge against the
 * host's own behaviour changing between dsh-TUI releases.
 *
 * Safety rules, all of them deliberate:
 * - An id must match {@link SAFE_ID} before it is used as a filename or a map
 *   key; anything else is reported as skipped, never acted on.
 * - Every JSON file is backed up once per sweep (`<file>.bak-sweep-<stamp>`)
 *   before its first write.
 * - A file that cannot be parsed is left exactly as it is: a corrupt state
 *   file is not this module's to guess about.
 * - Nothing throws: the result object carries per-step errors so a partly
 *   successful sweep still reports what it did.
 *
 * @module dsh-tui-session-manager/sweep
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Ids usable as a path segment and as a JSON map key (both id shapes). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** `$DSH_HOME`, defaulting to `~/.dsh` like the harness itself. */
function dshHome() {
  const raw = process.env.DSH_HOME?.trim()
  return raw && raw.length > 0 ? raw : join(homedir(), '.dsh')
}

/** `$DSH_TUI_HOME`, defaulting to `~/.dsh-tui` like dsh-TUI itself. */
function tuiHome() {
  const raw = process.env.DSH_TUI_HOME?.trim()
  return raw && raw.length > 0 ? raw : join(homedir(), '.dsh-tui')
}

/** Timestamp stamp for backup names, `YYYYMMDD-HHMMSS`. */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Read one JSON file; `undefined` when absent or unparsable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write one JSON file atomically, after backing the previous content up once. */
function writeJson(path, value, backupPath, backup) {
  if (backup && backupPath !== undefined && !existsSync(backupPath)) {
    renameSync(path, backupPath)
  }
  const tmp = `${path}.tmp-sweep-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Drop a session id from one `{id: value}` map in place; true when changed. */
function pruneIdMap(data, ids) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  let changed = false
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(data, id)) {
      delete data[id]
      changed = true
    }
  }
  return changed
}

/** Drop session ids from `workspace.json`'s tables and archived list. */
function pruneWorkspace(data, ids) {
  const set = new Set(ids)
  let changed = false
  const workspaces = data?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const workspace of Object.values(workspaces)) {
      const list = workspace?.sessionIds
      if (!Array.isArray(list)) continue
      const next = list.filter((id) => !set.has(id))
      if (next.length !== list.length) {
        workspace.sessionIds = next
        changed = true
      }
    }
  }
  const archived = data?.global?.archivedSessionIds
  if (Array.isArray(archived)) {
    const next = archived.filter((id) => !set.has(id))
    if (next.length !== archived.length) {
      data.global.archivedSessionIds = next
      changed = true
    }
  }
  return changed
}

/** Drop session ids from `session-mounts.json`'s per-owner lists. */
function pruneMounts(data, ids) {
  const set = new Set(ids)
  let changed = false
  const owners = data?.owners
  if (!Array.isArray(owners)) return false
  for (const owner of owners) {
    const list = owner?.sessionIds
    if (!Array.isArray(list)) continue
    const next = list.filter((id) => !set.has(id))
    if (next.length !== list.length) {
      owner.sessionIds = next
      changed = true
    }
  }
  return changed
}

/**
 * Sweep every leftover reference to the given session ids.
 *
 * @param {readonly string[]} sessionIds - Ids the host already deleted.
 * @param {{ backup?: boolean, dryRun?: boolean }} [options] - `backup`
 *   (default true) writes `<file>.bak-sweep-<stamp>` before the first change
 *   to a file; `dryRun` reports what would change without touching disk.
 * @returns {{
 *   removed: readonly string[],
 *   pruned: readonly string[],
 *   skipped: readonly string[],
 *   errors: readonly string[],
 *   summary: string,
 * }} A human-readable outcome plus the per-category facts behind it.
 */
export function sweepSessions(sessionIds, options = {}) {
  const backup = options.backup !== false
  const dryRun = options.dryRun === true

  const accepted = []
  const skipped = []
  for (const id of sessionIds ?? []) {
    if (typeof id === 'string' && SAFE_ID.test(id)) accepted.push(id)
    else skipped.push(String(id))
  }

  const removed = []
  const pruned = []
  const errors = []
  if (accepted.length === 0) {
    return { removed, pruned, skipped, errors, summary: 'nothing to sweep' }
  }

  const backupStamp = stamp()

  // 1. Projection-cache files: one per session, keyed by id.
  if (!dryRun) {
    const cacheDir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
    for (const id of accepted) {
      const file = join(cacheDir, `${id}.json`)
      try {
        if (!existsSync(file)) continue
        rmSync(file, { force: true })
        removed.push(`projcache/${id}.json`)
      } catch (error) {
        errors.push(`projcache/${id}.json: ${errorText(error)}`)
      }
    }
  } else {
    const cacheDir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
    for (const id of accepted) {
      if (existsSync(join(cacheDir, `${id}.json`))) removed.push(`projcache/${id}.json`)
    }
  }

  // 2. Shared JSON state files: prune the id out of each, writing only when
  //    something actually changed.
  const targets = [
    {
      label: 'storages/workspace.json',
      path: join(dshHome(), 'storages', 'workspace.json'),
      prune: pruneWorkspace,
    },
    {
      label: 'session-index.json',
      path: join(tuiHome(), 'session-index.json'),
      prune: (data, ids) => pruneIdMap(data?.entries, ids),
    },
    {
      label: 'session-mounts.json',
      path: join(tuiHome(), 'session-mounts.json'),
      prune: pruneMounts,
    },
    {
      label: 'last-used.json',
      path: join(tuiHome(), 'last-used.json'),
      prune: pruneIdMap,
    },
    {
      label: 'agent-view-sessions.json',
      path: join(tuiHome(), 'agent-view-sessions.json'),
      prune: pruneIdMap,
    },
  ]

  for (const target of targets) {
    if (!existsSync(target.path)) continue
    const data = readJson(target.path)
    if (data === undefined) {
      errors.push(`${target.label}: unreadable JSON, left untouched`)
      continue
    }
    let changed = false
    try {
      changed = target.prune(data, accepted) === true
    } catch (error) {
      errors.push(`${target.label}: ${errorText(error)}`)
      continue
    }
    if (!changed) continue
    if (dryRun) {
      pruned.push(target.label)
      continue
    }
    try {
      writeJson(target.path, data, `${target.path}.bak-sweep-${backupStamp}`, backup)
      pruned.push(target.label)
    } catch (error) {
      errors.push(`${target.label}: ${errorText(error)}`)
    }
  }

  const parts = []
  parts.push(`${accepted.length} id${accepted.length === 1 ? '' : 's'}`)
  if (removed.length > 0) parts.push(`${removed.length} cache file${removed.length === 1 ? '' : 's'}`)
  if (pruned.length > 0) parts.push(`${pruned.length} index${pruned.length === 1 ? '' : 'es'} pruned`)
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
  if (errors.length > 0) parts.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`)
  if (dryRun) parts.push('(dry run)')

  return { removed, pruned, skipped, errors, summary: parts.join(', ') }
}

/** Error to one log line. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
