import path from 'path';
import picomatch from 'picomatch';
import { AgentOutput, CreatePullRequestAction } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProtectedFilesConfig {
  action: 'block' | 'warn';
  patterns: string[];
  overrideDefaults: boolean;
}

export interface ProtectedFileViolation {
  path: string;
  matchedPattern: string;
  category: string;
}

export interface ProtectedFilesResult {
  passed: boolean;
  violations: ProtectedFileViolation[];
  checkedFiles: number;
  protectedAction: 'block' | 'warn';
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  'CODEOWNERS',
  'AGENTS.md',
  '.claude/**',
  '.codex/**',
  '.github/copilot-instructions.md',
  '**/package.json',
  '**/package-lock.json',
  '**/go.mod',
  '**/go.sum',
  '**/requirements.txt',
  '**/Pipfile.lock',
  '**/Gemfile.lock',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

const CATEGORY_MAP: { pattern: string; category: string }[] = [
  { pattern: '.github/workflows/**', category: 'CI config' },
  { pattern: '.github/actions/**', category: 'CI config' },
  { pattern: '**/package.json', category: 'Dependency manifest' },
  { pattern: '**/package-lock.json', category: 'Dependency manifest' },
  { pattern: '**/go.mod', category: 'Dependency manifest' },
  { pattern: '**/go.sum', category: 'Dependency manifest' },
  { pattern: '**/requirements.txt', category: 'Dependency manifest' },
  { pattern: '**/Pipfile.lock', category: 'Dependency manifest' },
  { pattern: '**/Gemfile.lock', category: 'Dependency manifest' },
  { pattern: '**/pnpm-lock.yaml', category: 'Dependency manifest' },
  { pattern: '**/yarn.lock', category: 'Dependency manifest' },
  { pattern: 'AGENTS.md', category: 'Agent instructions' },
  { pattern: '.claude/**', category: 'Agent instructions' },
  { pattern: '.codex/**', category: 'Agent instructions' },
  { pattern: '.github/copilot-instructions.md', category: 'Agent instructions' },
  { pattern: 'CODEOWNERS', category: 'Access control' },
];

/**
 * Classify a matched pattern into a human-readable category.
 * Known built-in patterns map to specific categories; anything else is "Custom".
 */
export function classifyPattern(matchedPattern: string): string {
  for (const entry of CATEGORY_MAP) {
    if (entry.pattern === matchedPattern) {
      return entry.category;
    }
  }
  return 'Custom';
}

// ---------------------------------------------------------------------------
// Pattern matching (gitignore-style, last match wins)
// ---------------------------------------------------------------------------

export function isFileProtected(
  filepath: string,
  patterns: string[]
): { protected: boolean; matchedPattern?: string } {
  let isProtected = false;
  let matchedPattern: string | undefined;

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;

    if (pattern.startsWith('!')) {
      const negated = pattern.slice(1);
      if (negated && picomatch.isMatch(filepath, negated, { dot: true })) {
        isProtected = false;
        matchedPattern = undefined;
      }
    } else {
      if (picomatch.isMatch(filepath, pattern, { dot: true })) {
        isProtected = true;
        matchedPattern = pattern;
      }
    }
  }

  return { protected: isProtected, matchedPattern };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Merge built-in defaults with user-supplied patterns.
 * When `overrideDefaults` is true the built-in list is skipped entirely.
 */
export function resolveProtectedConfig(config: ProtectedFilesConfig): string[] {
  const base: string[] = config.overrideDefaults ? [] : [...DEFAULT_PROTECTED_PATTERNS];
  return [...base, ...config.patterns];
}

// ---------------------------------------------------------------------------
// Main checker
// ---------------------------------------------------------------------------

/**
 * Scan all `create_pull_request` actions in the agent output for files
 * that match the protected pattern list.
 */
export function checkProtectedFiles(
  output: AgentOutput,
  config: ProtectedFilesConfig
): ProtectedFilesResult {
  const patterns = resolveProtectedConfig(config);
  const violations: ProtectedFileViolation[] = [];
  let checkedFiles = 0;

  if (!output || !Array.isArray(output.actions)) {
    return { passed: true, violations: [], checkedFiles: 0, protectedAction: config.action };
  }

  for (const action of output.actions) {
    if (action.type !== 'create_pull_request') continue;

    const prAction = action as CreatePullRequestAction;
    if (!prAction.files) continue;

    for (const filepath of Object.keys(prAction.files)) {
      checkedFiles++;

      // Normalize to prevent bypass via ./, ../, or // in paths
      const normalized = path.posix.normalize(filepath);

      // Reject paths that escape the repo root
      if (normalized.startsWith('../') || normalized.startsWith('/')) {
        violations.push({
          path: filepath,
          matchedPattern: '<path-traversal>',
          category: 'Security',
        });
        continue;
      }

      const result = isFileProtected(normalized, patterns);
      if (result.protected && result.matchedPattern) {
        violations.push({
          path: filepath,
          matchedPattern: result.matchedPattern,
          category: classifyPattern(result.matchedPattern),
        });
      }
    }
  }

  const passed = config.action === 'warn' || violations.length === 0;

  return {
    passed,
    violations,
    checkedFiles,
    protectedAction: config.action,
  };
}
