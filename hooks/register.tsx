import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StatusBarSpans } from '../types'
import { formatStatus, parseNumstat, toPullRequest, toStatusOptions, toUsage } from './format'
import type { DiffSize, GhPullRequest, StatusInfo, StatusOptions } from './format'

const GIT_REFRESH_MS = 5_000
const PULL_REQUEST_REFRESH_MS = 60_000
const TOUCHES_PULL_REQUEST = /\bgh\s+pr\b|\bgit\s+(push|checkout|switch)\b/
const HINT_SEPARATOR = '  '

const statusSpans = atom({ plugin: 'status-bar', key: 'spans' } as const, null as StatusBarSpans)

const info: StatusInfo = { usage: {} }
const progress = { isRefreshingGit: false, isRefreshingPullRequest: false }
let lastLine: string | undefined
let defaultBranch: string | undefined
let statusOptions: StatusOptions = toStatusOptions({})

/** Stores the line for the PromptHint hook; writing it redraws the hint. */
async function paint($: EngineInterface): Promise<void> {
  const spans = formatStatus(info, statusOptions) ?? null
  const line = JSON.stringify(spans)

  if (line !== lastLine) {
    lastLine = line
    await update($, statusSpans, () => spans)
  }
}

async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5_000 })

  return exitCode === 0 ? stdout.trim() : undefined
}

async function readBranchAndDiff($: EngineInterface): Promise<boolean> {
  if ((await git($, ['rev-parse', '--show-toplevel'])) === undefined) {
    const wasInRepository = info.branch !== undefined
    info.branch = undefined
    info.diff = undefined
    info.pullRequest = undefined

    return wasInRepository
  }

  defaultBranch ??= (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'origin/main'

  const branch =
    (await git($, ['branch', '--show-current'])) || (await git($, ['rev-parse', '--short', 'HEAD']))
  const hasBranchChanged = branch !== info.branch

  info.branch = branch
  info.diff = statusOptions.show.diff ? await readDiff($, defaultBranch) : undefined

  if (hasBranchChanged) {
    info.pullRequest = undefined
  }

  return hasBranchChanged
}

/** Lines changed against the merge base with the default branch, uncommitted work included. */
async function readDiff($: EngineInterface, baseBranch: string): Promise<DiffSize | undefined> {
  const base = (await git($, ['merge-base', 'HEAD', baseBranch])) ?? 'HEAD'
  const numstat = await git($, ['diff', '--numstat', base])

  return numstat === undefined ? undefined : parseNumstat(numstat)
}

/** Reads branch and diff size; resolves whether the branch changed since the last read. */
async function refreshGit($: EngineInterface): Promise<boolean> {
  if (progress.isRefreshingGit) {
    return false
  }

  progress.isRefreshingGit = true

  try {
    return await readBranchAndDiff($)
  } catch (error) {
    $.ui.log(`status-bar: git failed: ${String(error)}`, { to: 'debug' })

    return false
  } finally {
    progress.isRefreshingGit = false
    await paint($)
  }
}

async function refreshPullRequest($: EngineInterface): Promise<void> {
  const branch = info.branch
  const isWanted = statusOptions.show.pullRequest || statusOptions.show.checks

  if (!isWanted || branch === undefined || `origin/${branch}` === defaultBranch || progress.isRefreshingPullRequest) {
    return
  }

  progress.isRefreshingPullRequest = true

  try {
    const { exitCode, stdout } = await $.process.run(
      ['gh', 'pr', 'view', '--json', 'state,isDraft,statusCheckRollup'],
      { timeoutMs: 15_000 },
    )

    if (info.branch === branch) {
      info.pullRequest = exitCode === 0 ? toPullRequest(JSON.parse(stdout) as GhPullRequest) : undefined
    }
  } catch (error) {
    $.ui.log(`status-bar: gh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    progress.isRefreshingPullRequest = false
    await paint($)
  }
}

async function refreshAll($: EngineInterface): Promise<void> {
  await refreshGit($)
  await refreshPullRequest($)
}

async function refreshGitThenPullRequestOnBranchChange($: EngineInterface): Promise<void> {
  if (await refreshGit($)) {
    await refreshPullRequest($)
  }
}

export const register: Register = (on, options) => {
  statusOptions = toStatusOptions(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    defaultBranch = undefined
    $.ui.status(undefined)
    info.usage = toUsage((await $.session.usage()).rateLimits)
    await paint($)

    $.clock.after(0, () => void refreshAll($))
    $.clock.every(GIT_REFRESH_MS, () => void refreshGitThenPullRequestOnBranchChange($))
    $.clock.every(PULL_REQUEST_REFRESH_MS, () => void refreshPullRequest($))

    return started
  })

  on('session.measure', async ($, e, next) => {
    info.usage = toUsage(e.rateLimits)
    await paint($)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)

    if (TOUCHES_PULL_REQUEST.test(e.command)) {
      $.clock.after(0, () => void refreshAll($))
    }

    return result
  })

  on('turn.complete', ($, e, next) => {
    $.clock.after(0, () => void refreshAll($))

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const spans = await read($, statusSpans)

    if (spans === null) {
      return next(e)
    }

    const engineHint = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        {engineHint}
        <Text wrap="truncate-end">
          <Text dimColor>{HINT_SEPARATOR}</Text>
          {spans.map(span =>
            span.color === undefined ? <Text dimColor>{span.text}</Text> : <Text color={span.color}>{span.text}</Text>,
          )}
        </Text>
      </Box>
    )
  })
}
