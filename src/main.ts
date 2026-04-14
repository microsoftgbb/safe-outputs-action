import * as core from '@actions/core';
import * as github from '@actions/github';
import { readFileSync } from 'fs';
import { AgentOutput } from './types';
import { validateOutput, ValidationConstraints } from './validator';
import { sanitizeOutput } from './sanitizer';
import { detectThreats } from './threat-detector';
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
    const threatDetection = core.getBooleanInput('threat-detection');
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
    core.startGroup('Phase 1: Constraint validation');
    const validation = validateOutput(output, constraints);

    if (!validation.valid) {
      for (const block of validation.blocked) {
        core.error(`BLOCKED [${block.index}] ${block.type}: ${block.reason}`);
      }
      core.endGroup();
      setOutputs({ blocked: validation.blocked.length, applied: 0, sanitized: 0 });
      core.setFailed(`${validation.blocked.length} action(s) blocked by safe-outputs constraints`);
      return;
    }
    core.info(`All ${validation.passed} action(s) passed constraint validation`);
    core.endGroup();

    // Phase 2: Sanitize secrets
    core.startGroup('Phase 2: Secret sanitization');
    const sanitization = sanitizeOutput(output, customPatterns);

    if (sanitization.redactedCount > 0) {
      core.warning(
        `Sanitized ${sanitization.redactedCount} field(s): ${sanitization.redactedFields.join(', ')}`
      );

      if (failOnSanitize) {
        core.endGroup();
        setOutputs({ blocked: 0, applied: 0, sanitized: sanitization.redactedCount });
        core.setFailed('Agent output contained sensitive data (fail-on-sanitize is enabled)');
        return;
      }
    } else {
      core.info('No sensitive patterns detected');
    }
    core.endGroup();

    // Phase 3: AI threat detection (optional)
    if (threatDetection) {
      core.startGroup('Phase 3: AI threat detection');
      const threats = await detectThreats(sanitization.output);

      if (threats.enabled) {
        if (!threats.passed) {
          for (const t of threats.threats) {
            core.error(`THREAT [${t.severity}] ${t.description} (at ${t.location})`);
          }
          core.endGroup();
          setOutputs({ blocked: 0, applied: 0, sanitized: sanitization.redactedCount });
          core.setFailed(
            `AI threat detection found ${threats.threats.length} threat(s) in agent output`
          );
          return;
        }
        core.info('AI threat detection passed - no threats found');
      } else {
        core.info('Copilot CLI not available - AI threat detection skipped');
      }
      core.endGroup();
    }

    // Phase 4: Execute (or dry-run)
    core.startGroup(threatDetection ? 'Phase 4: Execution' : 'Phase 3: Execution');
    if (dryRun) {
      core.info('DRY RUN: Actions validated and sanitized but NOT applied');
      setOutputs({ blocked: 0, applied: 0, sanitized: sanitization.redactedCount });
    } else {
      const octokit = github.getOctokit(token);
      const execution = await executeActions(octokit, github.context, sanitization.output);

      core.info(`Applied: ${execution.applied}, Failed: ${execution.failed}`);
      setOutputs({
        blocked: 0,
        applied: execution.applied,
        sanitized: sanitization.redactedCount,
      });

      if (execution.failed > 0) {
        core.setFailed(`${execution.failed} action(s) failed during execution`);
      }
    }
    core.endGroup();
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

function setOutputs(counts: { blocked: number; applied: number; sanitized: number }): void {
  core.setOutput('blocked-count', counts.blocked);
  core.setOutput('applied-count', counts.applied);
  core.setOutput('sanitized-count', counts.sanitized);
}

run();
