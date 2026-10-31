// The terminal's view in the pane: runs on the drawing thread, draws the screen
// the hooks module hands it and posts the keys pressed while it has the focus.
import type { ClientKeyEvent, ClientModule, JsonValue } from 'claude-code'

export type ViewProps = {
  lines: string[]
  cursor: { x: number; y: number } | null
  rows: number
  note?: string
}

type Local = { queue: ClientKeyEvent[]; ticks: number }

const FRAME_MS = 80
const TICKS_PER_REFRESH = 3

const Terminal: ClientModule<ViewProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    const local: Local = { queue: [], ticks: 0 }
    surface.setState(local)
    surface.onKey(event => {
      local.queue.push(event)
    })
    // One post per beat, so a key can never be replaced by a refresh: a later
    // post in the same frame would take the place of an undelivered one.
    surface.every(FRAME_MS, () => {
      local.ticks += 1
      if (local.queue.length > 0) {
        surface.post({ keys: local.queue.splice(0) as unknown as JsonValue })
      } else if (local.ticks % TICKS_PER_REFRESH === 0) {
        surface.post({ size: { columns: surface.columns, rows: surface.rows } })
      }
    })
  }

  if (props.note !== undefined) {
    return <Text dimColor>{props.note}</Text>
  }

  return (
    <Box flexDirection="column">
      {props.lines.slice(0, props.rows).map((line, y) => {
        if (props.cursor?.y !== y) return <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
        const chars = [...line]
        const at = props.cursor.x

        return (
          <Text wrap="truncate-end">
            {chars.slice(0, at).join('').padEnd(at, ' ')}
            <Text inverse>{chars[at] ?? ' '}</Text>
            {chars.slice(at + 1).join('')}
          </Text>
        )
      })}
    </Box>
  )
}

export default Terminal
