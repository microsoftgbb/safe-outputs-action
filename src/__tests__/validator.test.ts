import { validateOutput, ValidationConstraints } from '../validator';
import { AgentOutput } from '../types';

const defaults: ValidationConstraints = {
  maxIssues: 1,
  maxComments: 3,
  maxPullRequests: 1,
  maxLabels: 5,
  titlePrefix: '[bot] ',
  allowedLabels: ['bug', 'auto-generated', 'cluster-doctor'],
};

describe('validateOutput', () => {
  it('passes valid output with all action types', () => {
    const output: AgentOutput = {
      actions: [
        { type: 'issue_comment', issue_number: 1, body: 'Analysis complete' },
        {
          type: 'create_issue',
          title: '[bot] Node pressure detected',
          body: 'Details here',
          labels: ['bug'],
        },
        { type: 'add_labels', issue_number: 1, labels: ['cluster-doctor'] },
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(true);
    expect(result.blocked).toHaveLength(0);
    expect(result.passed).toBe(3);
  });

  it('blocks unknown action types', () => {
    const output: AgentOutput = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: [{ type: 'delete_repo' } as any],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('Unknown action type');
  });

  it('blocks when issue count exceeds limit', () => {
    const output: AgentOutput = {
      actions: [
        { type: 'create_issue', title: '[bot] A', body: 'a' },
        { type: 'create_issue', title: '[bot] B', body: 'b' },
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain('Limit exceeded');
    expect(result.blocked[0].index).toBe(1);
  });

  it('blocks when comment count exceeds limit', () => {
    const output: AgentOutput = {
      actions: [
        { type: 'issue_comment', issue_number: 1, body: 'a' },
        { type: 'issue_comment', issue_number: 1, body: 'b' },
        { type: 'issue_comment', issue_number: 1, body: 'c' },
        { type: 'issue_comment', issue_number: 1, body: 'd' },
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].index).toBe(3);
  });

  it('blocks missing title prefix on issues', () => {
    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'No prefix here', body: 'Details' }],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('Title missing required prefix');
  });

  it('blocks missing title prefix on PRs', () => {
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_pull_request',
          title: 'Bad PR title',
          body: 'Details',
          head: 'fix/thing',
        },
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('Title missing required prefix');
  });

  it('blocks disallowed labels', () => {
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_issue',
          title: '[bot] Thing',
          body: 'Details',
          labels: ['bug', 'admin'],
        },
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('Disallowed labels: admin');
  });

  it('allows any labels when allowedLabels is empty', () => {
    const output: AgentOutput = {
      actions: [
        {
          type: 'create_issue',
          title: '[bot] Thing',
          body: 'Details',
          labels: ['anything', 'goes'],
        },
      ],
    };
    const result = validateOutput(output, { ...defaults, allowedLabels: [] });
    expect(result.valid).toBe(true);
  });

  it('skips title prefix check when prefix is empty', () => {
    const output: AgentOutput = {
      actions: [{ type: 'create_issue', title: 'Any title', body: 'Details' }],
    };
    const result = validateOutput(output, { ...defaults, titlePrefix: '' });
    expect(result.valid).toBe(true);
  });

  it('blocks missing required fields', () => {
    const output: AgentOutput = {
      actions: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'issue_comment', issue_number: 0, body: '' } as any,
      ],
    };
    const result = validateOutput(output, { ...defaults, titlePrefix: '' });
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('missing');
  });

  it('blocks create_pull_request missing head', () => {
    const output: AgentOutput = {
      actions: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'create_pull_request', title: '[bot] Fix', body: 'x' } as any,
      ],
    };
    const result = validateOutput(output, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('missing head');
  });

  it('handles null/undefined output gracefully', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateOutput(null as any, defaults);
    expect(result.valid).toBe(false);
    expect(result.blocked[0].reason).toContain('Missing or invalid');
  });

  it('handles missing actions array', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateOutput({} as any, defaults);
    expect(result.valid).toBe(false);
  });
});
