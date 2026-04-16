import {
  normalizeWorkflowId,
  embedMarker,
  findOlderIssues,
  closeOlderIssues,
  findTodayIssue,
} from '../lifecycle';
import { AgentOutput } from '../types';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

// Mock @actions/github
jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    ref: 'refs/heads/main',
  },
  getOctokit: jest.fn(),
}));

function createMockOctokit() {
  return {
    rest: {
      search: {
        issuesAndPullRequests: jest.fn(),
      },
      issues: {
        create: jest.fn(),
        update: jest.fn(),
        createComment: jest.fn(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── normalizeWorkflowId ───────────────────────────────────────────────────

describe('normalizeWorkflowId', () => {
  it('normalizes "Cluster Doctor" to "cluster-doctor"', () => {
    expect(normalizeWorkflowId('Cluster Doctor')).toBe('cluster-doctor');
  });

  it('normalizes underscores to hyphens', () => {
    expect(normalizeWorkflowId('my_workflow')).toBe('my-workflow');
  });

  it('collapses multiple hyphens', () => {
    expect(normalizeWorkflowId('test--workflow')).toBe('test-workflow');
  });

  it('strips HTML-unsafe characters (> and <)', () => {
    expect(normalizeWorkflowId('test>workflow')).toBe('testworkflow');
    expect(normalizeWorkflowId('test<workflow')).toBe('testworkflow');
    expect(normalizeWorkflowId('a>b<c')).toBe('abc');
  });

  it('returns null for empty string', () => {
    expect(normalizeWorkflowId('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeWorkflowId('   ')).toBeNull();
  });

  it('returns null for string with only special characters', () => {
    expect(normalizeWorkflowId('>><<')).toBeNull();
  });

  it('enforces max 128 character limit', () => {
    const longId = 'a'.repeat(129);
    expect(normalizeWorkflowId(longId)).toBeNull();
  });

  it('allows exactly 128 characters', () => {
    const exactId = 'a'.repeat(128);
    expect(normalizeWorkflowId(exactId)).toBe(exactId);
  });

  it('passes through already-kebab-case strings', () => {
    expect(normalizeWorkflowId('cluster-doctor')).toBe('cluster-doctor');
  });

  it('trims leading and trailing hyphens', () => {
    expect(normalizeWorkflowId('-leading')).toBe('leading');
    expect(normalizeWorkflowId('trailing-')).toBe('trailing');
    expect(normalizeWorkflowId('-both-')).toBe('both');
  });

  it('handles mixed special characters', () => {
    expect(normalizeWorkflowId('My Cool_Workflow--v2')).toBe('my-cool-workflow-v2');
  });

  it('strips non-alphanumeric characters (dots, slashes, etc)', () => {
    expect(normalizeWorkflowId('test.workflow/v1')).toBe('testworkflowv1');
  });
});

// ─── embedMarker ───────────────────────────────────────────────────────────

describe('embedMarker', () => {
  it('appends marker to body', () => {
    const result = embedMarker('Hello world', 'cluster-doctor');
    expect(result).toBe('Hello world\n\n<!-- safe-outputs-workflow-id: cluster-doctor -->');
  });

  it('produces a valid HTML comment', () => {
    const result = embedMarker('body', 'my-workflow');
    expect(result).toContain('<!-- safe-outputs-workflow-id: my-workflow -->');
  });

  it('works with empty body', () => {
    const result = embedMarker('', 'test');
    expect(result).toBe('\n\n<!-- safe-outputs-workflow-id: test -->');
  });

  it('works with body that already has trailing newlines', () => {
    const result = embedMarker('body\n\n', 'test');
    expect(result).toBe('body\n\n\n\n<!-- safe-outputs-workflow-id: test -->');
  });
});

// ─── findOlderIssues ───────────────────────────────────────────────────────

describe('findOlderIssues', () => {
  it('returns issues matching the marker', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 10, html_url: 'https://github.com/o/r/issues/10', title: 'Old report' },
          { number: 8, html_url: 'https://github.com/o/r/issues/8', title: 'Older report' },
        ],
      },
    });

    const results = await findOlderIssues(octokit, 'o', 'r', 'cluster-doctor');

    expect(results).toHaveLength(2);
    expect(results[0].number).toBe(10);
    expect(results[1].number).toBe(8);
  });

  it('filters out PRs (items with pull_request field)', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 10, html_url: 'url', title: 'Issue' },
          { number: 11, html_url: 'url', title: 'PR', pull_request: { url: 'pr-url' } },
          { number: 12, html_url: 'url', title: 'Another issue' },
        ],
      },
    });

    const results = await findOlderIssues(octokit, 'o', 'r', 'wf');

    expect(results).toHaveLength(2);
    expect(results.map((i) => i.number)).toEqual([10, 12]);
  });

  it('excludes the specified issue number', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 15, html_url: 'url', title: 'New issue' },
          { number: 10, html_url: 'url', title: 'Old issue' },
        ],
      },
    });

    const results = await findOlderIssues(octokit, 'o', 'r', 'wf', 15);

    expect(results).toHaveLength(1);
    expect(results[0].number).toBe(10);
  });

  it('returns empty array when no matches', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [] },
    });

    const results = await findOlderIssues(octokit, 'o', 'r', 'wf');

    expect(results).toHaveLength(0);
  });

  it('constructs the correct search query', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [] },
    });

    await findOlderIssues(octokit, 'my-org', 'my-repo', 'cluster-doctor');

    expect(octokit.rest.search.issuesAndPullRequests).toHaveBeenCalledWith({
      q: '"safe-outputs-workflow-id: cluster-doctor" repo:my-org/my-repo is:issue is:open in:body',
      sort: 'created',
      order: 'desc',
      per_page: 30,
    });
  });
});

