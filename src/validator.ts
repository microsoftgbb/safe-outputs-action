import { AgentOutput, AgentAction, ACTION_TYPES, ActionType } from './types';

export interface ValidationConstraints {
  maxIssues: number;
  maxComments: number;
  maxPullRequests: number;
  maxLabels: number;
  titlePrefix: string;
  allowedLabels: string[];
}

export interface BlockedAction {
  index: number;
  type: string;
  reason: string;
}

export interface ValidationResult {
  valid: boolean;
  blocked: BlockedAction[];
  passed: number;
}

const LIMITS_MAP: Record<ActionType, keyof ValidationConstraints> = {
  create_issue: 'maxIssues',
  issue_comment: 'maxComments',
  create_pull_request: 'maxPullRequests',
  add_labels: 'maxLabels',
};

export function validateOutput(
  output: AgentOutput,
  constraints: ValidationConstraints
): ValidationResult {
  const blocked: BlockedAction[] = [];
  const counts: Record<string, number> = {};

  if (!output || !Array.isArray(output.actions)) {
    return {
      valid: false,
      blocked: [{ index: -1, type: 'unknown', reason: 'Missing or invalid "actions" array' }],
      passed: 0,
    };
  }

  for (let i = 0; i < output.actions.length; i++) {
    const action = output.actions[i];
    const blockReason = validateAction(action, i, counts, constraints);
    if (blockReason) {
      blocked.push({ index: i, type: action?.type ?? 'unknown', reason: blockReason });
    }
  }

  return {
    valid: blocked.length === 0,
    blocked,
    passed: output.actions.length - blocked.length,
  };
}

function validateAction(
  action: AgentAction,
  index: number,
  counts: Record<string, number>,
  constraints: ValidationConstraints
): string | null {
  // Known type check
  if (!action?.type || !ACTION_TYPES.includes(action.type as ActionType)) {
    return `Unknown action type: "${action?.type}"`;
  }

  // Count limits
  const limitKey = LIMITS_MAP[action.type as ActionType];
  const limit = constraints[limitKey] as number;
  counts[action.type] = (counts[action.type] || 0) + 1;
  if (counts[action.type] > limit) {
    return `Limit exceeded for "${action.type}": max ${limit}, got ${counts[action.type]}`;
  }

  // Title prefix (applies to create_issue and create_pull_request)
  if (constraints.titlePrefix) {
    if (action.type === 'create_issue' || action.type === 'create_pull_request') {
      if (!action.title?.startsWith(constraints.titlePrefix)) {
        return `Title missing required prefix "${constraints.titlePrefix}": "${action.title}"`;
      }
    }
  }

  // Label allowlist
  if (constraints.allowedLabels.length > 0) {
    const labels = getLabels(action);
    if (labels.length > 0) {
      const disallowed = labels.filter((l) => !constraints.allowedLabels.includes(l));
      if (disallowed.length > 0) {
        return `Disallowed labels: ${disallowed.join(', ')}`;
      }
    }
  }

  // Required fields
  return validateRequiredFields(action);
}

function getLabels(action: AgentAction): string[] {
  if (action.type === 'create_issue' || action.type === 'add_labels') {
    return action.labels ?? [];
  }
  return [];
}

function validateRequiredFields(action: AgentAction): string | null {
  switch (action.type) {
    case 'issue_comment':
      if (!action.issue_number) return 'issue_comment: missing issue_number';
      if (!action.body) return 'issue_comment: missing body';
      break;
    case 'create_issue':
      if (!action.title) return 'create_issue: missing title';
      if (!action.body) return 'create_issue: missing body';
      break;
    case 'create_pull_request':
      if (!action.title) return 'create_pull_request: missing title';
      if (!action.body) return 'create_pull_request: missing body';
      if (!action.head) return 'create_pull_request: missing head branch';
      break;
    case 'add_labels':
      if (!action.issue_number) return 'add_labels: missing issue_number';
      if (!action.labels || action.labels.length === 0) return 'add_labels: missing labels';
      break;
  }
  return null;
}
