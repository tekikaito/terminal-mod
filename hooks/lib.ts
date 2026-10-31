// Pure logic: no `$`, so every rule here is testable on its own.

export const MAX_LINES = 5000
export const MAX_OUTPUT_CHARS = 100_000
export const MAX_COMMAND_CHARS = 1000

export type Mention = { raw: string; lines?: number }

// `@term` or `@term:200`, standing alone: not `foo@term`, `@terminal`, `@term/x`
// or `` `@term` ``, so a prompt can still talk about the mention itself.
const MENTION = /(?<![\w`@/.-])@term(?::(\d+))?(?![\w/-]|[.:]\w)/g

export function clampLines(value: number): number {
  return Math.min(MAX_LINES, Math.max(1, Math.trunc(value)))
}

export function findMentions(text: string): Mention[] {
  return [...text.matchAll(MENTION)].map(match =>
    match[1] === undefined
      ? { raw: match[0] }
      : { raw: match[0], lines: clampLines(Number(match[1])) },
  )
}

/** Replaces each mention with what `render` answers for it, in place. */
export function replaceMentions(
  text: string,
  render: (mention: Mention) => string,
): string {
  return text.replace(MENTION, (raw: string, digits?: string) =>
    render(
      digits === undefined ? { raw } : { raw, lines: clampLines(Number(digits)) },
    ),
  )
}

/** Drops every control character but newlines; a tab becomes a space. */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => (char === '\n' ? char : ''))
}

/** One line of control-free text, fit to stand in a question to the person. */
export function oneLine(text: string): string {
  return sanitize(text).replace(/\n/g, ' ')
}

/**
 * Wraps terminal output as data. The output cannot close the wrapper, since
 * whatever scrolled past in the terminal may have been written by anyone.
 */
export function fenceOutput(
  output: string,
  pane: string,
  command: string,
): string {
  let body = sanitize(output).replace(/\s+$/, '')
  if (body.length > MAX_OUTPUT_CHARS) {
    body = `[older output cut]\n${body.slice(-MAX_OUTPUT_CHARS)}`
  }
  body = body.replace(/<(\/?)terminal-output/gi, '&lt;$1terminal-output')
  const head = `<terminal-output pane="${pane}" running="${attribute(command)}">`

  return `${head}\n${body}\n</terminal-output>`
}

function attribute(text: string): string {
  return oneLine(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Why a command may not go to the terminal, or undefined where it may. */
export function refuseCommand(command: string, isTypedByPerson = false): string | undefined {
  if (command.trim() === '') return 'The command is empty.'
  if (isTypedByPerson) {
    return /[\p{Cc}\p{Cf}]/u.test(command) ? 'The command must be one line, with no control or invisible characters.' : undefined
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return `The command is longer than ${MAX_COMMAND_CHARS} characters.`
  }
  if (/[\p{Cc}\p{Cf}]/u.test(command)) {
    return 'The command must be one line, with no control or invisible characters.'
  }

  // A wall of spaces could push the rest of a command out of the dialog's sight.
  if (/[\s\u115f\u1160\u2800\u3164\uffa0]{8,}/.test(command)) {
    return 'The command must not hold long runs of spaces.'
  }

  return undefined
}

/**
 * tmux reads an argument ending in `;` as a command separator, even from argv,
 * and takes `\;` for a literal one. Every argument the mod did not write itself
 * goes through this, so text can never become a tmux command.
 */
export function tmuxArg(value: string): string {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value
}

/** A path for tmux's `-c`, which expands formats: `#(...)` would run a command. */
export function tmuxPath(path: string): string {
  return tmuxArg(path.replace(/#/g, '##'))
}

export const isPaneId = (value: string): boolean => /^%\d+$/.test(value)

export type KeyEvent = {
  key: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}
export type TmuxKeys = { literal: string } | { key: string }

const NAMED: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'BSpace',
  delete: 'DC',
  insert: 'IC',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PPage',
  pagedown: 'NPage',
  space: 'Space',
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]),
  ),
}
const IGNORED = new Set(['escape', 'wheelup', 'wheeldown'])

function keyToTmux(event: KeyEvent): TmuxKeys | undefined {
  if (typeof event.key !== 'string' || IGNORED.has(event.key)) return undefined
  const named = Object.hasOwn(NAMED, event.key) ? NAMED[event.key] : undefined
  if (named !== undefined) {
    if (named === 'Tab' && event.shift === true) return { key: 'BTab' }
    const mods = `${event.ctrl === true ? 'C-' : ''}${event.meta === true ? 'M-' : ''}${event.shift === true ? 'S-' : ''}`

    return { key: `${mods}${named}` }
  }
  const text = sanitize(event.key).replace(/\n/g, '\r')
  if (text === '') return undefined
  const isOneChar = [...text].length === 1
  if (isOneChar && (event.ctrl === true || event.meta === true)) {
    const mods = `${event.ctrl === true ? 'C-' : ''}${event.meta === true ? 'M-' : ''}`

    return { key: `${mods}${text}` }
  }

  return { literal: text }
}

/** Maps pressed keys to tmux send-keys calls, typed runs merged into one. */
export function keysToTmux(events: readonly KeyEvent[]): TmuxKeys[] {
  const out: TmuxKeys[] = []
  for (const event of events) {
    const keys = keyToTmux(event)
    if (keys === undefined) continue
    const last = out.at(-1)
    if ('literal' in keys && last !== undefined && 'literal' in last) {
      out[out.length - 1] = { literal: last.literal + keys.literal }
    } else {
      out.push(keys)
    }
  }

  return out
}

export type Screen = {
  lines: string[]
  cursor: { x: number; y: number } | null
}

/** Reads `capture-pane -p` output followed by one `x y flag` line. */
export function parseScreen(stdout: string): Screen {
  const all = stdout.replace(/\n$/, '').split('\n')
  const status = /^(\d+) (\d+) ([01])$/.exec(all.at(-1) ?? '')
  if (status === null) return { lines: all.map(sanitize), cursor: null }
  all.pop()

  return {
    lines: all.map(sanitize),
    cursor:
      status[3] === '1' ? { x: Number(status[1]), y: Number(status[2]) } : null,
  }
}