// ─── closeOlderIssues ──────────────────────────────────────────────────────

describe('closeOlderIssues', () => {
  it('closes issues with comment and "not_planned" state', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.createComment.mockResolvedValue({ data: {} });
    octokit.rest.issues.update.mockResolvedValue({ data: {} });

    const olderIssues = [
      { number: 5, html_url: 'url5', title: 'Old #5' },
      { number: 3, html_url: 'url3', title: 'Old #3' },
    ];

    const closed = await closeOlderIssues(
      octokit,
      'o',
      'r',
      olderIssues,
      'https://github.com/o/r/issues/10',
      10
    );

    expect(closed).toBe(2);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    expect(octokit.rest.issues.update).toHaveBeenCalledTimes(2);

    // Verify first issue close
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 5,
      body: expect.stringContaining('https://github.com/o/r/issues/10'),
    });
    expect(octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 5,
      state: 'closed',
      state_reason: 'not_planned',
    });
  });

  it('respects max limit', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.createComment.mockResolvedValue({ data: {} });
    octokit.rest.issues.update.mockResolvedValue({ data: {} });

    const olderIssues = [
      { number: 1, html_url: 'url', title: 'Issue 1' },
      { number: 2, html_url: 'url', title: 'Issue 2' },
      { number: 3, html_url: 'url', title: 'Issue 3' },
    ];

    const closed = await closeOlderIssues(octokit, 'o', 'r', olderIssues, 'new-url', 2);

    expect(closed).toBe(2);
    expect(octokit.rest.issues.update).toHaveBeenCalledTimes(2);
    // Should only close issues #1 and #2, not #3
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 1 })
    );
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 2 })
    );
  });

  it('continues on individual close failure (best-effort)', async () => {
    const core = jest.requireMock('@actions/core');
    const octokit = createMockOctokit();

    // First issue fails, second succeeds
    octokit.rest.issues.createComment
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce({ data: {} });
    octokit.rest.issues.update.mockResolvedValue({ data: {} });

    const olderIssues = [
      { number: 1, html_url: 'url', title: 'Issue 1' },
      { number: 2, html_url: 'url', title: 'Issue 2' },
    ];

    const closed = await closeOlderIssues(octokit, 'o', 'r', olderIssues, 'new-url', 10);

    expect(closed).toBe(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('#1'));
  });

  it('comment includes link to new issue', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.createComment.mockResolvedValue({ data: {} });
    octokit.rest.issues.update.mockResolvedValue({ data: {} });

    const newUrl = 'https://github.com/org/repo/issues/99';
    await closeOlderIssues(
      octokit,
      'o',
      'r',
      [{ number: 1, html_url: 'url', title: 'Old' }],
      newUrl,
      10
    );

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(newUrl),
      })
    );
  });
});

