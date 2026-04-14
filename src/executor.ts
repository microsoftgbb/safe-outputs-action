import * as core from '@actions/core';
import * as github from '@actions/github';
import { AgentOutput, AgentAction } from './types';

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
  output: AgentOutput
): Promise<ExecutionResult> {
  const results: ActionResult[] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < output.actions.length; i++) {
    const action = output.actions[i];
    try {
      const url = await applyAction(octokit, context, action);
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
  action: AgentAction
): Promise<string> {
  const { owner, repo } = context.repo;

  switch (action.type) {
    case 'issue_comment': {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: action.issue_number,
        body: action.body,
      });
      return data.html_url;
    }

    case 'create_issue': {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: action.title,
        body: action.body,
        labels: action.labels,
        assignees: action.assignees,
      });
      return data.html_url;
    }

    case 'create_pull_request': {
      const baseBranch = action.base || context.ref.replace('refs/heads/', '');
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
