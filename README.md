# terminal-mod

A terminal beside the Claude Code chat, connected both ways: pull what it shows into your prompt
with `@term`, and let Claude send it commands, each one confirmed by you.

- **Runs in tmux?** The mod connects to the pane next to Claude. You keep a real terminal with
  your own theme, scrolling and everything else tmux gives you.
- **Not in tmux?** `/term` starts a terminal in a pane beside the chat, on a private tmux server.

## Install

You need [Claude Code](https://claude.com/claude-code) and `tmux` (3.2 or newer, on Linux, macOS or
WSL). At the prompt of a terminal session:

```
/plugin install terminal-mod --marketplace tekikaito/terminal-mod
```

From a shell:

```sh
claude plugin install terminal-mod --marketplace tekikaito/terminal-mod
```

Answer `y` to add the marketplace and press Enter to install for your user. The mod is active at
once.

## Use

| You type | What happens |
| --- | --- |
| `/term` | Opens the terminal: the pane beside the chat, or in tmux, the neighbouring pane (split off if there is none). |
| `/term npm test` | Types `npm test` into the terminal and presses Enter. |
| `why did this fail? @term` | Replaces `@term` with what the terminal's screen shows. |
| `@term:500` | The same, with the last 500 lines of scrollback (5000 at most). |
| `/term-pane` | In tmux: lists all panes. `/term-pane %3` connects to that one, `/term-pane auto` goes back to the neighbour. |

Claude gets two tools: `terminal_read` and `terminal_send`.

To type in the pane, click it; Esc gives the keyboard back to the prompt. Since Esc never reaches
the terminal that way, the pane has an **Esc** button, along with **Ctrl-C** and **Ctrl-D**.

To write the word itself in a prompt without it being replaced, put it in backticks: `` `@term` ``.
If the file picker is open after typing `@term`, the first Enter closes it and the second sends.

## What Claude may do

Terminal contents can hold secrets, and a terminal runs whatever it is given, past the permission
rules that guard Claude's Bash tool. So:

- **Writing:** every `terminal_send` asks you, showing the command and the target pane. It asks
  in every permission mode, auto mode included, and no allow rule skips it. A dismissed dialog is
  a no. Commands must be a single line of at most 1000 characters, without control or invisible
  characters or long runs of spaces. If the terminal changes while the dialog is open (another program,
  another directory), the command is not sent.
- **Reading:** `terminal_read` works without asking only in a turn whose prompt you wrote
  `@term` in. Otherwise it asks every time.
- **`@term` only counts from you.** A prompt from a peer session, a channel or a scheduled trigger
  stays plain text and reads nothing.
- **Output is data.** It arrives inside a `<terminal-output>` wrapper it cannot close, with control
  characters removed. Output containing `@file` does not attach that file. Claude could still be
  misled by text in the output, so read what you are asked to send.
- **What `@term` reads goes into the conversation**, as it stands. Nothing is masked: don't
  reference a terminal showing a password.
- Claude's own pane is never a target.

## Limits

- The pane beside the chat shows only the screen, in standard colours rather than your own terminal
  theme, and drops the colours of a screen too heavy to redraw: scroll with the
  terminal's own tools (`less`, `tmux -L claude-terminal-mod attach`). For full fidelity, run Claude
  in tmux.
- The pane docks at the side in a fullscreen terminal of 110 columns or more; elsewhere it sits above
  the prompt.
- It needs a surface with a terminal view. VS Code and mobile get `/term` and `@term` only.
- The private terminal ends with the Claude session, and whatever runs in it too. `/clear` keeps it.
  If Claude crashes, end leftovers with `tmux -L claude-terminal-mod kill-server`.
- Mod APIs are early access and may change between Claude Code releases. Tested on 2.1.316.

## Develop

```sh
claude --plugin-dir .        # run it from this folder
claude plugin validate .
claude plugin test .
npx -p typescript@5.9 tsc -p .   # after a first load has laid out .claude-plugin/types
```

`hooks/lib.ts` is the pure logic, `hooks/terminal.ts` talks to tmux, `hooks/register.tsx` holds the
hooks, and `hooks/client.tsx` draws the pane.

## License

[MIT](LICENSE)
