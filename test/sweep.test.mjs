/**
 * End-to-end sweep check on a throwaway `$DSH_HOME` / `$DSH_TUI_HOME`.
 *
 * The unit test above proves the plugin contract; this one proves the disk
 * side: a real sweep removes the projection cache, prunes every index, keeps
 * the ids it was not asked about, backs each changed file up once, and leaves
 * an unparsable file strictly alone.
 *
 * Run with `node --test test/sweep.test.mjs`.
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import { sweepSessions } from '../sweep.js'

const TARGET = 'ses_target-0001'
const KEEP = 'ses_keep-0002'

/** Build a fake harness home pair and return the paths plus a cleanup. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-manager-sweep-'))
  const dsh = join(root, '.dsh')
  const tui = join(root, '.dsh-tui')
  const cacheDir = join(dsh, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(tui, { recursive: true })

  const write = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')

  write(join(cacheDir, `${TARGET}.json`), { cached: true })
  write(join(cacheDir, `${KEEP}.json`), { cached: true })

  const workspacePath = join(dsh, 'storages', 'workspace.json')
  write(workspacePath, {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, archivedSessionIds: [TARGET, KEEP] },
    tables: {
      workspaces: {
        ws1: { path: '/tmp', title: 'tmp', sessionIds: [TARGET, KEEP] },
      },
    },
  })

  const indexPath = join(tui, 'session-index.json')
  write(indexPath, { version: 3, entries: { [TARGET]: { derived: {} }, [KEEP]: { derived: {} } } })

  const mountsPath = join(tui, 'session-mounts.json')
  write(mountsPath, { version: 1, owners: [{ pid: 1, sessionIds: [TARGET, KEEP] }] })

  const lastUsedPath = join(tui, 'last-used.json')
  write(lastUsedPath, { [TARGET]: 1, [KEEP]: 2 })

  const agentViewPath = join(tui, 'agent-view-sessions.json')
  write(agentViewPath, { [TARGET]: 1, [KEEP]: 2 })

  const brokenPath = join(tui, 'broken.json')
  writeFileSync(brokenPath, '{ this is not json', 'utf8')

  return {
    dsh,
    tui,
    paths: { cacheDir, workspacePath, indexPath, mountsPath, lastUsedPath, agentViewPath, brokenPath },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a sweep clears the leftovers and keeps every other id', () => {
  const fx = fixture()
  const previous = { dsh: process.env.DSH_HOME, tui: process.env.DSH_TUI_HOME }
  process.env.DSH_HOME = fx.dsh
  process.env.DSH_TUI_HOME = fx.tui
  try {
    const result = sweepSessions([TARGET], { backup: true })

    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.errors, [])

    // 1. The projection cache for the deleted session is gone, the other stays.
    assert.equal(existsSync(join(fx.paths.cacheDir, `${TARGET}.json`)), false)
    assert.equal(existsSync(join(fx.paths.cacheDir, `${KEEP}.json`)), true)

    // 2. Every index dropped the target and kept the untouched id.
    const workspace = JSON.parse(readFileSync(fx.paths.workspacePath, 'utf8'))
    assert.deepEqual(workspace.tables.workspaces.ws1.sessionIds, [KEEP])
    assert.deepEqual(workspace.global.archivedSessionIds, [KEEP])

    const index = JSON.parse(readFileSync(fx.paths.indexPath, 'utf8'))
    assert.deepEqual(Object.keys(index.entries), [KEEP])
    assert.equal(index.version, 3, 'untouched fields survive the prune')

    const mounts = JSON.parse(readFileSync(fx.paths.mountsPath, 'utf8'))
    assert.deepEqual(mounts.owners[0].sessionIds, [KEEP])

    assert.deepEqual(Object.keys(JSON.parse(readFileSync(fx.paths.lastUsedPath, 'utf8'))), [KEEP])
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(fx.paths.agentViewPath, 'utf8'))), [KEEP])

    // 3. Each changed file kept exactly one backup.
    for (const path of [fx.paths.workspacePath, fx.paths.indexPath, fx.paths.mountsPath]) {
      const stamp = backupStampOf(path)
      assert.notEqual(stamp, '', `expected a backup stamp beside ${path}`)
      assert.equal(existsSync(`${path}.bak-sweep-${stamp}`), true, `expected one backup beside ${path}`)
    }

    // 4. An unparsable file is reported, never rewritten.
    assert.equal(readFileSync(fx.paths.brokenPath, 'utf8'), '{ this is not json')
    assert.match(result.summary, /1 id/)
  } finally {
    if (previous.dsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.dsh
    if (previous.tui === undefined) delete process.env.DSH_TUI_HOME
    else process.env.DSH_TUI_HOME = previous.tui
    fx.cleanup()
  }
})

test('a dry run reports the same targets without writing anything', () => {
  const fx = fixture()
  const previous = { dsh: process.env.DSH_HOME, tui: process.env.DSH_TUI_HOME }
  process.env.DSH_HOME = fx.dsh
  process.env.DSH_TUI_HOME = fx.tui
  try {
    const before = readFileSync(fx.paths.workspacePath, 'utf8')
    const result = sweepSessions([TARGET], { dryRun: true })

    assert.ok(result.removed.length >= 1, 'the cache file is reported as removable')
    assert.ok(result.pruned.length >= 1, 'the index is reported as prunable')
    assert.equal(readFileSync(fx.paths.workspacePath, 'utf8'), before)
    assert.equal(existsSync(join(fx.paths.cacheDir, `${TARGET}.json`)), true)
    assert.match(result.summary, /dry run/)
  } finally {
    if (previous.dsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.dsh
    if (previous.tui === undefined) delete process.env.DSH_TUI_HOME
    else process.env.DSH_TUI_HOME = previous.tui
    fx.cleanup()
  }
})

/** The `.bak-sweep-<stamp>` sibling of a path: the stamp it used, or ''. */
function backupStampOf(path) {
  const dir = dirname(path)
  const base = basename(path)
  const hit = readdirSync(dir).find((name) => name.startsWith(`${base}.bak-sweep-`))
  return hit === undefined ? '' : (/\.bak-sweep-(\d{8}-\d{6})$/.exec(hit)?.[1] ?? '')
}
