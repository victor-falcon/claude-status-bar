import type { PluginOptions, SessionRateLimit } from 'claude-code'

import type { StatusBarSpan } from '../types'

export type PullRequestState = 'Merged' | 'Draft' | 'Open' | 'Closed'

export type ChecksSummary = { passed: number; failed: number; pending: number; total: number }

export type PullRequest = { state: PullRequestState; checks: ChecksSummary }

export type DiffSize = { added: number; removed: number }

export type Usage = { session?: number; week?: number }

export type StatusInfo = {
  branch?: string
  diff?: DiffSize
  pullRequest?: PullRequest
  usage: Usage
}

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun or a StatusContext. */
export type RollupEntry = {
  __typename?: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
}

export type GhPullRequest = {
  state: string
  isDraft: boolean
  statusCheckRollup?: RollupEntry[] | null
}

export type StatusSections = {
  branch: boolean
  diff: boolean
  pullRequest: boolean
  checks: boolean
  usage: boolean
}

export type StatusIcons = {
  branch: string
  diff: string
  pullRequest: string
  checksPassed: string
  checksFailed: string
  checksPending: string
  usage: string
}

export type StatusOptions = { show: StatusSections; icons: StatusIcons }

/** Nerd Font glyphs, written as code points so an editor or font that cannot draw them keeps them. */
const DEFAULT_ICONS: StatusIcons = {
  branch: '\u{EA64} ',
  diff: '',
  pullRequest: ' \u{E709}',
  checksPassed: ' \u{F012C}',
  checksFailed: ' \u{F467}',
  checksPending: ' \u{F051F}',
  usage: '',
}
const NO_ICON = 'none'

const COLOR_BRANCH = 'blue'
const COLOR_ADDED = 'green'
const COLOR_REMOVED = 'red'
const PULL_REQUEST_COLORS: Record<PullRequestState, string> = {
  Merged: 'magenta',
  Closed: 'red',
  Draft: 'gray',
  Open: 'green',
}
const COLOR_USAGE_WARNING = '#ff8700'
const COLOR_USAGE_CRITICAL = 'red'
const USAGE_WARNING_PERCENT = 65
const USAGE_CRITICAL_PERCENT = 75

const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

/** Sums the `git diff --numstat` output; binary files (`-\t-`) count as zero. */
export function parseNumstat(output: string): DiffSize {
  let added = 0
  let removed = 0

  for (const line of output.split('\n')) {
    const [addedText, removedText] = line.split('\t')
    added += Number.parseInt(addedText ?? '', 10) || 0
    removed += Number.parseInt(removedText ?? '', 10) || 0
  }

  return { added, removed }
}

function classifyCheck(entry: RollupEntry): 'passed' | 'failed' | 'pending' {
  if (entry.__typename === 'StatusContext' || (entry.status == null && entry.state != null)) {
    const state = entry.state ?? ''

    if (state === 'SUCCESS') {
      return 'passed'
    }

    return PENDING_STATES.has(state) ? 'pending' : 'failed'
  }

  if (entry.status !== 'COMPLETED') {
    return 'pending'
  }

  return PASSING_CONCLUSIONS.has(entry.conclusion ?? '') ? 'passed' : 'failed'
}

export function summarizeChecks(rollup: readonly RollupEntry[]): ChecksSummary {
  const summary: ChecksSummary = { passed: 0, failed: 0, pending: 0, total: rollup.length }

  for (const entry of rollup) {
    summary[classifyCheck(entry)] += 1
  }

  return summary
}

export function toPullRequest(pullRequest: GhPullRequest): PullRequest {
  const state: PullRequestState =
    pullRequest.state === 'MERGED'
      ? 'Merged'
      : pullRequest.state === 'CLOSED'
        ? 'Closed'
        : pullRequest.isDraft
          ? 'Draft'
          : 'Open'

  return { state, checks: summarizeChecks(pullRequest.statusCheckRollup ?? []) }
}

export function toUsage(rateLimits: readonly SessionRateLimit[]): Usage {
  const percentOf = (kind: string): number | undefined =>
    rateLimits.find(limit => limit.kind === kind)?.percentUsed

  return { session: percentOf('five_hour'), week: percentOf('seven_day') }
}

/**
 * Reads the mod's `userConfig` values. A missing section stays shown. An empty icon
 * draws its default, since Claude Code's install dialog shows text fields blank
 * whatever their default; `none` draws no icon.
 */
