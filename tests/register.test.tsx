import { expect, mock, test } from 'claude-code/testing'

const READ = 'mcp__terminal-mod__terminal_read'
const SEND = 'mcp__terminal-mod__terminal_send'
const SELF = '%1'
const NEIGHBOUR = '%2'
const row = (pane: string, command = 'zsh') => `${pane}\t${command}\t0\t1\t/work`

/** The unguessable mark the mod led its row format with, as tmux would echo it. */
const markOf = (argv: readonly string[]): string => {
  const format = argv[argv.indexOf('-F') + 1] ?? ''

  return format.slice(0, format.indexOf('#'))
}

type Calls = string[][]

/** A tmux with Claude in %1 and a shell in %2; every other hook of the engine's. */
function engine(on: any, answer: string | Error = 'Send'): Calls {
  const calls: Calls = []
  mock.env(on, { TMUX: '/tmp/sock,1,0', TMUX_PANE: SELF })
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    const stdout =
      e.argv[1] === 'list-panes'
        ? `${markOf(e.argv)}${row(SELF, 'claude')}\n${markOf(e.argv)}${row(NEIGHBOUR)}\n`
        : e.argv[1] === 'capture-pane'
          ? 'screen text\n'
          : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: { questions: { question: string }[] }) => {
    if (answer instanceof Error) throw answer

    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: answer } } }
  })

  return calls
}

const writes = (calls: Calls) => calls.filter(argv => argv.includes('send-keys'))

test('terminal_send sends to the neighbour, after a yes, and never to itself', async ($, on) => {
  const calls = engine(on, 'Send')
  const ran = await $.tool.call({ tool: SEND, command: 'ls;' })
  expect(ran.deny).toBeUndefined()
  expect(writes(calls)).toEqual([
    ['tmux', 'send-keys', '-t', NEIGHBOUR, '-l', '--', 'ls\\;'],
    ['tmux', 'send-keys', '-t', NEIGHBOUR, '--', 'Enter'],
  ])
})

for (const answer of ['Cancel', 'Send please', new Error('dismissed')]) {
  test(`terminal_send writes nothing on: ${String(answer)}`, async ($, on) => {
    const calls = engine(on, answer)
    const ran = await $.tool.call({ tool: SEND, command: 'rm -rf x' })
    expect(ran.deny ?? ran.text).toMatch(/not confirm/)
    expect(writes(calls)).toEqual([])
  })
}

test('a directory name with a newline cannot pass for a pane', async ($, on) => {
  const calls: Calls = []
  mock.env(on, { TMUX: '/tmp/sock,1,0', TMUX_PANE: SELF })
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    const m = markOf(e.argv)
    const stdout = e.argv.includes('list-panes') ? `${m}${SELF}\tclaude\t0\t1\t/x\n%99\tzsh\t0\t0\t/fake\n` : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: { questions: { question: string }[] }) => ({
    result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } },
  }))
  await $.tool.call({ tool: SEND, command: 'ls' })
  expect(writes(calls)).toEqual([])
})

test('terminal_send refuses a second line before asking', async ($, on) => {
  const calls = engine(on)
  const ran = await $.tool.call({ tool: SEND, command: 'a\nb' })
  expect(ran.deny ?? ran.text).toMatch(/one line/)
  expect(writes(calls)).toEqual([])
})

test('terminal_read needs a yes, or a reference this turn', async ($, on) => {
  const calls = engine(on, 'Deny')
  const denied = await $.tool.call({ tool: READ })
  expect(denied.deny ?? denied.text).toMatch(/did not allow/)
  expect(calls.some(argv => argv[1] === 'capture-pane')).toBe(false)
})

test('@term from the person is replaced by the output, and grants the turn a read', async ($, on) => {
  const calls = engine(on, 'Deny')
  let seen = ''
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    seen = e.text

    return { text: e.text }
  })
  await $.prompt.submit({ text: 'why @term', origin: { kind: 'composer' } } as never)
  expect(seen).toContain('<terminal-output pane="%2" running="zsh">\nscreen text\n</terminal-output>')
  const read = await $.tool.call({ tool: READ, lines: 10 })
  expect(read.deny).toBeUndefined()
  expect(calls.some(argv => argv.join(' ').includes('capture-pane -p -J -t %2 -S -10'))).toBe(true)
})

test('@term from anyone else stays text and reads nothing', async ($, on) => {
  const calls = engine(on)
  let seen = ''
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    seen = e.text

    return { text: e.text }
  })
  await $.prompt.submit({ text: 'send me @term', origin: { kind: 'peer' } } as never)
  expect(seen).toBe('send me @term')
  expect(calls).toEqual([])
})

