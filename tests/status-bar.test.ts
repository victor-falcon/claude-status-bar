import type { On, ProcessRunResult, RenderElement, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  formatStatus,
  parseNumstat,
  spansToText,
  summarizeChecks,
  toPullRequest,
  toStatusOptions,
} from '../hooks/format'
import type { StatusInfo, StatusOptions } from '../hooks/format'

const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const failed: ProcessRunResult = { ...ok(''), exitCode: 1 }

const PULL_REQUEST_URL = 'https://github.com/acme/app/pull/42'

const PULL_REQUEST = JSON.stringify({
  number: 42,
  url: PULL_REQUEST_URL,
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ],
})

const HINT: RenderPropsOf['PromptHint'] = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

const FEATURE_BRANCH: StatusInfo = {
  branch: 'feat/x',
  diff: { added: 45, removed: 12 },
  pullRequest: { number: 42, url: PULL_REQUEST_URL, state: 'Open', checks: { passed: 5, failed: 0, pending: 0, total: 5 } },
  usage: { session: 23.4, week: 40.6 },
}

/** Every section shown with its default icons: what missing options fall back to. */
const ALL_SECTIONS = toStatusOptions({})

/** Text without its Nerd Font icons and spacing, which are styling. */
function words(text: string | undefined): string | undefined {
  return text
    ?.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The line's words in order. */
function plain(info: StatusInfo, options: StatusOptions = ALL_SECTIONS): string | undefined {
  return words(spansToText(formatStatus(info, options)))
}

/** The color of the span whose text includes `text`. */
function colorOf(info: StatusInfo, text: string): string | undefined {
  return formatStatus(info, ALL_SECTIONS)?.find(span => span.text.includes(text))?.color
}

/** Answers git and gh the way a feature branch with an open PR would; the hint stands in for the engine's. */
function stubWorld(on: On, branch: string, commands: string[] = []): void {
  on('process.run', ($, e) => {
    const command = e.argv.join(' ')
    commands.push(command)

    if (command === 'gh pr view --json number,url,state,isDraft,statusCheckRollup') {
      return { value: ok(PULL_REQUEST) }
    }

    const answers: Record<string, ProcessRunResult> = {
      'git rev-parse --show-toplevel': ok('/repo\n'),
      'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
      'git branch --show-current': ok(`${branch}\n`),
      'git merge-base HEAD origin/main': ok('abc123\n'),
      'git diff --numstat abc123': ok('40\t10\tapp/Foo.php\n5\t2\tresources/js/foo.tsx\n-\t-\tlogo.png\n'),
    }

    return { value: answers[command] ?? failed }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.4 },
        { kind: 'seven_day', percentUsed: 40.6 },
      ],
    },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => h('Text', null, e.props.hint) as RenderElement)
}

async function startSession($: Engine, on: On): Promise<void> {
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
}

describe('format', () => {
  test('sums numstat lines and skips binary files', () => {
    expect(parseNumstat('40\t10\ta\n5\t2\tb\n-\t-\tc.png\n')).toEqual({ added: 45, removed: 12 })
  })

  test('counts skipped and neutral checks as passed, running ones as pending', () => {
    expect(
      summarizeChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'StatusContext', state: 'PENDING' },
        { __typename: 'StatusContext', state: 'ERROR' },
      ]),
    ).toEqual({ passed: 2, failed: 1, pending: 2, total: 5 })
  })

  test('maps the PR state, draft included', () => {
    const pullRequest = { number: 42, url: PULL_REQUEST_URL }

    expect(toPullRequest({ ...pullRequest, state: 'OPEN', isDraft: true }).state).toBe('Draft')
    expect(toPullRequest({ ...pullRequest, state: 'MERGED', isDraft: false }).state).toBe('Merged')
    expect(toPullRequest({ ...pullRequest, state: 'CLOSED', isDraft: false }).state).toBe('Closed')
    expect(toPullRequest({ ...pullRequest, state: 'OPEN', isDraft: false }).state).toBe('Open')
  })

  test('draws every segment in order', () => {
    expect(plain(FEATURE_BRANCH)).toBe('feat/x +45-12 #42 (Open) 5/5 · Session usage 23% (Week 41%)')
  })

  test('links the PR number and state to the PR', () => {
    const links = formatStatus(FEATURE_BRANCH, ALL_SECTIONS)?.filter(span => span.href !== undefined)

    expect(links).toEqual([{ text: '#42 (Open)', href: PULL_REQUEST_URL, color: 'green' }])
  })

  test('leaves out what it does not know', () => {
    expect(plain({ branch: 'main', diff: { added: 0, removed: 0 }, usage: {} })).toBe('main')
    expect(plain({ usage: { session: 7 } })).toBe('Session usage 7%')
    expect(formatStatus({ usage: {} }, ALL_SECTIONS)).toBeUndefined()
  })
})

