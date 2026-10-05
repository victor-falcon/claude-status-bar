import type { SessionRateLimit } from 'claude-code'

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

const ICON_BRANCH = ' '
const ICON_DIFF = ''
const ICON_PULL_REQUEST = ' '
const ICON_CHECKS_PASSED = ' 󰄬'
const ICON_CHECKS_FAILED = ' '
const ICON_CHECKS_PENDING = ' 󰔟'
const ICON_USAGE = ''

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

function formatChecks(checks: ChecksSummary): string {
  const icon =
    checks.failed > 0
      ? ICON_CHECKS_FAILED
      : checks.pending > 0
        ? ICON_CHECKS_PENDING
        : ICON_CHECKS_PASSED

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

function formatUsage(usage: Usage): StatusBarSpan | undefined {
  if (usage.session === undefined) {
    return undefined
  }

  const week = usage.week === undefined ? '' : ` (Week ${Math.round(usage.week)}%)`
  const text = `${ICON_USAGE}Session usage ${Math.round(usage.session)}%${week}`
  const color = usageColor(usage)

  return color === undefined ? { text } : { text, color }
}

function gitSegments(info: StatusInfo): StatusBarSpan[][] {
  const segments: StatusBarSpan[][] = []

  if (info.branch !== undefined) {
    segments.push([{ text: ICON_BRANCH, color: COLOR_BRANCH }, { text: ` ${info.branch}` }])
  }

  if (info.diff !== undefined && (info.diff.added > 0 || info.diff.removed > 0)) {
    segments.push([
      { text: `${ICON_DIFF}` },
      { text: `+${info.diff.added}`, color: COLOR_ADDED },
      { text: '' },
      { text: `-${info.diff.removed}`, color: COLOR_REMOVED },
    ])
  }

  if (info.pullRequest !== undefined) {
    const color = PULL_REQUEST_COLORS[info.pullRequest.state]
    segments.push([{ text: `${ICON_PULL_REQUEST} ${info.pullRequest.state}`, color }])

    if (info.pullRequest.checks.total > 0) {
      segments.push([{ text: formatChecks(info.pullRequest.checks) }])
    }
  }

  return segments
}

function joinSpans(groups: StatusBarSpan[][], separator: string): StatusBarSpan[] {
  return groups.flatMap((group, index) => (index === 0 ? group : [{ text: separator }, ...group]))
}

/** The line as colored spans; a span with no `color` is drawn dim, like the hint it follows. */
export function formatStatus(info: StatusInfo): StatusBarSpan[] | undefined {
  const usage = formatUsage(info.usage)
  const sections = [joinSpans(gitSegments(info), ' '), usage === undefined ? [] : [usage]].filter(
    section => section.length > 0,
  )

  return sections.length > 0 ? joinSpans(sections, ' · ') : undefined
}

export function spansToText(spans: readonly StatusBarSpan[] | undefined): string | undefined {
  return spans?.map(span => span.text).join('')
}
