// The terminal's view in the pane: runs on the drawing thread, draws the screen
// the hooks module hands it and posts the keys pressed while it has the focus.
import type { ClientKeyEvent, ClientModule, JsonValue } from 'claude-code'

import type { Span } from './lib'

export type ViewProps = {
  lines: Span[][]
  cursor: { x: number; y: number } | null
  rows: number
  note?: string
  /** Lines scrolled up from the bottom; 0 or absent at the live screen. */
  scrolled?: number
}

type Local = { queue: ClientKeyEvent[]; ticks: number; eager: number }

const BEAT_MS = 50
const IDLE_BEATS_PER_REFRESH = 5
// After a key the screen is about to change: look on every beat for a while.
const EAGER_BEATS = 20

/** The runs of a line with the cell under the cursor split out and marked. */
function markCursor(spans: readonly Span[], at: number): (Span & { isCursor?: true })[] {
  const out: (Span & { isCursor?: true })[] = []
  let column = 0
  let isDrawn = false
  for (const span of spans) {
    const chars = [...span.t]
    const start = column
    column += chars.length
    if (isDrawn || at < start || at >= column) {
      out.push(span)
      continue
    }
    const before = chars.slice(0, at - start).join('')
    const after = chars.slice(at - start + 1).join('')
    if (before !== '') out.push({ ...span, t: before })
    out.push({ ...span, t: chars[at - start] ?? ' ', isCursor: true })
    if (after !== '') out.push({ ...span, t: after })
    isDrawn = true
  }
  if (!isDrawn) {
    if (at > column) out.push({ t: ' '.repeat(at - column) })
    out.push({ t: ' ', isCursor: true })
  }

  return out
}

const Terminal: ClientModule<ViewProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    const local: Local = { queue: [], ticks: 0, eager: 0 }
    surface.setState(local)
    surface.onKey(event => {
      local.queue.push(event)
      local.eager = EAGER_BEATS
    })
    // One post per beat, so a key can never be replaced by a refresh: a later
    // post in the same frame would take the place of an undelivered one.
    surface.every(BEAT_MS, () => {
      local.ticks += 1
      if (local.queue.length > 0) {
        surface.post({ keys: local.queue.splice(0) as unknown as JsonValue })
      } else if (local.eager > 0 || local.ticks % IDLE_BEATS_PER_REFRESH === 0) {
        local.eager = Math.max(0, local.eager - 1)
        surface.post({ size: { columns: surface.columns, rows: surface.rows } })
      }
    })
  }

  if (props.note !== undefined) {
    return <Text dimColor>{props.note}</Text>
  }

  return (
    <Box flexDirection="column">
      {(props.scrolled ?? 0) > 0 && (
        <Text inverse wrap="truncate-end">{` ${props.scrolled} lines up · PgDn or wheel to go back, typing returns `}</Text>
      )}
      {props.lines.slice((props.scrolled ?? 0) > 0 ? 1 : 0, props.rows).map((spans, row) => {
        const y = row
        const runs = props.cursor?.y === y ? markCursor(spans, props.cursor.x) : spans
        if (runs.length === 0) return <Text wrap="truncate-end"> </Text>

        return (
          <Text wrap="truncate-end">
            {runs.map(run => (
              <Text
                color={run.s?.f}
                backgroundColor={run.s?.b}
                bold={run.s?.B}
                dimColor={run.s?.d}
                italic={run.s?.i}
                underline={run.s?.u}
                inverse={'isCursor' in run ? run.s?.v !== true : run.s?.v}
              >
                {run.t}
              </Text>
            ))}
          </Text>
        )
      })}
    </Box>
  )
}

export default Terminal
