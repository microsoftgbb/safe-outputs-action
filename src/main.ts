import * as core from '@actions/core';
import * as github from '@actions/github';
import { readFileSync } from 'fs';
import { AgentOutput } from './types';
import { validateOutput, ValidationConstraints } from './validator';
import { sanitizeOutput } from './sanitizer';
import { executeActions } from './executor';

async function run(): Promise<void> {
  try {
    // Read inputs
    const artifactPath = core.getInput('artifact-path', { required: true });
    const constraints: ValidationConstraints = {
      maxIssues: parseInt(core.getInput('max-issues'), 10),
      maxComments: parseInt(core.getInput('max-comments'), 10),
      maxPullRequests: parseInt(core.getInput('max-pull-requests'), 10),
      maxLabels: parseInt(core.getInput('max-labels'), 10),
      titlePrefix: core.getInput('title-prefix'),
      allowedLabels: parseList(core.getInput('allowed-labels')),
    };
    const customPatterns = core
      .getInput('custom-secret-patterns')
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    const dryRun = core.getBooleanInput('dry-run');
    const failOnSanitize = core.getBooleanInput('fail-on-sanitize');
    const token = core.getInput('token', { required: true });

    // Parse agent output
    core.info(`Reading agent output from: ${artifactPath}`);
    const raw = readFileSync(artifactPath, 'utf-8');
    let output: AgentOutput;
    try {
      output = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in agent output file: ${artifactPath}`);
    }

    core.info(`Agent proposed ${output.actions?.length ?? 0} action(s)`);

    // Phase 1: Validate constraints
    core.startGroup('Constraint validation');
    const validation = validateOutput(output, constraints);

    if (!validation.valid) {
      for (const block of validation.blocked) {
        core.error(`BLOCKED [${block.index}] ${block.type}: ${block.reason}`);
      }
      core.endGroup();
      core.setOutput('blocked-count', validation.blocked.length);
      core.setOutput('applied-count', 0);
      core.setOutput('sanitized-count', 0);
      core.setOutput('summary', JSON.stringify({ phase: 'validation', validation }));
      core.setFailed(`${validation.blocked.length} action(s) blocked by safe-outputs constraints`);
      return;
    }
    core.info(`All ${validation.passed} action(s) passed constraint validation`);
    core.endGroup();

    // Phase 2: Sanitize secrets
    core.startGroup('Secret sanitization');
    const sanitization = sanitizeOutput(output, customPatterns);

    if (sanitization.redactedCount > 0) {
      core.warning(
        `Sanitized ${sanitization.redactedCount} field(s): ${sanitization.redactedFields.join(', ')}`
      );

      if (failOnSanitize) {
        core.endGroup();
        core.setOutput('blocked-count', 0);
        core.setOutput('applied-count', 0);
        core.setOutput('sanitized-count', sanitization.redactedCount);
        core.setOutput(
          'summary',
          JSON.stringify({
            phase: 'sanitization',
            sanitization: { fields: sanitization.redactedFields },
          })
        );
        core.setFailed('Agent output contained sensitive data (fail-on-sanitize is enabled)');
        return;
      }
    } else {
      core.info('No sensitive patterns detected');
    }
    core.endGroup();

    // Phase 3: Execute (or dry-run)
    core.startGroup('Execution');
    if (dryRun) {
      core.info('DRY RUN: Actions validated and sanitized but NOT applied');
      core.setOutput('applied-count', 0);
    } else {
      const octokit = github.getOctokit(token);
      const execution = await executeActions(octokit, github.context, sanitization.output);

      core.info(`Applied: ${execution.applied}, Failed: ${execution.failed}`);
      core.setOutput('applied-count', execution.applied);

      if (execution.failed > 0) {
        core.setFailed(`${execution.failed} action(s) failed during execution`);
      }
    }
    core.endGroup();

    core.setOutput('blocked-count', validation.blocked.length);
    core.setOutput('sanitized-count', sanitization.redactedCount);
    core.setOutput(
      'summary',
      JSON.stringify({
        phase: 'complete',
        validation: { passed: validation.passed },
        sanitization: {
          redacted: sanitization.redactedCount,
          fields: sanitization.redactedFields,
        },
        dryRun,
      })
    );
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

function parseList(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

run();
