// tmux, reached through `$.process.run`. Everything that decides which pane the
// mod talks to is here, and it never answers the pane Claude itself runs in.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { OwnedTerminal } from '../types'
import { isPaneId, parseScreen, tmuxArg, tmuxPath } from './lib'
import type { Screen, TmuxKeys } from './lib'

export const SOCKET = 'claude-terminal-mod'

export const owned = atom(
  { plugin: 'terminal-mod', key: 'owned' } as const,
  null as OwnedTerminal | null,
  { shape: 'owned-1' },
)
export const pinned = atom(
  { plugin: 'terminal-mod', key: 'pinned' } as const,
  null as string | null,
  { shape: 'pinned-1' },
)

export class TerminalError extends Error {}

export type Pane = {
  pane: string
  /** What tmux is told: the pane's id, or for the owned terminal its session. */
  target: string
  socket?: string
  command: string
  inMode: boolean
  isActive: boolean
  path: string
}

type Engine = EngineInterface
const FIELDS = '#{pane_id}\t#{pane_current_command}\t#{pane_in_mode}\t#{pane_active}\t#{pane_current_path}'

/**
 * A row format led by a mark nobody can guess: a directory name may hold a
 * newline, and must not be able to pass for a row of its own.
 */
function rowFormat(): { mark: string; format: string } {
  const mark = crypto.randomUUID()

  return { mark, format: `${mark}${FIELDS}` }
}

async function tmux(
  $: Engine,
  socket: string | undefined,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; isCut: boolean }> {
  const argv = socket === undefined ? ['tmux', ...args] : ['tmux', '-L', socket, ...args]
  try {
    const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(argv, {
      timeoutMs: 5000,
    })

    return { ok: exitCode === 0, stdout, stderr, isCut: isStdoutTruncated }
  } catch {
    throw new TerminalError('tmux could not be run. Is it installed and on PATH?')
  }
}

function parsePanes(stdout: string, mark: string, socket?: string): Pane[] {
  return stdout
    .split(mark)
    .slice(1)
    .map(row => {
      const [pane = '', command = '', mode = '0', active = '0', ...path] = row.replace(/\n$/, '').split('\t')

      return {
        pane,
        target: pane,
        command,
        inMode: mode === '1',
        isActive: active === '1',
        path: path.join('\t'),
        ...(socket === undefined ? {} : { socket }),
      }
    })
    .filter(row => isPaneId(row.pane))
}

/** The pane Claude itself runs in, when it runs in tmux. */
export async function selfPane($: Engine): Promise<string | undefined> {
  const session = await $.env.get('TMUX')
  const pane = await $.env.get('TMUX_PANE')

  return session !== undefined && session !== '' && pane !== undefined && pane !== ''
    ? pane
    : undefined
}

export async function listAllPanes($: Engine): Promise<Pane[]> {
  const { mark, format } = rowFormat()
  const { ok, stdout } = await tmux($, undefined, ['list-panes', '-a', '-F', format])

  return ok ? parsePanes(stdout, mark) : []
}

async function neighbourIn($: Engine, self: string, cwd?: string, create?: boolean) {
  const pin = await read($, pinned)
  if (pin !== null) {
    const chosen = (await listAllPanes($)).find(p => p.pane === pin && p.pane !== self)
    if (chosen !== undefined) return chosen
    // Never fall back: a command meant for that pane must not reach another.
    throw new TerminalError(`The chosen pane ${pin} is gone. Choose another with /term-pane.`)
  }

  const here = rowFormat()
  const listed = await tmux($, undefined, ['list-panes', '-t', self, '-F', here.format])
  const neighbour = parsePanes(listed.stdout, here.mark).find(p => p.pane !== self)
  if (neighbour !== undefined || create !== true) return neighbour

  const row = rowFormat()
  const made = await tmux($, undefined, [
    'split-window', '-h', '-d', '-t', self,
    ...(cwd === undefined ? [] : ['-c', tmuxPath(cwd)]),
    '-P', '-F', row.format,
  ])
  if (!made.ok) throw new TerminalError(`tmux could not split the window: ${made.stderr.trim()}`)

  return parsePanes(made.stdout, row.mark)[0]
}

/**
 * The owned terminal is addressed by its session's exact name, never a pane id:
 * ids start over with a new server, and could then name another session's pane.
 */
const sessionTarget = (session: string): string => `=${session}:`

async function ownedPane($: Engine): Promise<Pane | undefined> {
  const mine = await read($, owned)
  if (mine === null) return undefined
  const { mark, format } = rowFormat()
  const { ok, stdout } = await tmux($, SOCKET, ['list-panes', '-t', sessionTarget(mine.session), '-F', format])
  // The session's name addresses its active pane, should someone have split it.
  const panes = ok ? parsePanes(stdout, mark, SOCKET) : []
  const pane = panes.find(p => p.isActive) ?? panes[0]

  return pane === undefined ? undefined : { ...pane, target: sessionTarget(mine.session) }
}

async function startOwned($: Engine, cwd?: string): Promise<Pane> {
  const session = `claude-${crypto.randomUUID().slice(0, 8)}`
  const { mark, format } = rowFormat()
  const made = await tmux($, SOCKET, [
    'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
    ...(cwd === undefined ? [] : ['-c', tmuxPath(cwd)]),
    '-P', '-F', format,
  ])
  const pane = parsePanes(made.stdout, mark, SOCKET)[0]
  if (!made.ok || pane === undefined) {
    throw new TerminalError(`tmux could not start a terminal: ${made.stderr.trim()}`)
  }
  await tmux($, SOCKET, ['set-option', '-t', sessionTarget(session), 'status', 'off'])
  await update($, owned, () => ({ session, pane: pane.pane }))

  return { ...pane, target: sessionTarget(session) }
}

