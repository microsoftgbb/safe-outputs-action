import * as core from '@actions/core';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Minimal interface for search result items.
 * Compatible with what the GitHub Search API returns.
 */
export interface SearchIssue {
  number: number;
  html_url: string;
  title: string;
  pull_request?: unknown;
}

export interface LifecycleConfig {
  /** Normalized kebab-case identifier; empty string means disabled */
  workflowId: string;
  /** Auto-close previous issues with same marker */
  closeOlderIssues: boolean;
  /** Safety cap on closures (default 10) */
  closeOlderIssuesMax: number;
  /** Append to existing same-day issue instead of creating new */
  groupByDay: boolean;
}

/**
 * Normalize a workflow-id to kebab-case.
 *
 * - Lowercase
 * - Replace spaces and underscores with hyphens
 * - Strip characters that could break HTML comments (- - > <)
 * - Collapse multiple hyphens
 * - Trim leading/trailing hyphens
 * - Validate: non-empty, max 128 characters, alphanumeric + hyphens only after normalization
 *
 * Returns the normalized string, or null if the input is invalid.
 */
export function normalizeWorkflowId(raw: string): string | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  let normalized = raw.toLowerCase();

  // Replace spaces and underscores with hyphens
  normalized = normalized.replace(/[\s_]+/g, '-');

  // Strip characters unsafe for HTML comments (>, <) and the double-dash sequence
  normalized = normalized.replace(/[><]/g, '');

  // Keep only alphanumeric and hyphens
  normalized = normalized.replace(/[^a-z0-9-]/g, '');

  // Collapse multiple hyphens
  normalized = normalized.replace(/-{2,}/g, '-');

  // Trim leading/trailing hyphens
  normalized = normalized.replace(/^-+|-+$/g, '');

  // Validate: non-empty after normalization
  if (normalized.length === 0) {
    return null;
  }

  // Validate: max 128 characters
  if (normalized.length > 128) {
    return null;
  }

  return normalized;
}

/**
 * Append workflow-id marker to a body string.
 * Markers are HTML comments, invisible when rendered but searchable.
 */
export function embedMarker(body: string, workflowId: string): string {
  const marker = `\n\n<!-- safe-outputs-workflow-id: ${workflowId} -->`;
  return body + marker;
}

/**
 * Search for open issues containing the workflow-id marker.
 * Uses GitHub REST Search API with phrase matching.
 *
 * CRITICAL SAFETY: After search, filter results to exclude:
 * - Items that are actually PRs (check item.pull_request field)
 * - The excludeIssueNumber if provided (to skip the just-created issue)
 */
export async function findOlderIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowId: string,
  excludeIssueNumber?: number
): Promise<SearchIssue[]> {
  const query = `"safe-outputs-workflow-id: ${workflowId}" repo:${owner}/${repo} is:issue is:open in:body`;

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    sort: 'created',
    order: 'desc',
    per_page: 30,
  });

  // HARD GUARD: Filter out PRs (search API returns both despite is:issue)
  return data.items
    .filter((item) => !item.pull_request)
    .filter((item) => item.number !== excludeIssueNumber);
}

/**
 * Close older issues as "not_planned" with a linking comment.
 * Caps at max closures for safety.
 */
export async function closeOlderIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  olderIssues: SearchIssue[],
  newIssueUrl: string,
  max: number
): Promise<number> {
  const toClose = olderIssues.slice(0, max);
  let closed = 0;

  for (const issue of toClose) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `Superseded by ${newIssueUrl}. This issue was auto-closed because a newer report was created by the same workflow.`,
      });
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issue.number,
        state: 'closed',
        state_reason: 'not_planned',
      });
      closed++;
    } catch (error) {
      // Log but don't fail - closing older issues is best-effort
      core.warning(
        `Failed to close issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return closed;
}

/**
 * Search for an open issue created today (UTC) with the same workflow-id marker.
 * Returns the first match or null.
 */
export async function findTodayIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowId: string
): Promise<SearchIssue | null> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const query = `"safe-outputs-workflow-id: ${workflowId}" repo:${owner}/${repo} is:issue is:open created:${today} in:body`;

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    sort: 'created',
    order: 'desc',
    per_page: 5,
  });

  // HARD GUARD: Filter out PRs
  const issues = data.items.filter((item) => !item.pull_request);
  return issues.length > 0 ? issues[0] : null;
}
