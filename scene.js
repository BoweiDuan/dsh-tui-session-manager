/**
 * The `/sessions` full-screen scene.
 *
 * The scene is a host-rendered React component: it receives the TUI's own
 * React and ui kit through `props`, because a plugin-owned React copy would
 * break element identity and hooks (the host reconciler accepts only its own
 * React 19 elements). It therefore owns no imports beyond this package and
 * Node built-ins.
 *
 * What it does: lists every stored session through `channel.listSessions()`,
 * groups them by working directory, filters by title/cwd/id, and deletes the
 * selected ones through the host's own `channel.deleteSession(id)` — the same
 * call the `/resume` picker would use, which is why the live session is
 * refused by the host rather than by this UI. After a successful host delete
 * the leftover references are swept by {@link sweepSessions}.
 *
 * Keymap: `↑↓`/`jk` move, `space`/`x`/`enter` toggle, `a` select all,
 * `d` delete selected, `/` filter, `esc` close (or leave the current mode).
 *
 * @module dsh-tui-session-manager/scene
 */

import { log } from './debug.js'
import { sweepSessions } from './sweep.js'

/** Home prefix, so long working directories read as `~/…`. */
const HOME = process.env.HOME ?? ''

/** Rows the chrome (header, blank, footer) takes from the list. */
const CHROME_ROWS = 6

/** How many report lines the done state shows at once. */
const REPORT_ROWS = 4

/**
 * Build the scene component.
 *
 * @param {{ sweep?: boolean, backup?: boolean }} [options] - `sweep` (default
 *   true) also clears the state-file leftovers after a successful host
 *   delete; `backup` (default true) backs each state file up before the first
 *   write of a sweep.
 * @returns {import('react').ComponentType<unknown>} The scene component.
 */
