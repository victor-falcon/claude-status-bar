/** One piece of the status line; `color` is a theme key or a raw color, absent for dim text. */
export type StatusBarSpan = { text: string; color?: string }

export type StatusBarSpans = readonly StatusBarSpan[] | null

declare module 'claude-code' {
  interface PluginState {
    'status-bar': { spans: StatusBarSpans }
  }
}
