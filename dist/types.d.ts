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
export type AgentAction = IssueCommentAction | CreateIssueAction | CreatePullRequestAction | AddLabelsAction;
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
    /** Head branch (must already exist) */
    head: string;
    /** Base branch (defaults to repo default branch) */
    base?: string;
}
export interface AddLabelsAction {
    type: 'add_labels';
    issue_number: number;
    labels: string[];
}
/** Supported action type strings */
export declare const ACTION_TYPES: readonly ["issue_comment", "create_issue", "create_pull_request", "add_labels"];
export type ActionType = (typeof ACTION_TYPES)[number];