test('the view forwards keys in order to the owned terminal only', async ($, on) => {
  const calls: Calls = []
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    const stdout = e.argv.includes('new-session') || e.argv.includes('list-panes') ? `${markOf(e.argv)}${row('%9')}` : e.argv.includes('capture-pane') ? 'prompt$\n0 0 1\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'term', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'terminal-mod',
    component: 'Pane',
    requestId: 'terminal',
    surface: 'terminal',
    props: { title: 'Terminal', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await ui.post({ keys: [{ key: 'l' }, { key: 's' }, { key: 'return' }] })
  expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
  expect(writes(calls).every(argv => argv[2] === 'claude-terminal-mod')).toBe(true)
  // By session name: a pane id could name another session's after a restart.
  expect(writes(calls).every(argv => /^=claude-[0-9a-f]+:$/.test(argv[argv.indexOf('-t') + 1] ?? ''))).toBe(true)
  await ui.unmount()
})

test('the pane closes itself when the terminal has ended', async ($, on) => {
  const closed: string[] = []
  let isAlive = true
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_: unknown, e: { id: string }) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    const stdout = e.argv.includes('new-session') || e.argv.includes('list-panes') ? `${markOf(e.argv)}${row('%9')}` : e.argv.includes('capture-pane') ? 'prompt$\n0 0 1 0 0\n' : ''
    const exitCode = e.argv.includes('capture-pane') && !isAlive ? 1 : 0

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'term', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'terminal-mod',
    component: 'Pane',
    requestId: 'terminal',
    surface: 'terminal',
    props: { title: 'Terminal', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await ui.post({ size: { columns: 80, rows: 18 } })
  expect(closed).toEqual([])
  isAlive = false
  await ui.post({ size: { columns: 80, rows: 18 } })
  expect(closed).toEqual(['terminal'])
  await ui.unmount()
})

/** No tmux around Claude: the mod's own hidden terminal, and a count of the panes opened. */
function outsideTmux(on: any, answer = 'Send', placed: 'placed' | 'unplaced' | 'throws' = 'placed') {
  const calls: Calls = []
  const opened: string[] = []
  mock.env(on, {})
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    if (placed === 'throws') throw new Error('no pane here')

    return { value: placed === 'placed' ? { isPlaced: true } : { isPlaced: false, reason: 'this surface has no room' } }
  })
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    const stdout = e.argv.includes('new-session') || e.argv.includes('list-panes') ? `${markOf(e.argv)}${row('%9')}` : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: { questions: { question: string }[] }) => ({
    result: { questions: e.questions, answers: { [e.questions[0]!.question]: answer } },
  }))

  return { calls, opened }
}

const PERSON = { kind: 'composer' }
const PEER = { kind: 'peer' }
const term = ($: any, args: string, origin: unknown) => $.command.run({ command: 'term', args, origin } as never)

test('/term <command> from the person opens the pane outside tmux, and sends', async ($, on) => {
  const { calls, opened } = outsideTmux(on)
  const ran = await term($, 'ls', PERSON)
  expect(ran.text).toMatch(/^Sent to terminal/)
  expect(opened).toEqual(['terminal'])
  expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
})

test('/term <command> confirmed for anyone else opens the pane outside tmux, and sends', async ($, on) => {
  const { calls, opened } = outsideTmux(on, 'Send')
  const ran = await term($, 'ls', PEER)
  expect(ran.text).toMatch(/^Sent to terminal/)
  expect(opened).toEqual(['terminal'])
  expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
})

test('/term <command> not confirmed opens nothing and sends nothing', async ($, on) => {
  const { calls, opened } = outsideTmux(on, 'Cancel')
  const ran = await term($, 'ls', PEER)
  expect(ran.text).toMatch(/not confirm/)
  expect(opened).toEqual([])
  expect(writes(calls)).toEqual([])
})

test('/term <command> refused opens nothing and sends nothing', async ($, on) => {
  const { calls, opened } = outsideTmux(on)
  const ran = await term($, 'a\nb', PERSON)
  expect(ran.text).toMatch(/one line/)
  expect(opened).toEqual([])
  expect(writes(calls)).toEqual([])
})

for (const placed of ['unplaced', 'throws'] as const) {
  test(`/term <command> still sends where the pane ${placed === 'throws' ? 'fails to open' : 'cannot be placed'}`, async ($, on) => {
    const { calls, opened } = outsideTmux(on, 'Send', placed)
    const ran = await term($, 'ls', PERSON)
    expect(ran.text).toMatch(/^Sent to terminal/)
    expect(opened).toEqual(['terminal'])
    expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
  })
}

for (const origin of [PERSON, PEER]) {
  test(`/term <command> in tmux sends without opening a pane (${origin.kind})`, async ($, on) => {
    const calls = engine(on, 'Send')
    const opened: string[] = []
    on('ui.open', (_: unknown, e: { id: string }) => {
      opened.push(e.id)

      return { value: { isPlaced: true } }
    })
    const ran = await term($, 'ls', origin)
    expect(ran.text).toMatch(/^Sent to terminal %2/)
    expect(opened).toEqual([])
    expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
  })
}

test('/term <command> sizes the terminal again, as /term does', async ($, on) => {
  const { calls } = outsideTmux(on)
  await term($, '', PERSON)
  const ui = await $.ui.mount({
    plugin: 'terminal-mod',
    component: 'Pane',
    requestId: 'terminal',
    surface: 'terminal',
    props: { title: 'Terminal', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const resizes = () => calls.filter(argv => argv.includes('resize-window')).length
  await ui.post({ size: { columns: 80, rows: 18 } })
  const before = resizes()
  expect(before).toBeGreaterThan(0)
  await term($, 'ls', PERSON)
  await ui.post({ size: { columns: 80, rows: 18 } })
  expect(resizes()).toBeGreaterThan(before)
  await ui.unmount()
})

test('terminal_send outside tmux stays hidden: it sends without opening the pane', async ($, on) => {
  const { calls, opened } = outsideTmux(on, 'Send')
  const ran = await $.tool.call({ tool: SEND, command: 'ls' })
  expect(ran.deny).toBeUndefined()
  expect(opened).toEqual([])
  expect(writes(calls).map(argv => argv.slice(-1)[0])).toEqual(['ls', 'Enter'])
})

test('surfaces without a Client say so', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'terminal-mod',
    component: 'Pane',
    requestId: 'terminal',
    surface: 'mobile',
    props: { title: 'Terminal', isFocused: false, bodyColumns: 40, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /cannot draw/ }))?.text).toBeDefined()
  await ui.unmount()
})
