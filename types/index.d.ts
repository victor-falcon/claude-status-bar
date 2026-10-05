/**
 * One piece of the status line; `color` is a theme key or a raw color, absent for dim text,
 * and `href` makes it a link.
 */
export type StatusBarSpan = { text: string; color?: string; href?: string }

export type StatusBarSpans = readonly StatusBarSpan[] | null

declare module 'claude-code' {
  interface PluginState {
    'status-bar': { spans: StatusBarSpans }
  }
}