// ─── findTodayIssue ────────────────────────────────────────────────────────

describe('findTodayIssue', () => {
  it("returns today's issue when found", async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ number: 42, html_url: 'url42', title: 'Daily report' }],
      },
    });

    const result = await findTodayIssue(octokit, 'o', 'r', 'daily-report');

    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
  });

  it('returns null when no match', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [] },
    });

    const result = await findTodayIssue(octokit, 'o', 'r', 'daily-report');

    expect(result).toBeNull();
  });

  it('filters out PRs', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 50, html_url: 'url', title: 'PR', pull_request: { url: 'pr-url' } },
        ],
      },
    });

    const result = await findTodayIssue(octokit, 'o', 'r', 'wf');

    expect(result).toBeNull();
  });

  it('uses correct UTC date in query', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [] },
    });

    const today = new Date().toISOString().slice(0, 10);
    await findTodayIssue(octokit, 'o', 'r', 'wf');

    const call = octokit.rest.search.issuesAndPullRequests.mock.calls[0][0];
    expect(call.q).toContain(`created:${today}`);
  });

  it('returns the first issue when multiple found', async () => {
    const octokit = createMockOctokit();
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 20, html_url: 'url20', title: 'First' },
          { number: 18, html_url: 'url18', title: 'Second' },
        ],
      },
    });

    const result = await findTodayIssue(octokit, 'o', 'r', 'wf');

    expect(result!.number).toBe(20);
  });
});

// ─── Integration-style tests (executor + lifecycle) ────────────────────────