export function toStatusOptions(options: PluginOptions): StatusOptions {
  const isShown = (key: string): boolean => options[key] !== false
  const iconFor = (key: string, fallback: string): string => {
    const value = options[key]

    if (typeof value !== 'string' || value === '') {
      return fallback
    }

    return value.trim().toLowerCase() === NO_ICON ? '' : value
  }

  return {
    show: {
      branch: isShown('showBranch'),
      diff: isShown('showDiff'),
      pullRequest: isShown('showPullRequest'),
      checks: isShown('showChecks'),
      usage: isShown('showUsage'),
    },
    icons: {
      branch: iconFor('iconBranch', DEFAULT_ICONS.branch),
      diff: iconFor('iconDiff', DEFAULT_ICONS.diff),
      pullRequest: iconFor('iconPullRequest', DEFAULT_ICONS.pullRequest),
      checksPassed: iconFor('iconChecksPassed', DEFAULT_ICONS.checksPassed),
      checksFailed: iconFor('iconChecksFailed', DEFAULT_ICONS.checksFailed),
      checksPending: iconFor('iconChecksPending', DEFAULT_ICONS.checksPending),
      usage: iconFor('iconUsage', DEFAULT_ICONS.usage),
    },
  }
}

function formatChecks(checks: ChecksSummary, icons: StatusIcons): string {
  const icon =
    checks.failed > 0 ? icons.checksFailed : checks.pending > 0 ? icons.checksPending : icons.checksPassed

  return `${icon} ${checks.passed}/${checks.total}`
}

/** Orange from 65% and red from 75% of whichever window is fuller, judged on the percent shown. */
function usageColor(usage: Usage): string | undefined {
  const highest = Math.max(Math.round(usage.session ?? 0), Math.round(usage.week ?? 0))

  if (highest >= USAGE_CRITICAL_PERCENT) {
    return COLOR_USAGE_CRITICAL
  }

  return highest >= USAGE_WARNING_PERCENT ? COLOR_USAGE_WARNING : undefined
}

function formatUsage(usage: Usage, icons: StatusIcons): StatusBarSpan | undefined {
  if (usage.session === undefined) {
    return undefined
  }

  const week = usage.week === undefined ? '' : ` (Week ${Math.round(usage.week)}%)`
  const text = `${icons.usage}Session usage ${Math.round(usage.session)}%${week}`
  const color = usageColor(usage)

  return color === undefined ? { text } : { text, color }
}

function gitSegments(info: StatusInfo, { show, icons }: StatusOptions): StatusBarSpan[][] {
  const segments: StatusBarSpan[][] = []

  if (show.branch && info.branch !== undefined) {
    segments.push([{ text: icons.branch, color: COLOR_BRANCH }, { text: ` ${info.branch}` }])
  }

  if (show.diff && info.diff !== undefined && (info.diff.added > 0 || info.diff.removed > 0)) {
    segments.push([
      { text: icons.diff },
      { text: `+${info.diff.added}`, color: COLOR_ADDED },
      { text: '' },
      { text: `-${info.diff.removed}`, color: COLOR_REMOVED },
    ])
  }

  if (show.pullRequest && info.pullRequest !== undefined) {
    const color = PULL_REQUEST_COLORS[info.pullRequest.state]
    segments.push([{ text: `${icons.pullRequest} ${info.pullRequest.state}`, color }])
  }

  if (show.checks && info.pullRequest !== undefined && info.pullRequest.checks.total > 0) {
    segments.push([{ text: formatChecks(info.pullRequest.checks, icons) }])
  }

  return segments
}

function joinSpans(groups: StatusBarSpan[][], separator: string): StatusBarSpan[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [{ text: separator }, ...group]))
}

/** The line as colored spans; a span with no `color` is drawn dim, like the hint it follows. */
export function formatStatus(info: StatusInfo, options: StatusOptions): StatusBarSpan[] | undefined {
  const usage = options.show.usage ? formatUsage(info.usage, options.icons) : undefined
  const sections = [joinSpans(gitSegments(info, options), ' '), usage === undefined ? [] : [usage]].filter(
    section => section.length > 0,
  )

  return sections.length > 0 ? joinSpans(sections, ' · ') : undefined
}

export function spansToText(spans: readonly StatusBarSpan[] | undefined): string | undefined {
  return spans?.map(span => span.text).join('')
}