export function createSessionManagerScene(options = {}) {
  const sweepEnabled = options.sweep !== false
  const sweepBackup = options.backup !== false

  return function SessionManagerScene(props) {
    const { React, ui, channel, close } = props
    const { Box, Text, useInput, useTerminalSize } = ui
    const h = React.createElement
    const { columns, rows } = useTerminalSize()

    /** `undefined` while loading, then the host's session summaries. */
    const [sessions, setSessions] = React.useState(undefined)
    const [loadError, setLoadError] = React.useState(undefined)
    const [cursor, setCursor] = React.useState(0)
    const [selected, setSelected] = React.useState(() => new Set())
    const [query, setQuery] = React.useState('')
    const [searchMode, setSearchMode] = React.useState(false)
    /** browse → confirm → busy → done → browse */
    const [phase, setPhase] = React.useState('browse')
    const [report, setReport] = React.useState([])

    React.useEffect(() => {
      let alive = true
      log('scene: component mounted, loading sessions')
      Promise.resolve()
        .then(() => channel.listSessions())
        .then((list) => {
          if (alive) setSessions(Array.isArray(list) ? [...list] : [])
        })
        .catch((error) => {
          if (!alive) return
          setSessions([])
          setLoadError(errorText(error))
        })
      return () => {
        alive = false
      }
    }, [channel])

    // ── projection ─────────────────────────────────────────────────────────
    const all = sessions ?? []
    const needle = query.trim().toLowerCase()
    const filtered = needle.length === 0 ? all : all.filter((session) => matches(session, needle))
    const groups = groupByWorkspace(filtered)
    /** Filtered sessions in render order: the cursor indexes into this. */
    const flat = []
    for (const group of groups) for (const session of group.list) flat.push(session)
    const safeCursor = flat.length === 0 ? 0 : Math.min(cursor, flat.length - 1)
    const current = flat[safeCursor]
    const selectedCount = selected.size

    const toggle = (id) => {
      if (id === undefined) return
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const toggleAll = () => {
      setSelected((prev) => (prev.size === flat.length ? new Set() : new Set(flat.map((s) => s.id))))
    }

    /**
     * Delete every selected session: host delete first, sweep second.
     * A host refusal (live session, missing log) is reported, not retried.
     */
    const runDelete = async () => {
      const ids = flat.filter((session) => selected.has(session.id)).map((session) => session.id)
      if (ids.length === 0) return
      log(`scene: delete requested for ${ids.length} session(s): ${ids.join(', ')}`)
      setPhase('busy')
      const lines = []
      const deleted = []
      for (const id of ids) {
        let ok = false
        try {
          ok = (await channel.deleteSession(id)) === true
        } catch (error) {
          log(`scene: deleteSession(${id}) threw — ${errorText(error)}`)
          lines.push(`✗ ${shortId(id)}: ${errorText(error)}`)
          continue
        }
        if (!ok) {
          log(`scene: deleteSession(${id}) returned false (refused by host)`)
          lines.push(`✗ ${shortId(id)}: refused by host (live session or missing log)`)
          continue
        }
        deleted.push(id)
        log(`scene: deleteSession(${id}) → true`)
        if (!sweepEnabled) continue
        try {
          const swept = sweepSessions([id], { backup: sweepBackup })
          log(`scene: sweep ${id} — ${swept.summary}${swept.errors.length > 0 ? ` | errors: ${swept.errors.join('; ')}` : ''}`)
          if (swept.errors.length > 0) {
            lines.push(`! ${shortId(id)}: swept with errors — ${swept.errors.join('; ')}`)
          }
        } catch (error) {
          log(`scene: sweep ${id} threw — ${errorText(error)}`)
          lines.push(`! ${shortId(id)}: sweep failed — ${errorText(error)}`)
        }
      }
      if (deleted.length > 0) {
        const done = new Set(deleted)
        setSessions((prev) => (prev ?? []).filter((session) => !done.has(session.id)))
        setSelected(new Set())
      }
      const refused = ids.length - deleted.length
      lines.unshift(
        `deleted ${deleted.length}${refused > 0 ? `, refused ${refused}` : ''}` +
          (sweepEnabled && deleted.length > 0 ? ' (leftovers swept)' : ''),
      )
      setReport(lines)
      setPhase('done')
    }

    // ── input ──────────────────────────────────────────────────────────────
    useInput((input, key) => {
      if (phase === 'busy') return

      if (phase === 'confirm') {
        if (input === 'y' || input === 'Y') void runDelete()
        else if (input === 'n' || input === 'N' || key.escape) setPhase('browse')
        return
      }

      if (phase === 'done') {
        setPhase('browse')
        setReport([])
        return
      }

      if (searchMode) {
        if (key.escape || key.return) setSearchMode(false)
        else if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1))
        else if (input.length > 0 && !key.ctrl && !key.meta) setQuery((value) => value + input)
        return
      }

      if (key.escape) {
        close()
        return
      }
      if (key.upArrow || input === 'k') setCursor((value) => Math.max(0, value - 1))
      else if (key.downArrow || input === 'j') setCursor((value) => Math.min(flat.length - 1, value + 1))
      else if (input === ' ' || input === 'x' || key.return) toggle(current?.id)
      else if (input === 'a') toggleAll()
      else if (input === 'd' && selectedCount > 0) setPhase('confirm')
      else if (input === '/') setSearchMode(true)
    })

    // ── layout ─────────────────────────────────────────────────────────────
    const listRows = Math.max(3, rows - CHROME_ROWS)
    const display = []
    let cursorRow = 0
    for (const group of groups) {
      display.push({ kind: 'group', key: `group:${group.cwd}`, label: groupLabel(group) })
      for (const session of group.list) {
        if (session === current) cursorRow = display.length
        display.push({ kind: 'session', key: session.id, session, isCursor: session === current })
      }
    }
    const maxStart = Math.max(0, display.length - listRows)
    const start = Math.max(0, Math.min(cursorRow - Math.floor(listRows / 2), maxStart))
    const windowRows = display.slice(start, start + listRows)

    const lines = windowRows.map((row) => {
      if (row.kind === 'group') {
        return h(
          Text,
          { key: row.key, color: 'subtle', bold: true },
          `── ${row.label}`,
        )
      }
      const session = row.session
      const mark = selected.has(session.id) ? '[x]' : '[ ]'
      const pointer = row.isCursor ? '❯' : ' '
      const title = truncate(session.title?.text ?? '(untitled)', Math.max(12, columns - 34))
      const tags = []
      if (session.kind === 'subagent') tags.push('sub')
      if (session.hasPrompt === false) tags.push('empty')
      const meta = `${tags.length > 0 ? `${tags.join(' ')} · ` : ''}${formatAge(session.updatedAt)}`
      return h(
        Box,
        { key: row.key, flexDirection: 'row', justifyContent: 'space-between' },
        h(
          Text,
          {
            color: row.isCursor ? 'accent' : selected.has(session.id) ? 'success' : 'text',
            bold: row.isCursor,
            wrap: 'truncate',
          },
          `${pointer} ${mark} ${title}`,
        ),
        h(Text, { color: 'subtle' }, meta),
      )
    })

    const body = []
    if (sessions === undefined) {
      body.push(h(Text, { key: 'loading', color: 'subtle' }, 'loading sessions…'))
    } else if (loadError !== undefined) {
      body.push(h(Text, { key: 'error', color: 'error' }, `failed to list sessions: ${loadError}`))
    } else if (display.length === 0) {
      body.push(
        h(
          Text,
          { key: 'empty', color: 'subtle' },
          all.length === 0 ? 'no stored sessions' : `no session matches "${query}"`,
        ),
      )
    } else {
      body.push(...lines)
    }

    const footer = []
    if (phase === 'confirm') {
      footer.push(
        h(
          Text,
          { key: 'confirm', color: 'warning', bold: true },
          `Delete ${selectedCount} session${selectedCount === 1 ? '' : 's'}? y = delete · n = cancel`,
        ),
      )
    } else if (phase === 'busy') {
      footer.push(h(Text, { key: 'busy', color: 'accent' }, 'deleting…'))
    } else if (phase === 'done') {
      for (const [index, line] of report.slice(0, REPORT_ROWS).entries()) {
        footer.push(
          h(Text, { key: `report:${index}`, color: line.startsWith('✗') ? 'error' : line.startsWith('!') ? 'warning' : 'success' }, line),
        )
      }
      footer.push(h(Text, { key: 'return', color: 'subtle' }, 'press any key to return'))
    } else if (searchMode) {
      footer.push(h(Text, { key: 'filter', color: 'accent' }, `filter: ${query}▌`))
    } else {
      footer.push(
        h(
          Text,
          { key: 'hint', color: 'subtle' },
          '↑↓ move · space select · a all · d delete · / filter · esc close',
        ),
      )
    }

    return h(
      Box,
      { flexDirection: 'column', height: rows, paddingX: 1 },
      h(
        Box,
        { flexDirection: 'row', justifyContent: 'space-between' },
        h(Text, { bold: true, color: 'accent' }, 'Sessions'),
        h(
          Text,
          { color: 'subtle' },
          `${all.length} total · ${selectedCount} selected${needle.length > 0 ? ` · "${query}"` : ''}`,
        ),
      ),
      h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' }, ...body),
      h(Box, { flexDirection: 'column' }, ...footer),
    )
  }
}