describe('executor lifecycle integration', () => {
  // Import executor after mocks are set up
  let executeActions: typeof import('../executor').executeActions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let github: any;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const executor = require('../executor');
    executeActions = executor.executeActions;
    github = jest.requireMock('@actions/github');
  });

  function createFullMockOctokit() {
    return {
      rest: {
        search: {
          issuesAndPullRequests: jest.fn().mockResolvedValue({
            data: { items: [] },
          }),
        },
        issues: {
          create: jest.fn().mockResolvedValue({
            data: {
              html_url: 'https://github.com/o/r/issues/100',
              number: 100,
            },
          }),
          update: jest.fn().mockResolvedValue({ data: {} }),
          createComment: jest.fn().mockResolvedValue({
            data: {
              html_url: 'https://github.com/o/r/issues/100#comment-1',
            },
          }),
          addLabels: jest.fn().mockResolvedValue({ data: {} }),
        },
        pulls: {
          create: jest.fn().mockResolvedValue({
            data: { html_url: 'https://github.com/o/r/pull/5' },
          }),
        },
        git: {
          getRef: jest.fn().mockResolvedValue({
            data: { object: { sha: 'abc123' } },
          }),
          getCommit: jest.fn().mockResolvedValue({
            data: { tree: { sha: 'tree123' } },
          }),
          createBlob: jest.fn().mockResolvedValue({
            data: { sha: 'blob123' },
          }),
          createTree: jest.fn().mockResolvedValue({
            data: { sha: 'newtree123' },
          }),
          createCommit: jest.fn().mockResolvedValue({
            data: { sha: 'newcommit123' },
          }),
          createRef: jest.fn().mockResolvedValue({ data: {} }),
          updateRef: jest.fn().mockResolvedValue({ data: {} }),
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('embeds marker in create_issue body when workflowId is set', async () => {
    const octokit = createFullMockOctokit();
    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'Report', body: 'Details' }],
    };
    const config = {
      workflowId: 'cluster-doctor',
      closeOlderIssues: false,
      closeOlderIssuesMax: 10,
      groupByDay: false,
    };

    await executeActions(octokit, github.context, output, config);

    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('<!-- safe-outputs-workflow-id: cluster-doctor -->'),
      })
    );
  });

  it('embeds marker in issue_comment body when workflowId is set', async () => {
    const octokit = createFullMockOctokit();
    const output: AgentOutput = {
      actions: [{ type: 'issue_comment', issue_number: 1, body: 'Comment text' }],
    };
    const config = {
      workflowId: 'my-workflow',
      closeOlderIssues: false,
      closeOlderIssuesMax: 10,
      groupByDay: false,
    };

    await executeActions(octokit, github.context, output, config);

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('<!-- safe-outputs-workflow-id: my-workflow -->'),
      })
    );
  });

  it('embeds marker in create_pull_request body when workflowId is set', async () => {
    const octokit = createFullMockOctokit();
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_pull_request',
          title: 'Fix',
          body: 'PR body',
          head: 'fix/thing',
          base: 'main',
        },
      ],
    };
    const config = {
      workflowId: 'pr-workflow',
      closeOlderIssues: false,
      closeOlderIssuesMax: 10,
      groupByDay: false,
    };

    await executeActions(octokit, github.context, output, config);

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('<!-- safe-outputs-workflow-id: pr-workflow -->'),
      })
    );
  });

  it('create_issue with close-older-issues: finds and closes older issues', async () => {
    const octokit = createFullMockOctokit();

    // Search returns older issues
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 5, html_url: 'https://github.com/o/r/issues/5', title: 'Old' },
        ],
      },
    });

    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'New Report', body: 'Latest' }],
    };
    const config = {
      workflowId: 'cluster-doctor',
      closeOlderIssues: true,
      closeOlderIssuesMax: 10,
      groupByDay: false,
    };

    const result = await executeActions(octokit, github.context, output, config);

    expect(result.applied).toBe(1);
    // New issue was created
    expect(octokit.rest.issues.create).toHaveBeenCalled();
    // Older issue was closed
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        state: 'closed',
        state_reason: 'not_planned',
      })
    );
    // Comment was added to older issue
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        body: expect.stringContaining('Superseded by'),
      })
    );
  });

  it('create_issue with group-by-day: appends to existing same-day issue', async () => {
    const octokit = createFullMockOctokit();

    // findTodayIssue returns an existing issue
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { number: 42, html_url: 'https://github.com/o/r/issues/42', title: 'Daily' },
        ],
      },
    });

    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'New Finding', body: 'Details here' }],
    };
    const config = {
      workflowId: 'daily-scan',
      closeOlderIssues: false,
      closeOlderIssuesMax: 10,
      groupByDay: true,
    };

    const result = await executeActions(octokit, github.context, output, config);

    expect(result.applied).toBe(1);
    // Should NOT create a new issue
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    // Should append as comment to existing issue
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining('New Finding'),
      })
    );
  });

  it('create_issue with group-by-day: falls back to create when no existing issue', async () => {
    const octokit = createFullMockOctokit();

    // No existing today issue
    octokit.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: { items: [] },
    });

    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'New Finding', body: 'Details' }],
    };
    const config = {
      workflowId: 'daily-scan',
      closeOlderIssues: false,
      closeOlderIssuesMax: 10,
      groupByDay: true,
    };

    const result = await executeActions(octokit, github.context, output, config);

    expect(result.applied).toBe(1);
    // Should create a new issue since no existing one found
    expect(octokit.rest.issues.create).toHaveBeenCalled();
  });

  it('does not embed markers when no lifecycleConfig provided', async () => {
    const octokit = createFullMockOctokit();
    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'Report', body: 'Details' }],
    };

    await executeActions(octokit, github.context, output);

    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Details',
      })
    );
  });
});
