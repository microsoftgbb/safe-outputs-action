import {
  checkProtectedFiles,
  isFileProtected,
  resolveProtectedConfig,
  classifyPattern,
  DEFAULT_PROTECTED_PATTERNS,
  ProtectedFilesConfig,
} from '../protected-files';
import { AgentOutput } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const blockConfig: ProtectedFilesConfig = {
  action: 'block',
  patterns: [],
  overrideDefaults: false,
};

const warnConfig: ProtectedFilesConfig = {
  action: 'warn',
  patterns: [],
  overrideDefaults: false,
};

function makePrOutput(files: Record<string, string>): AgentOutput {
  return {
    actions: [
      {
        type: 'create_pull_request',
        title: 'Fix things',
        body: 'Details',
        head: 'fix/stuff',
        files,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DEFAULT_PROTECTED_PATTERNS', () => {
  it('includes CI config patterns', () => {
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('.github/workflows/**');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('.github/actions/**');
  });

  it('includes dependency manifest patterns', () => {
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/package.json');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/package-lock.json');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/go.mod');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/go.sum');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/requirements.txt');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/Pipfile.lock');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/Gemfile.lock');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/pnpm-lock.yaml');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('**/yarn.lock');
  });

  it('includes agent instructions patterns', () => {
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('AGENTS.md');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('.claude/**');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('.codex/**');
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('.github/copilot-instructions.md');
  });

  it('includes access control patterns', () => {
    expect(DEFAULT_PROTECTED_PATTERNS).toContain('CODEOWNERS');
  });
});

describe('classifyPattern', () => {
  it('classifies CI config patterns', () => {
    expect(classifyPattern('.github/workflows/**')).toBe('CI config');
    expect(classifyPattern('.github/actions/**')).toBe('CI config');
  });

  it('classifies dependency manifest patterns', () => {
    expect(classifyPattern('**/package.json')).toBe('Dependency manifest');
    expect(classifyPattern('**/go.mod')).toBe('Dependency manifest');
    expect(classifyPattern('**/yarn.lock')).toBe('Dependency manifest');
  });

  it('classifies agent instructions patterns', () => {
    expect(classifyPattern('AGENTS.md')).toBe('Agent instructions');
    expect(classifyPattern('.claude/**')).toBe('Agent instructions');
    expect(classifyPattern('.github/copilot-instructions.md')).toBe('Agent instructions');
  });

  it('classifies access control patterns', () => {
    expect(classifyPattern('CODEOWNERS')).toBe('Access control');
  });

  it('classifies unknown patterns as Custom', () => {
    expect(classifyPattern('src/**/*.secret')).toBe('Custom');
    expect(classifyPattern('deploy/**')).toBe('Custom');
  });
});

describe('isFileProtected', () => {
  it('matches exact file names', () => {
    const result = isFileProtected('package.json', ['package.json']);
    expect(result.protected).toBe(true);
    expect(result.matchedPattern).toBe('package.json');
  });

  it('matches glob patterns with **', () => {
    const result = isFileProtected('.github/workflows/ci.yml', ['.github/workflows/**']);
    expect(result.protected).toBe(true);
    expect(result.matchedPattern).toBe('.github/workflows/**');
  });

  it('matches nested paths with **', () => {
    const result = isFileProtected('.github/workflows/sub/deploy.yml', ['.github/workflows/**']);
    expect(result.protected).toBe(true);
  });

  it('does not match unrelated paths', () => {
    const result = isFileProtected('src/index.ts', ['.github/workflows/**', 'package.json']);
    expect(result.protected).toBe(false);
    expect(result.matchedPattern).toBeUndefined();
  });

  it('matches dotfiles when dot: true is used', () => {
    const result = isFileProtected('.claude/config.json', ['.claude/**']);
    expect(result.protected).toBe(true);
  });

  it('matches dotfiles in .codex directory', () => {
    const result = isFileProtected('.codex/settings.yaml', ['.codex/**']);
    expect(result.protected).toBe(true);
  });

  it('supports negation patterns', () => {
    const patterns = ['package.json', 'package-lock.json', '!package-lock.json'];
    const result = isFileProtected('package-lock.json', patterns);
    expect(result.protected).toBe(false);
    expect(result.matchedPattern).toBeUndefined();
  });

  it('supports last-match-wins semantics', () => {
    // First match protects, then negation unprotects, then another match re-protects
    const patterns = ['*.json', '!package.json', 'package.json'];
    const result = isFileProtected('package.json', patterns);
    expect(result.protected).toBe(true);
    expect(result.matchedPattern).toBe('package.json');
  });

  it('negation after match unprotects the file', () => {
    const patterns = ['*.lock', '!yarn.lock'];
    const yarnResult = isFileProtected('yarn.lock', patterns);
    expect(yarnResult.protected).toBe(false);

    const npmResult = isFileProtected('package-lock.json', patterns);
    // *.lock does not match package-lock.json (no ** crossing directories)
    // Actually *.lock does match package-lock.json since it contains "lock" - wait
    // picomatch: *.lock matches any single segment ending in .lock
    // package-lock.json does NOT end in .lock, so *.lock won't match it
    expect(npmResult.protected).toBe(false);
  });

  it('handles empty pattern list', () => {
    const result = isFileProtected('anything.ts', []);
    expect(result.protected).toBe(false);
  });

  it('* does not cross directory boundaries', () => {
    const result = isFileProtected('src/deep/package.json', ['*.json']);
    expect(result.protected).toBe(false);
  });

  it('** crosses directory boundaries', () => {
    const result = isFileProtected('src/deep/package.json', ['**/*.json']);
    expect(result.protected).toBe(true);
  });
});

