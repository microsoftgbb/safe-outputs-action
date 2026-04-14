import { sanitizeOutput } from '../sanitizer';
import { AgentOutput, IssueCommentAction } from '../types';

function makeOutput(body: string): AgentOutput {
  return { actions: [{ type: 'issue_comment', issue_number: 1, body }] };
}

function getBody(output: AgentOutput, index = 0): string {
  const action = output.actions[index] as IssueCommentAction;
  return action.body;
}

describe('sanitizeOutput', () => {
  it('redacts JWT tokens', () => {
    const output = makeOutput(
      'Found token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789'
    );
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('eyJ');
    expect(getBody(result.output)).toContain('[REDACTED]');
    expect(result.redactedCount).toBe(1);
  });

  it('redacts Azure connection strings', () => {
    const output = makeOutput(
      'Connection: DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123xyz'
    );
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('DefaultEndpointsProtocol');
    expect(result.redactedCount).toBe(1);
  });

  it('redacts GitHub PATs', () => {
    const output = makeOutput('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn');
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('ghp_');
    expect(result.redactedCount).toBe(1);
  });

  it('redacts private key blocks', () => {
    const output = makeOutput(
      'Key:\n-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg\n-----END PRIVATE KEY-----'
    );
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('BEGIN PRIVATE KEY');
    expect(result.redactedCount).toBe(1);
  });

  it('redacts bearer tokens', () => {
    const output = makeOutput(
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.long-token-value'
    );
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('Bearer eyJ');
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it('redacts generic key=value secrets', () => {
    const output = makeOutput('Config: password=SuperSecret123! api_key: abcdef12345');
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('SuperSecret123');
    expect(getBody(result.output)).not.toContain('abcdef12345');
    expect(result.redactedCount).toBe(1);
  });

  it('redacts AWS access keys', () => {
    const output = makeOutput('AWS key: AKIAIOSFODNN7EXAMPLE');
    const result = sanitizeOutput(output);
    expect(getBody(result.output)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.redactedCount).toBe(1);
  });

  it('applies custom regex patterns', () => {
    const output = makeOutput('Internal IP: 10.0.42.99 is the node');
    const result = sanitizeOutput(output, ['10\\.0\\.\\d+\\.\\d+']);
    expect(getBody(result.output)).not.toContain('10.0.42.99');
    expect(getBody(result.output)).toContain('[REDACTED]');
    expect(result.redactedCount).toBe(1);
  });

  it('skips invalid custom patterns without crashing', () => {
    const output = makeOutput('Normal text');
    const result = sanitizeOutput(output, ['[invalid(regex']);
    expect(result.redactedCount).toBe(0);
    expect(getBody(result.output)).toBe('Normal text');
  });

  it('does not mutate the original output', () => {
    const output = makeOutput('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn');
    const originalBody = (output.actions[0] as IssueCommentAction).body;
    sanitizeOutput(output);
    expect((output.actions[0] as IssueCommentAction).body).toBe(originalBody);
  });

  it('preserves clean content unchanged', () => {
    const output = makeOutput('Cluster is healthy. 3 nodes running, 42 pods scheduled.');
    const result = sanitizeOutput(output);
    expect(result.redactedCount).toBe(0);
    expect(getBody(result.output)).toBe('Cluster is healthy. 3 nodes running, 42 pods scheduled.');
  });

  it('sanitizes across multiple actions and fields', () => {
    const output: AgentOutput = {
      actions: [
        {
          type: 'issue_comment',
          issue_number: 1,
          body: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn',
        },
        {
          type: 'create_issue',
          title: 'Clean title',
          body: 'DefaultEndpointsProtocol=https;AccountName=prod;AccountKey=secret',
          labels: ['bug'],
        },
      ],
    };
    const result = sanitizeOutput(output);
    expect(result.redactedCount).toBe(2);
    expect(result.redactedFields).toContain('actions[0].body');
    expect(result.redactedFields).toContain('actions[1].body');
  });

  it('does not redact the type field', () => {
    const output: AgentOutput = {
      actions: [{ type: 'issue_comment', issue_number: 1, body: 'Clean' }],
    };
    const result = sanitizeOutput(output);
    expect(result.output.actions[0].type).toBe('issue_comment');
  });
});

describe('sanitizeOutput - files map', () => {
  it('redacts secrets inside PR file contents', () => {
    const output = {
      actions: [
        {
          type: 'create_pull_request' as const,
          title: 'Fix config',
          body: 'Clean body',
          head: 'fix/config',
          files: {
            'config.yaml': 'db_password=SuperSecret123!',
            'readme.md': 'Just a readme',
          },
        },
      ],
    };
    const result = sanitizeOutput(output);
    expect(result.redactedCount).toBe(1);
    expect(result.redactedFields).toContain('actions[0].files["config.yaml"]');
    const pr = result.output.actions[0] as any;
    expect(pr.files['config.yaml']).not.toContain('SuperSecret123');
    expect(pr.files['readme.md']).toBe('Just a readme');
  });

  it('redacts secrets in both body and files', () => {
    const output = {
      actions: [
        {
          type: 'create_pull_request' as const,
          title: 'Fix',
          body: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn',
          head: 'fix/thing',
          files: {
            '.env': 'API_KEY=AKIAIOSFODNN7EXAMPLE',
          },
        },
      ],
    };
    const result = sanitizeOutput(output);
    expect(result.redactedCount).toBe(2);
    expect(result.redactedFields).toContain('actions[0].body');
    expect(result.redactedFields).toContain('actions[0].files[".env"]');
  });
});