// Two calls at once share one start, so no session is left without an owner.
let starting: Promise<Pane> | undefined

async function startOwnedOnce($: Engine, cwd?: string): Promise<Pane> {
  starting ??= (async () => (await ownedPane($)) ?? startOwned($, cwd))().finally(() => {
    starting = undefined
  })

  return starting
}

/**
 * The terminal to talk to: a neighbouring pane when Claude runs in tmux, else
 * the session's own background terminal. `create` makes one where none exists.
 */
export async function resolveTerminal(
  $: Engine,
  options: { cwd?: string; create?: boolean } = {},
): Promise<Pane | undefined> {
  const self = await selfPane($)
  if (self !== undefined) return neighbourIn($, self, options.cwd, options.create)
  const existing = await ownedPane($)
  if (existing !== undefined || options.create !== true) return existing

  return startOwnedOnce($, options.cwd)
}

/** Text of the pane: its screen, or that plus scrollback up to `lines` lines. */
export async function captureText($: Engine, target: Pane, lines?: number): Promise<string> {
  const args = ['capture-pane', '-p', '-J', '-t', target.target]
  if (lines !== undefined) args.push('-S', `-${lines}`)
  const { ok, stdout, stderr, isCut } = await tmux($, target.socket, args)
  if (!ok) throw new TerminalError(`tmux could not read ${target.pane}: ${stderr.trim()}`)
  if (isCut) throw new TerminalError('That much output is too large to read; ask for fewer lines.')
  if (lines === undefined) return stdout
  const kept = stdout.replace(/\s+$/, '').split('\n')

  return kept.slice(-lines).join('\n')
}

/** The owned terminal's screen and cursor, for the pane beside the chat. */
export async function captureOwnedScreen(
  $: Engine,
  view: { scrolled: number; rows: number } = { scrolled: 0, rows: 0 },
): Promise<Screen | undefined> {
  const mine = await read($, owned)
  if (mine === null) return undefined
  const target = sessionTarget(mine.session)
  // Line 0 is the top of the screen, so scrollback counts below it.
  const range = view.scrolled > 0 && view.rows > 0
    ? ['-S', String(-view.scrolled), '-E', String(view.rows - 1 - view.scrolled)]
    : []
  const { ok, stdout } = await tmux($, SOCKET, [
    'capture-pane', '-p', '-e', '-t', target, ...range,
    ';', 'display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on} #{history_size}',
  ])

  return ok ? parseScreen(stdout) : undefined
}

/** Pastes through a tmux buffer, bracketed where the program asks for that. */
export async function pasteOwned($: Engine, text: string): Promise<void> {
  const mine = await read($, owned)
  if (mine === null) return
  const buffer = 'terminal-mod-paste'
  const argv = ['tmux', '-L', SOCKET, 'load-buffer', '-b', buffer, '-']
  const { exitCode } = await $.process.run(argv, { stdin: text, timeoutMs: 5000 })
  if (exitCode !== 0) throw new TerminalError('tmux could not take the text.')
  await tmux($, SOCKET, ['paste-buffer', '-d', '-p', '-b', buffer, '-t', sessionTarget(mine.session)])
}

/** The clipboard's text, from the first tool this machine has that answers. */
export async function readClipboard($: Engine): Promise<string | undefined> {
  const isWsl = (await $.env.get('WSL_DISTRO_NAME')) !== undefined
  const windows = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']
  const tools = [
    ...(isWsl ? [windows] : []),
    ['pbpaste'],
    ['wl-paste', '--no-newline'],
    ['xclip', '-selection', 'clipboard', '-o'],
    ['xsel', '--clipboard', '--output'],
  ]
  for (const argv of tools) {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 5000 })
      if (exitCode === 0) return stdout
    } catch {
      // That tool is not on this machine; the next may be.
    }
  }

  return undefined
}

export async function resizeOwned($: Engine, columns: number, rows: number): Promise<void> {
  const mine = await read($, owned)
  if (mine === null) return
  await tmux($, SOCKET, [
    'resize-window', '-t', sessionTarget(mine.session), '-x', String(columns), '-y', String(rows),
  ])
}

export async function sendKeys($: Engine, to: Pick<Pane, 'target' | 'socket'>, keys: readonly TmuxKeys[]) {
  for (const one of keys) {
    const args =
      'literal' in one
        ? ['send-keys', '-t', to.target, '-l', '--', tmuxArg(one.literal)]
        : ['send-keys', '-t', to.target, '--', tmuxArg(one.key)]
    const { ok, stderr } = await tmux($, to.socket, args)
    if (!ok) throw new TerminalError(`tmux could not write to the terminal: ${stderr.trim()}`)
  }
}

/** Types one command into the pane and presses Enter. */
export async function sendCommand($: Engine, target: Pane, command: string): Promise<void> {
  if (target.inMode) {
    throw new TerminalError(`Pane ${target.pane} is in copy mode; leave it first, so the command is not read as keys.`)
  }
  await sendKeys($, target, [{ literal: command }, { key: 'Enter' }])
}

export async function killOwned($: Engine): Promise<void> {
  const mine = await read($, owned)
  if (mine === null) return
  await update($, owned, () => null)
  await tmux($, SOCKET, ['kill-session', '-t', sessionTarget(mine.session)])
}

export async function pressOwned($: Engine, keys: readonly TmuxKeys[]): Promise<void> {
  const mine = await read($, owned)
  if (mine !== null) await sendKeys($, { target: sessionTarget(mine.session), socket: SOCKET }, keys)
}

export async function getPinned($: Engine): Promise<string | null> {
  return read($, pinned)
}

export async function setPinned($: Engine, pane: string | null): Promise<void> {
  await update($, pinned, () => pane)
}
