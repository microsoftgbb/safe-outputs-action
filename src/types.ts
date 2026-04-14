/**
 * Agent output schema.
 *
 * The AI agent produces a JSON file conforming to this schema.
 * The safe-outputs action validates, sanitizes, and applies it.
 */

export interface AgentOutput {
  /** Schema version (reserved for future use) */
  version?: string;
  /** Ordered list of actions the agent wants to perform */
  actions: AgentAction[];
}

export type AgentAction =
  | IssueCommentAction
  | CreateIssueAction
  | CreatePullRequestAction
  | AddLabelsAction;

export interface IssueCommentAction {
  type: 'issue_comment';
  issue_number: number;
  body: string;
}

export interface CreateIssueAction {
  type: 'create_issue';
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface CreatePullRequestAction {
  type: 'create_pull_request';
  title: string;
  body: string;
  /** Head branch name. Created automatically if files are provided. */
  head: string;
  /** Base branch (defaults to repo default branch) */
  base?: string;
  /**
   * Files to commit on the head branch.
   * Keys are file paths relative to the repo root.
   * Values are the full file contents.
   * When provided, the action creates the branch and commits these files
   * via the Git Data API before opening the PR.
   * When omitted, the branch must already exist.
   */
  files?: Record<string, string>;
  /** Commit message for file-based PRs (defaults to the PR title) */
  commit_message?: string;
}

export interface AddLabelsAction {
  type: 'add_labels';
  issue_number: number;
  labels: string[];
}

/** Supported action type strings */
export const ACTION_TYPES = [
  'issue_comment',
  'create_issue',
  'create_pull_request',
  'add_labels',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
