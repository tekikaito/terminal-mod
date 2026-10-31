/** The terminal this session started itself, on the mod's private tmux socket. */
export type OwnedTerminal = { session: string; pane: string }

declare module 'claude-code' {
  interface PluginState {
    'terminal-mod': {
      owned: Shaped<OwnedTerminal | null>
      pinned: Shaped<string | null>
    }
  }
}