/** Group one session list by its recorded working directory. */
function groupByWorkspace(sessions) {
  const map = new Map()
  for (const session of sessions) {
    const cwd = typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : ''
    const list = map.get(cwd)
    if (list === undefined) map.set(cwd, [session])
    else list.push(session)
  }
  const groups = [...map.entries()].map(([cwd, list]) => ({
    cwd,
    list: list.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  }))
  // Most recently used workspace first — the same order the picker uses.
  groups.sort((a, b) => latestOf(b.list) - latestOf(a.list))
  return groups
}

/** Timestamp of the newest session in a group. */
function latestOf(list) {
  let latest = 0
  for (const session of list) latest = Math.max(latest, session.updatedAt ?? 0)
  return latest
}

/** Whether a session matches the lowercase filter needle. */
function matches(session, needle) {
  const title = session.title?.text ?? ''
  return (
    title.toLowerCase().includes(needle) ||
    (session.cwd ?? '').toLowerCase().includes(needle) ||
    session.id.toLowerCase().includes(needle)
  )
}

/** Header label of one workspace group. */
function groupLabel(group) {
  const name = shortCwd(group.cwd)
  return `${name} · ${group.list.length}`
}

/** Render a working directory relative to home. */
function shortCwd(cwd) {
  const value = cwd.length > 0 ? cwd : '(no working directory)'
  return HOME.length > 0 && value.startsWith(HOME) ? `~${value.slice(HOME.length)}` : value
}

/** Short relative age of a session's last activity. */
function formatAge(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Session id shortened for a one-line report. */
function shortId(id) {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

/** Cut a title to a cell budget, without mid-grapheme math. */
function truncate(text, budget) {
  if (text.length <= budget) return text
  return `${text.slice(0, Math.max(1, budget - 1))}…`
}

/** Error to one line. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
