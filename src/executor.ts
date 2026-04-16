import * as core from '@actions/core';
import * as github from '@actions/github';
import { AgentOutput, AgentAction, CreatePullRequestAction } from './types';
import {
  LifecycleConfig,
  embedMarker,
  findOlderIssues,
  closeOlderIssues,
  findTodayIssue,
} from './lifecycle';

type Octokit = ReturnType<typeof github.getOctokit>;
type Context = typeof github.context;

export interface ActionResult {
  index: number;
  type: string;
  success: boolean;
  url?: string;
  error?: string;
}

export interface ExecutionResult {
  applied: number;
  failed: number;
  results: ActionResult[];
}

export async function executeActions(
  octokit: Octokit,
  context: Context,
  output: AgentOutput,
  lifecycleConfig?: LifecycleConfig
): Promise<ExecutionResult> {
  const results: ActionResult[] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < output.actions.length; i++) {
    const action = output.actions[i];
    try {
      const url = await applyAction(octokit, context, action, lifecycleConfig);
      results.push({ index: i, type: action.type, success: true, url });
      applied++;
      core.info(`[${i}] ${action.type} -> ${url}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ index: i, type: action.type, success: false, error: msg });
      failed++;
      core.error(`[${i}] ${action.type} FAILED: ${msg}`);
    }
  }

  return { applied, failed, results };
}

async function applyAction(
  octokit: Octokit,
  context: Context,
  action: AgentAction,
  lifecycleConfig?: LifecycleConfig
): Promise<string> {
  const { owner, repo } = context.repo;
  const wfId = lifecycleConfig?.workflowId;

  switch (action.type) {
    case 'issue_comment': {
      const body = wfId ? embedMarker(action.body, wfId) : action.body;
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: action.issue_number,
        body,
      });
      return data.html_url;
    }

    case 'create_issue': {
      const body = wfId ? embedMarker(action.body, wfId) : action.body;

      // Group-by-day: append to existing same-day issue if found
      if (wfId && lifecycleConfig?.groupByDay) {
        const todayIssue = await findTodayIssue(octokit, owner, repo, wfId);
        if (todayIssue) {
          core.info(
            `group-by-day: found existing issue #${todayIssue.number}, appending as comment`
          );
          const { data: comment } = await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: todayIssue.number,
            body: `## ${action.title}\n\n${body}`,
          });
          return comment.html_url;
        }
        core.info('group-by-day: no existing same-day issue found, creating new');
      }

      // Close-older-issues: find older issues BEFORE creating
      let olderIssues: Awaited<ReturnType<typeof findOlderIssues>> = [];
      if (wfId && lifecycleConfig?.closeOlderIssues) {
        olderIssues = await findOlderIssues(octokit, owner, repo, wfId);
        core.info(`close-older-issues: found ${olderIssues.length} older issue(s)`);
      }

      // Create the new issue
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: action.title,
        body,
        labels: action.labels,
        assignees: action.assignees,
      });

      // Close older issues after successful creation
      if (olderIssues.length > 0 && lifecycleConfig) {
        const closed = await closeOlderIssues(
          octokit,
          owner,
          repo,
          olderIssues,
          data.html_url,
          lifecycleConfig.closeOlderIssuesMax
        );
        core.info(`close-older-issues: closed ${closed} older issue(s)`);
      }

      return data.html_url;
    }

    case 'create_pull_request': {
      const bodyWithMarker = wfId ? embedMarker(action.body, wfId) : action.body;
      return await createPullRequest(
        octokit,
        owner,
        repo,
        context,
        { ...action, body: bodyWithMarker }
      );
    }

    case 'add_labels': {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: action.issue_number,
        labels: action.labels,
      });
      return `https://github.com/${owner}/${repo}/issues/${action.issue_number}`;
    }

    default:
      throw new Error(`Unknown action type: ${(action as AgentAction).type}`);
  }
}

/**
 * Creates a pull request. If `files` are provided, creates a new branch
 * and commits the files via the Git Data API before opening the PR.
 * This avoids needing local git or contents:write on the agent job.
 */
async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  context: Context,
  action: CreatePullRequestAction
): Promise<string> {
  const baseBranch = action.base || context.ref.replace('refs/heads/', '');

  if (action.files && Object.keys(action.files).length > 0) {
    await createBranchWithFiles(
      octokit,
      owner,
      repo,
      baseBranch,
      action.head,
      action.files,
      action.commit_message || action.title
    );
  }

  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: action.title,
    body: action.body,
    head: action.head,
    base: baseBranch,
  });
  return data.html_url;
}

/**
 * Creates a branch with the given files using the Git Data API.
 *
 * Flow:
 * 1. Get the SHA of the base branch head commit
 * 2. Get the tree SHA of that commit
 * 3. Create blobs for each file
 * 4. Create a new tree with those blobs
 * 5. Create a commit pointing to that tree
 * 6. Create (or update) the branch ref
 */
async function createBranchWithFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string,
  files: Record<string, string>,
  commitMessage: string
): Promise<void> {
  core.info(
    `Creating branch "${headBranch}" from "${baseBranch}" with ${Object.keys(files).length} file(s)`
  );

  // 1. Get base branch SHA
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  // 2. Get base tree
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });
  const baseTreeSha = baseCommit.tree.sha;

  // 3. Create blobs for each file
  const treeItems: Array<{
    path: string;
    mode: '100644';
    type: 'blob';
    sha: string;
  }> = [];

  for (const [path, content] of Object.entries(files)) {
    const { data: blob } = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    });
    treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    core.info(`  blob: ${path} (${content.length} bytes)`);
  }

  // 4. Create tree
  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // 5. Create commit
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // 6. Create or update branch ref
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${headBranch}`,
      sha: newCommit.sha,
    });
    core.info(`Created branch: ${headBranch}`);
  } catch {
    // Branch may already exist - update it
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${headBranch}`,
      sha: newCommit.sha,
      force: true,
    });
    core.info(`Updated existing branch: ${headBranch}`);
  }
}