describe('resolveProtectedConfig', () => {
  it('includes defaults when overrideDefaults is false', () => {
    const patterns = resolveProtectedConfig({
      action: 'block',
      patterns: [],
      overrideDefaults: false,
    });
    expect(patterns).toEqual(expect.arrayContaining([...DEFAULT_PROTECTED_PATTERNS]));
  });

  it('appends user patterns after defaults', () => {
    const patterns = resolveProtectedConfig({
      action: 'block',
      patterns: ['deploy/**'],
      overrideDefaults: false,
    });
    expect(patterns).toContain('deploy/**');
    expect(patterns).toContain('**/package.json');
    // User pattern comes after defaults
    expect(patterns.indexOf('deploy/**')).toBeGreaterThan(patterns.indexOf('**/package.json'));
  });

  it('skips defaults when overrideDefaults is true', () => {
    const patterns = resolveProtectedConfig({
      action: 'block',
      patterns: ['my-config.yml'],
      overrideDefaults: true,
    });
    expect(patterns).toEqual(['my-config.yml']);
    expect(patterns).not.toContain('**/package.json');
  });

  it('returns empty array when overrideDefaults is true and no user patterns', () => {
    const patterns = resolveProtectedConfig({
      action: 'block',
      patterns: [],
      overrideDefaults: true,
    });
    expect(patterns).toEqual([]);
  });
});

