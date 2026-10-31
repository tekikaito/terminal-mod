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

/** How a run of text is painted; keys kept short, as a whole screen travels as props. */
export type Style = {
  f?: string
  b?: string
  B?: true
  d?: true
  i?: true
  u?: true
  v?: true
}
export type Span = { t: string; s?: Style }

export type Screen = {
  lines: Span[][]
  cursor: { x: number; y: number } | null
  /** A full-screen program holds the terminal: scroll and paste keys are its own. */
  isAlternate: boolean
  /** Lines of scrollback above the screen. */
  history: number
}

const BASE_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map(n => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')).join('')}`

/** One of the 256 colors of the xterm palette, as hex. */
export function paletteColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined
  if (index < 16) return BASE_COLORS[index]
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10

    return hex(grey, grey, grey)
  }
  const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40)
  const cube = index - 16

  return hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6))
}

/** The color an extended SGR asks for, from what follows its 38 or 48. */
function extendedColor(rest: readonly number[]): { color?: string; used: number } {
  if (rest[0] === 5) return { color: paletteColor(rest[1] ?? -1), used: 2 }
  if (rest[0] === 2) {
    return { color: hex(rest[1] ?? 0, rest[2] ?? 0, rest[3] ?? 0), used: 4 }
  }

  return { used: rest.length }
}

function applySgr(style: Style, params: string): Style {
  let next = { ...style }
  const parts = params === '' ? ['0'] : params.split(';')
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? ''
    if (part.includes(':')) {
      // 38:2::r:g:b, 38:2:r:g:b, 38:5:n or 4:3
      const fields = part.split(':')
      const code = Number(fields[0])
      if (code === 38 || code === 48) {
        const mode = Number(fields[1])
        const values = mode === 2 ? [2, ...fields.slice(-3).map(Number)] : [mode, Number(fields[2])]
        const { color } = extendedColor(values)
        if (color !== undefined) next = code === 38 ? { ...next, f: color } : { ...next, b: color }
      } else if (code === 4) {
        const { u: _a, ...rest } = next
        next = fields[1] === '0' ? rest : { ...rest, u: true }
      }
      continue
    }
    const code = Number(part === '' ? '0' : part)
    if (code === 38 || code === 48) {
      const rest = parts.slice(i + 1).map(Number)
      const { color, used } = extendedColor(rest)
      i += used
      if (color !== undefined) next = code === 38 ? { ...next, f: color } : { ...next, b: color }
    } else if (code === 0) next = {}
    else if (code === 1) next = { ...next, B: true }
    else if (code === 2) next = { ...next, d: true }
    else if (code === 3) next = { ...next, i: true }
    else if (code === 4) next = { ...next, u: true }
    else if (code === 7) next = { ...next, v: true }
    else if (code === 22) { const { B: _a, d: _b, ...rest } = next; next = rest }
    else if (code === 23) { const { i: _a, ...rest } = next; next = rest }
    else if (code === 24) { const { u: _a, ...rest } = next; next = rest }
    else if (code === 27) { const { v: _a, ...rest } = next; next = rest }
    else if (code === 39) { const { f: _a, ...rest } = next; next = rest }
    else if (code === 49) { const { b: _a, ...rest } = next; next = rest }
    else if (code >= 30 && code <= 37) next = { ...next, f: BASE_COLORS[code - 30] as string }
    else if (code >= 40 && code <= 47) next = { ...next, b: BASE_COLORS[code - 40] as string }
    else if (code >= 90 && code <= 97) next = { ...next, f: BASE_COLORS[code - 90 + 8] as string }
    else if (code >= 100 && code <= 107) next = { ...next, b: BASE_COLORS[code - 100 + 8] as string }
  }

  return next
}

// A CSI sequence, an OSC or other string sequence up to its end, or a lone escape.
const ESCAPE = /\u001b(?:\[([0-9;:?<=>]*)[ -/]*([@-~])|[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b[\s\S])?|[\s\S]?)/g

/**
 * Reads `capture-pane -e` lines into painted runs. tmux carries a style on from
 * one line to the next, so one state runs through them; every sequence but a
 * color or an attribute is dropped, so none ever reaches the surface.
 */
export function parseStyledLines(lines: readonly string[]): Span[][] {
  let style: Style = {}

  return lines.map(line => {
    const spans: Span[] = []
    const push = (raw: string): void => {
      const t = sanitize(raw).replace(/\n/g, ' ')
      if (t === '') return
      const last = spans.at(-1)
      if (last !== undefined && JSON.stringify(last.s ?? {}) === JSON.stringify(style)) {
        last.t += t
      } else {
        spans.push(Object.keys(style).length === 0 ? { t } : { t, s: style })
      }
    }
    let at = 0
    for (const match of line.matchAll(ESCAPE)) {
      push(line.slice(at, match.index))
      at = match.index + match[0].length
      if (match[2] === 'm' && /^[0-9;:]*$/.test(match[1] ?? '')) {
        style = applySgr(style, match[1] ?? '')
      }
    }
    push(line.slice(at))

    return spans
  })
}

/** The same screen with no paint, for one too heavy to travel as props. */
export function withoutStyles(lines: readonly Span[][]): Span[][] {
  return lines.map(spans => {
    const t = spans.map(span => span.t).join('')

    return t === '' ? [] : [{ t }]
  })
}

/** Reads `capture-pane -p -e` output followed by one status line. */
export function parseScreen(stdout: string): Screen {
  const all = stdout.replace(/\n$/, '').split('\n')
  const status = /^(\d+) (\d+) ([01]) ([01]) (\d+)$/.exec(all.at(-1) ?? '')
  if (status === null) {
    return { lines: parseStyledLines(all), cursor: null, isAlternate: false, history: 0 }
  }
  all.pop()

  return {
    lines: parseStyledLines(all),
    cursor:
      status[3] === '1' ? { x: Number(status[1]), y: Number(status[2]) } : null,
    isAlternate: status[4] === '1',
    history: Number(status[5]),
  }
}

export const MAX_PASTE_CHARS = 1_000_000

/**
 * Clipboard text as a terminal may take it: no escape can end a bracketed paste,
 * and no newline at its end can run the last line unasked.
 */
export function cleanPaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => (char === '\n' || char === '\t' ? char : ''))
    .replace(/\n+$/, '')
}

/** Lines scrolled up from the bottom, after moving by `by`, up being positive. */
export function clampScroll(current: number, by: number, history: number): number {
  return Math.min(history, Math.max(0, current + Math.trunc(by)))
}

export type KeyStep = { keys: KeyEvent[] } | { paste: true } | { page: 1 | -1 }

/**
 * Splits pressed keys, in order, into what goes to the terminal and what the
 * view answers itself. A full-screen program gets every key: they are its own.
 */
export function splitKeys(events: readonly KeyEvent[], isAlternate: boolean): KeyStep[] {
  const steps: KeyStep[] = []
  for (const event of events) {
    const isPlain = event.ctrl !== true && event.meta !== true
    let own: KeyStep | undefined
    if (!isAlternate && event.key === 'v' && (event.ctrl === true || event.meta === true)) own = { paste: true }
    else if (!isAlternate && isPlain && event.key === 'pageup') own = { page: 1 }
    else if (!isAlternate && isPlain && event.key === 'pagedown') own = { page: -1 }
    if (own !== undefined) {
      steps.push(own)
      continue
    }
    const last = steps.at(-1)
    if (last !== undefined && 'keys' in last) last.keys.push(event)
    else steps.push({ keys: [event] })
  }

  return steps
}
