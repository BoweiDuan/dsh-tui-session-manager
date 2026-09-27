/**
 * dsh-tui-session-manager — a session manager for the dsh-TUI front end.
 *
 * Why this plugin exists
 * ----------------------
 * dsh-TUI's adapter already implements real session deletion
 * (`channel.deleteSession(id)`: removes the session's log directory, its
 * last-used entry, its agent-view entry and the resume marker), but 0.11.x
 * ships no UI caller for it. This plugin does not reimplement deletion: it
 * contributes the missing entry point — a `/sessions` command that opens a
 * full-screen scene built on top of the host's own channel API.
 *
 * Wiring, and why it is `ctx.inject` and not a soft probe
 * ------------------------------------------------------
 * The profile composes rows in declaration order, so this plugin's `apply`
 * runs BEFORE the dsh-TUI rows that mount `ctx.tuiScenes` and `ctx.commands`.
 * Probing once and returning early therefore loses the race: the seams are
 * still undefined at that moment (measured: `apply: seams tuiScenes=false
 * commands=false`), and Cordis does not re-run `apply` when they appear.
 *
 * `ctx.inject(['tuiScenes', 'commands'], cb)` is Cordis' plugin-with-
 * dependencies short form: it registers a child fiber whose callback runs as
 * soon as both services exist, and is disposed if either goes away. That is
 * the correct seam for a plugin that contributes into another row's services.
 * In a headless host the callback simply never runs, so the plugin stays idle
 * without failing boot.
 *
 * Diagnostics
 * -----------
 * A plain `ctx.commands.register()` leaves no effect-ledger record (only the
 * mediated registration path records `create command …`), so "the command is
 * missing" cannot be answered from outside the running TUI. Every boundary in
 * this file appends one line to `$DSH_TUI_HOME/session-manager.log` — see
 * `./debug.js`. The log is a debugging aid, never a dependency.
 *
 * @module dsh-tui-session-manager
 */

import { errorText, log } from './debug.js'
import { createSessionManagerScene } from './scene.js'

/** Cordis plugin name (the row's local identity). */
export const name = 'dsh-tui-session-manager'

/** Scene id registered with the host; `/sessions` opens exactly this id. */
const SCENE_ID = 'session-manager'

/** The slash command users type. */
const COMMAND_NAME = 'sessions'

/**
 * Wire the plugin into the composed host context.
 *
 * @param {object} ctx - Cordis context; the dsh-TUI services arrive later.
 * @returns {void}
 */
export function apply(ctx) {
  log(`apply: start (pid ${process.pid})`)

  ctx.inject(['tuiScenes', 'commands'], (host) => {
    const scenes = host.tuiScenes
    const commands = host.commands
    log(`inject: seams ready (tuiScenes=${scenes !== undefined} commands=${commands !== undefined})`)

    const component = createSessionManagerScene()

    // Registration is effect-owned by the injected fiber: when either service
    // is replaced (a live profile reload), both are withdrawn and the callback
    // runs again against the new ones.
    try {
      const disposeScene = scenes.register(
        {
          id: SCENE_ID,
          title: 'Sessions',
          component,
        },
        host,
      )
      host.effect(() => disposeScene, 'session-manager scene')
      log(`scene: registered "${SCENE_ID}"`)
    } catch (error) {
      log(`scene: register FAILED — ${errorText(error)}`)
      ctx.logger?.warn?.(`[session-manager] scene registration failed: ${errorText(error)}`)
    }

    try {
      const disposeCommand = commands.register({
        name: COMMAND_NAME,
        description: 'Browse and delete saved sessions',
        handler: () => {
          log(`command: /${COMMAND_NAME} invoked`)
          const opened = scenes.open(SCENE_ID)
          log(`command: open("${SCENE_ID}") → ${opened}`)
          if (!opened) {
            return { kind: 'error', text: `session-manager: scene "${SCENE_ID}" is not registered` }
          }
          // Silent success: the scene replaces the screen, the conversation stays clean.
          return { kind: 'success' }
        },
      })
      host.effect(() => disposeCommand, 'session-manager command')
      log(`command: registered "${COMMAND_NAME}"`)
    } catch (error) {
      log(`command: register FAILED — ${errorText(error)}`)
      ctx.logger?.warn?.(`[session-manager] command registration failed: ${errorText(error)}`)
    }
  })

  log('apply: injected (waiting for tuiScenes + commands)')
}

export default { name, apply }