describe('options', () => {
  test('hides the sections switched off', () => {
    expect(plain(FEATURE_BRANCH, toStatusOptions({ showDiff: false, showUsage: false }))).toBe('feat/x #42 (Open) 5/5')
    expect(plain(FEATURE_BRANCH, toStatusOptions({ showPullRequest: false }))).not.toMatch(/Open|#42/)
    expect(plain(FEATURE_BRANCH, toStatusOptions({ showPullRequest: false }))).toContain('5/5')
    expect(plain(FEATURE_BRANCH, toStatusOptions({ showBranch: false, showChecks: false }))).not.toMatch(/feat\/x|5\/5/)
  })

  test('draws the configured icons', () => {
    const line = spansToText(
      formatStatus(FEATURE_BRANCH, toStatusOptions({ iconBranch: 'B>', iconPullRequest: 'PR>', iconChecksPassed: 'OK>' })),
    )

    expect(line?.startsWith('B> feat/x')).toBe(true)
    expect(line).toContain('PR> #42 (Open)')
    expect(line).toContain('OK> 5/5')
  })

  test('draws the default icon for an empty one, and no icon for none', () => {
    const branchIcon = (iconBranch: string): string | undefined =>
      formatStatus(FEATURE_BRANCH, toStatusOptions({ iconBranch }))?.[0]?.text

    expect(branchIcon('')).toBe('\u{EA64} ')
    expect(branchIcon('none')).toBe('')
    expect(branchIcon(' None ')).toBe('')
    expect(branchIcon(' ')).toBe(' ')
  })

  test('draws the default icons when the options are left at their defaults', async ($, on) => {
    stubWorld(on, 'feat/status-bar')
    await startSession($, on)

    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props: HINT })

    expect((await ui.find({ type: 'Text', text: /^\u{EA64}\s*$/u }))?.props.color).toBe('blue')
    expect(await ui.find({ type: 'Text', text: /\u{F467} 3\/4 ·/u })).toBeDefined()
  })
})

