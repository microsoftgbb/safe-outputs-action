import { executeActions } from '../executor';
import { AgentOutput } from '../types';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  info: jest.fn(),
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
      issues: {
        createComment: jest.fn().mockResolvedValue({
          data: { html_url: 'https://github.com/test-owner/test-repo/issues/1#comment-1' },
        }),
        create: jest.fn().mockResolvedValue({
          data: { html_url: 'https://github.com/test-owner/test-repo/issues/2' },
        }),
        addLabels: jest.fn().mockResolvedValue({ data: {} }),
      },
      pulls: {
        create: jest.fn().mockResolvedValue({
          data: { html_url: 'https://github.com/test-owner/test-repo/pull/3' },
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

import * as github from '@actions/github';

describe('executeActions', () => {
  it('executes issue_comment', async () => {
    const octokit = createMockOctokit();
    const output: AgentOutput = {
      actions: [{ type: 'issue_comment', issue_number: 1, body: 'Hello' }],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 1,
      body: 'Hello',
    });
  });

  it('executes create_issue', async () => {
    const octokit = createMockOctokit();
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_issue',
          title: 'Test issue',
          body: 'Details',
          labels: ['bug'],
          assignees: ['alice'],
        },
      ],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    expect(octokit.rest.issues.create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test issue',
      body: 'Details',
      labels: ['bug'],
      assignees: ['alice'],
    });
  });

  it('executes create_pull_request without files', async () => {
    const octokit = createMockOctokit();
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_pull_request',
          title: 'Fix thing',
          body: 'Details',
          head: 'fix/thing',
          base: 'main',
        },
      ],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Fix thing',
      body: 'Details',
      head: 'fix/thing',
      base: 'main',
    });
    // Should NOT create branch when no files
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });

  it('executes create_pull_request with files', async () => {
    const octokit = createMockOctokit();
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_pull_request',
          title: 'Fix config',
          body: 'Details',
          head: 'fix/config',
          files: { 'config.yaml': 'key: value' },
          commit_message: 'fix: update config',
        },
      ],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    // Should create branch via Git Data API
    expect(octokit.rest.git.getRef).toHaveBeenCalled();
    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
    expect(octokit.rest.git.createTree).toHaveBeenCalled();
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fix: update config' })
    );
    expect(octokit.rest.git.createRef).toHaveBeenCalled();
    expect(octokit.rest.pulls.create).toHaveBeenCalled();
  });

  it('executes add_labels', async () => {
    const octokit = createMockOctokit();
    const output: AgentOutput = {
      actions: [{ type: 'add_labels', issue_number: 5, labels: ['triaged'] }],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 5,
      labels: ['triaged'],
    });
  });

  it('handles API errors gracefully', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.createComment.mockRejectedValue(new Error('403 Forbidden'));

    const output: AgentOutput = {
      actions: [{ type: 'issue_comment', issue_number: 1, body: 'Hello' }],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain('403 Forbidden');
  });

  it('executes multiple actions and reports mixed results', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.create.mockRejectedValue(new Error('Rate limited'));

    const output: AgentOutput = {
      actions: [
        { type: 'issue_comment', issue_number: 1, body: 'Hello' },
        { type: 'create_issue', title: 'New', body: 'Details' },
        { type: 'add_labels', issue_number: 1, labels: ['done'] },
      ],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[2].success).toBe(true);
  });

  it('updates branch when createRef fails (branch exists)', async () => {
    const octokit = createMockOctokit();
    octokit.rest.git.createRef.mockRejectedValue(new Error('Reference already exists'));

    const output: AgentOutput = {
      actions: [
        {
          type: 'create_pull_request',
          title: 'Fix',
          body: 'Details',
          head: 'fix/existing',
          files: { 'file.txt': 'content' },
        },
      ],
    };

    const result = await executeActions(octokit, github.context, output);

    expect(result.applied).toBe(1);
    expect(octokit.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/fix/existing', force: true })
    );
  });
});