describe('checkProtectedFiles', () => {
  describe('default patterns in block mode', () => {
    it('blocks CI config files', () => {
      const output = makePrOutput({ '.github/workflows/ci.yml': 'name: CI' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('.github/workflows/ci.yml');
      expect(result.violations[0].category).toBe('CI config');
    });

    it('blocks dependency manifest files', () => {
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('package.json');
      expect(result.violations[0].category).toBe('Dependency manifest');
    });

    it('blocks agent instructions files', () => {
      const output = makePrOutput({ 'AGENTS.md': '# agents' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].category).toBe('Agent instructions');
    });

    it('blocks access control files', () => {
      const output = makePrOutput({ CODEOWNERS: '* @team' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].category).toBe('Access control');
    });

    it('blocks .claude directory files', () => {
      const output = makePrOutput({ '.claude/config.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations[0].category).toBe('Agent instructions');
    });

    it('blocks .codex directory files', () => {
      const output = makePrOutput({ '.codex/settings.yaml': 'key: val' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
    });

    it('blocks copilot instructions', () => {
      const output = makePrOutput({ '.github/copilot-instructions.md': '# instructions' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations[0].category).toBe('Agent instructions');
    });
  });

  describe('safe files', () => {
    it('passes source code files', () => {
      const output = makePrOutput({ 'src/index.ts': 'console.log("hi")' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('passes README.md', () => {
      const output = makePrOutput({ 'README.md': '# readme' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
    });

    it('passes arbitrary nested files', () => {
      const output = makePrOutput({
        'src/utils/helper.ts': 'export {}',
        'docs/guide.md': '# guide',
      });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.checkedFiles).toBe(2);
    });
  });

  describe('custom patterns', () => {
    it('extends defaults with user patterns', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: ['deploy/**'],
        overrideDefaults: false,
      };
      const output = makePrOutput({ 'deploy/prod.yaml': 'config' });
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(false);
      expect(result.violations[0].category).toBe('Custom');
    });

    it('user negation creates exception for defaults', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: ['!**/package-lock.json'],
        overrideDefaults: false,
      };
      const output = makePrOutput({ 'package-lock.json': '{}' });
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('override defaults', () => {
    it('only applies user patterns when overrideDefaults is true', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: ['deploy/**'],
        overrideDefaults: true,
      };
      // package.json would be blocked by defaults but not by user patterns
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(true);
    });

    it('still blocks files matching user patterns', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: ['deploy/**'],
        overrideDefaults: true,
      };
      const output = makePrOutput({ 'deploy/prod.yaml': 'config' });
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(false);
    });

    it('passes everything when overrideDefaults true and no patterns', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: [],
        overrideDefaults: true,
      };
      const output = makePrOutput({ 'package.json': '{}', '.github/workflows/ci.yml': 'ci' });
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('warn mode', () => {
    it('reports violations but still passes', () => {
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, warnConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('package.json');
      expect(result.protectedAction).toBe('warn');
    });

    it('passes with zero violations', () => {
      const output = makePrOutput({ 'src/app.ts': 'code' });
      const result = checkProtectedFiles(output, warnConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('block mode', () => {
    it('fails when violations exist', () => {
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.protectedAction).toBe('block');
    });

    it('passes when no violations exist', () => {
      const output = makePrOutput({ 'src/app.ts': 'code' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
    });
  });

  describe('multiple violations', () => {
    it('reports all protected files in a single PR', () => {
      const output = makePrOutput({
        'package.json': '{}',
        '.github/workflows/deploy.yml': 'deploy',
        CODEOWNERS: '* @admin',
        'src/safe.ts': 'safe code',
      });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(3);
      expect(result.checkedFiles).toBe(4);

      const paths = result.violations.map((v) => v.path);
      expect(paths).toContain('package.json');
      expect(paths).toContain('.github/workflows/deploy.yml');
      expect(paths).toContain('CODEOWNERS');
    });
  });

  describe('action types filtering', () => {
    it('skips issue actions (no files to check)', () => {
      const output: AgentOutput = {
        actions: [
          { type: 'create_issue', title: 'Bug', body: 'Details' },
          { type: 'issue_comment', issue_number: 1, body: 'Comment' },
          { type: 'add_labels', issue_number: 1, labels: ['bug'] },
        ],
      };
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.checkedFiles).toBe(0);
    });

    it('only checks create_pull_request actions', () => {
      const output: AgentOutput = {
        actions: [
          { type: 'create_issue', title: 'Bug', body: 'Details' },
          {
            type: 'create_pull_request',
            title: 'Fix',
            body: 'Details',
            head: 'fix/thing',
            files: { 'package.json': '{}' },
          },
        ],
      };
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.checkedFiles).toBe(1);
    });

    it('skips create_pull_request without files', () => {
      const output: AgentOutput = {
        actions: [
          {
            type: 'create_pull_request',
            title: 'Fix',
            body: 'Details',
            head: 'fix/thing',
          },
        ],
      };
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.checkedFiles).toBe(0);
    });

    it('checks multiple create_pull_request actions', () => {
      const output: AgentOutput = {
        actions: [
          {
            type: 'create_pull_request',
            title: 'PR 1',
            body: 'Details',
            head: 'fix/a',
            files: { 'package.json': '{}' },
          },
          {
            type: 'create_pull_request',
            title: 'PR 2',
            body: 'Details',
            head: 'fix/b',
            files: { '.github/workflows/ci.yml': 'ci' },
          },
        ],
      };
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.checkedFiles).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles null output gracefully', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = checkProtectedFiles(null as any, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.checkedFiles).toBe(0);
    });

    it('handles output with missing actions array', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = checkProtectedFiles({} as any, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.checkedFiles).toBe(0);
    });

    it('handles empty files map', () => {
      const output = makePrOutput({});
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(true);
      expect(result.checkedFiles).toBe(0);
    });

    it('pattern order matters: last match wins with conflicting patterns', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: [],
        overrideDefaults: false,
      };
      // Default patterns protect package.json; add negation then re-protect
      config.patterns = ['!package.json', 'package.json'];
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, config);
      // The last pattern 'package.json' re-protects it
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
    });

    it('empty string patterns are harmless', () => {
      const config: ProtectedFilesConfig = {
        action: 'block',
        patterns: ['', '  '],
        overrideDefaults: true,
      };
      const output = makePrOutput({ 'src/app.ts': 'code' });
      // Empty strings passed through won't match normal file paths
      const result = checkProtectedFiles(output, config);
      expect(result.passed).toBe(true);
    });
  });

  describe('path normalization', () => {
    it('normalizes ./ prefix before matching', () => {
      const output = makePrOutput({ './package.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('./package.json');
      expect(result.violations[0].category).toBe('Dependency manifest');
    });

    it('normalizes ../ traversal before matching', () => {
      const output = makePrOutput({ 'sub/../CODEOWNERS': '* @team' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('sub/../CODEOWNERS');
      expect(result.violations[0].category).toBe('Access control');
    });

    it('normalizes double slashes before matching', () => {
      const output = makePrOutput({ '.github//workflows//ci.yml': 'name: CI' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('.github//workflows//ci.yml');
      expect(result.violations[0].category).toBe('CI config');
    });
  });

  describe('path traversal rejection', () => {
    it('rejects paths that escape the repo root with ../', () => {
      const output = makePrOutput({ '../../../etc/passwd': 'root:x:0:0' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].matchedPattern).toBe('<path-traversal>');
      expect(result.violations[0].category).toBe('Security');
    });

    it('rejects absolute paths', () => {
      const output = makePrOutput({ '/absolute/path': 'content' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].matchedPattern).toBe('<path-traversal>');
      expect(result.violations[0].category).toBe('Security');
    });

    it('rejects paths that normalize to ../', () => {
      const output = makePrOutput({ 'a/../../secret': 'content' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].matchedPattern).toBe('<path-traversal>');
      expect(result.violations[0].category).toBe('Security');
    });
  });

  describe('monorepo depth matching', () => {
    it('matches package.json in nested directories', () => {
      const output = makePrOutput({ 'apps/web/package.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('apps/web/package.json');
      expect(result.violations[0].category).toBe('Dependency manifest');
    });

    it('matches go.mod in nested directories', () => {
      const output = makePrOutput({ 'packages/core/go.mod': 'module example' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe('packages/core/go.mod');
      expect(result.violations[0].category).toBe('Dependency manifest');
    });

    it('matches all dependency manifests at nested depth', () => {
      const depFiles = [
        'apps/web/package.json',
        'services/api/package-lock.json',
        'libs/core/go.mod',
        'backend/go.sum',
        'python/app/requirements.txt',
        'services/worker/Pipfile.lock',
        'ruby/Gemfile.lock',
        'frontend/pnpm-lock.yaml',
        'monorepo/packages/ui/yarn.lock',
      ];
      for (const file of depFiles) {
        const output = makePrOutput({ [file]: 'content' });
        const result = checkProtectedFiles(output, blockConfig);
        expect(result.passed).toBe(false);
        expect(result.violations[0].path).toBe(file);
        expect(result.violations[0].category).toBe('Dependency manifest');
      }
    });

    it('still matches root-level manifests', () => {
      const output = makePrOutput({ 'package.json': '{}' });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations[0].path).toBe('package.json');
    });
  });

  describe('warn mode emits violations', () => {
    it('returns violations array when action is warn', () => {
      const output = makePrOutput({
        'package.json': '{}',
        '.github/workflows/ci.yml': 'ci',
      });
      const result = checkProtectedFiles(output, warnConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(2);
      expect(result.violations.map((v) => v.path)).toContain('package.json');
      expect(result.violations.map((v) => v.path)).toContain('.github/workflows/ci.yml');
    });

    it('returns empty violations array when no files are protected', () => {
      const output = makePrOutput({ 'src/index.ts': 'code' });
      const result = checkProtectedFiles(output, warnConfig);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('glob pattern specifics', () => {
    it('** matches deeply nested workflow files', () => {
      const output = makePrOutput({
        '.github/workflows/nested/deep/deploy.yml': 'deploy',
      });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
    });

    it('.github/actions/** matches action subdirectories', () => {
      const output = makePrOutput({
        '.github/actions/my-action/action.yml': 'name: my-action',
      });
      const result = checkProtectedFiles(output, blockConfig);
      expect(result.passed).toBe(false);
      expect(result.violations[0].category).toBe('CI config');
    });

    it('matches all default dependency manifests', () => {
      const depFiles = [
        'package.json',
        'package-lock.json',
        'go.mod',
        'go.sum',
        'requirements.txt',
        'Pipfile.lock',
        'Gemfile.lock',
        'pnpm-lock.yaml',
        'yarn.lock',
      ];
      for (const file of depFiles) {
        const output = makePrOutput({ [file]: 'content' });
        const result = checkProtectedFiles(output, blockConfig);
        expect(result.passed).toBe(false);
        expect(result.violations[0].path).toBe(file);
        expect(result.violations[0].category).toBe('Dependency manifest');
      }
    });
  });
});