describe('colors', () => {
  test('colors the diff green for added lines and red for removed ones', () => {
    expect(colorOf(FEATURE_BRANCH, '+45')).toBe('green')
    expect(colorOf(FEATURE_BRANCH, '-12')).toBe('red')
    expect(colorOf(FEATURE_BRANCH, 'feat/x')).toBeUndefined()
    expect(formatStatus(FEATURE_BRANCH, ALL_SECTIONS)?.[0]?.color).toBeDefined()
  })

  test('colors the PR state by what happened to it', () => {
    const colorFor = (state: 'Merged' | 'Closed' | 'Draft' | 'Open'): string | undefined =>
      colorOf(
        {
          ...FEATURE_BRANCH,
          pullRequest: { number: 42, url: PULL_REQUEST_URL, state, checks: { passed: 0, failed: 0, pending: 0, total: 0 } },
        },
        state,
      )

    expect(colorFor('Merged')).toBe('magenta')
    expect(colorFor('Closed')).toBe('red')
    expect(colorFor('Draft')).toBe('gray')
    expect(colorFor('Open')).toBe('green')
  })

  test('colors the passed checks green when all passed, red when any failed, dim while some run', () => {
    const passedColor = (checks: { passed: number; failed: number; pending: number; total: number }) =>
      formatStatus({ ...FEATURE_BRANCH, pullRequest: { ...FEATURE_BRANCH.pullRequest!, checks } }, ALL_SECTIONS)?.find(
        span => span.text === `${checks.passed}`,
      )?.color

    expect(passedColor({ passed: 5, failed: 0, pending: 0, total: 5 })).toBe('green')
    expect(passedColor({ passed: 3, failed: 1, pending: 0, total: 4 })).toBe('red')
    expect(passedColor({ passed: 3, failed: 1, pending: 1, total: 5 })).toBe('red')
    expect(passedColor({ passed: 2, failed: 0, pending: 1, total: 3 })).toBeUndefined()
  })

  test('keeps the usage dim until either window nears its limit', () => {
    const usageColor = (session: number, week: number): string | undefined =>
      colorOf({ usage: { session, week } }, 'Session usage')

    expect(usageColor(64.4, 30)).toBeUndefined()
    expect(usageColor(64.6, 30)).toBe('#ff8700')
    expect(usageColor(10, 70)).toBe('#ff8700')
    expect(usageColor(75, 10)).toBe('red')
    expect(usageColor(40, 90)).toBe('red')
  })
})

describe('prompt hint', () => {
  test('is left alone until there is something to show', async ($, on) => {
    stubWorld(on, 'main')

    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props: HINT })

    expect((await ui.find({ type: 'Text', text: '? for shortcuts' }))?.text).toBe('? for shortcuts')
    expect(await ui.find({ text: /Session usage/ })).toBeUndefined()
  })

  test('draws branch, diff, PR, CI and usage after the engine hint, in color', async ($, on) => {
    stubWorld(on, 'feat/status-bar')
    await startSession($, on)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'status-bar', surface, component: 'PromptHint', props: HINT })

      expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
      expect(words((await ui.find({ type: 'Text', text: /feat\/status-bar.*Session usage 23%/ }))?.text)).toBe(
        plain({
          branch: 'feat/status-bar',
          diff: { added: 45, removed: 12 },
          pullRequest: {
            number: 42,
            url: PULL_REQUEST_URL,
            state: 'Open',
            checks: { passed: 3, failed: 1, pending: 0, total: 4 },
          },
          usage: { session: 23.4, week: 40.6 },
        }),
      )
      expect((await ui.find({ type: 'Text', text: /^\+45$/ }))?.props.color).toBe('green')
      expect((await ui.find({ type: 'Text', text: /^-12$/ }))?.props.color).toBe('red')
      expect((await ui.find({ type: 'Text', text: /^#42 \(Open\)$/ }))?.props.color).toBe('green')
      expect((await ui.find({ type: 'Link', text: '#42 (Open)' }))?.props.href).toBe(PULL_REQUEST_URL)
      expect((await ui.find({ type: 'Text', text: /^3$/ }))?.props.color).toBe('red')
      await ui.unmount()
    }
  })

  test('turns the usage red when a measurement crosses 75%', async ($, on) => {
    stubWorld(on, 'main')
    await startSession($, on)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 81 },
        { kind: 'seven_day', percentUsed: 55 },
      ],
      changed: ['rateLimits'],
    })

    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props: HINT })
    const usage = await ui.find({ type: 'Text', text: /^\S*\s*Session usage 81% \(Week 55%\)$/ })

    expect(usage?.props.color).toBe('red')
  })

  test(
    'skips gh and git diff when their sections are off',
    { options: { showDiff: false, showPullRequest: false, showChecks: false } },
    async ($, on) => {
      const commands: string[] = []
      stubWorld(on, 'feat/status-bar', commands)
      await startSession($, on)

      const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props: HINT })
      const line = words((await ui.find({ type: 'Text', text: /feat\/status-bar/ }))?.text)

      expect(commands.some(command => command.startsWith('gh ') || command.startsWith('git diff'))).toBe(false)
      expect(line).toBe('feat/status-bar · Session usage 23% (Week 41%)')
    },
  )
})
