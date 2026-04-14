import { AgentOutput } from './types';

/**
 * Built-in patterns that detect common secret formats.
 * Each pattern is applied globally across all string fields.
 */
const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  // Generic key=value secrets
  /(?:password|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credential|connectionstring)\s*[=:]\s*\S+/gi,

  // JWTs (header.payload.signature)
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-.+/=]+/g,

  // Azure connection strings
  /DefaultEndpointsProtocol=https?;[^\s"']+/g,

  // Azure SAS tokens
  /[?&]s[aip]g?=[A-Za-z0-9%+/=]+(?:&[a-z]{2,3}=[^&\s]+)*/g,

  // AWS access key IDs
  /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,

  // GitHub tokens (PATs, OAuth, etc.)
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,

  // Private key blocks
  /-----BEGIN[\s](?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END[\s](?:RSA\s+)?PRIVATE\s+KEY-----/g,

  // Bearer tokens in text
  /Bearer\s+[A-Za-z0-9_\-.~+/]{20,}=*/g,

  // Hex-encoded secrets (40+ chars, common for SHA tokens)
  /(?:secret|token|key|password)\s*[=:]\s*[0-9a-f]{40,}/gi,
];

export interface SanitizeResult {
  output: AgentOutput;
  redactedCount: number;
  redactedFields: string[];
}

export function sanitizeOutput(
  output: AgentOutput,
  customPatterns: string[] = []
): SanitizeResult {
  const patterns = [
    ...DEFAULT_SECRET_PATTERNS,
    ...compileCustomPatterns(customPatterns),
  ];

  let redactedCount = 0;
  const redactedFields: string[] = [];

  // Deep clone to avoid mutating input
  const sanitized: AgentOutput = JSON.parse(JSON.stringify(output));

  for (let i = 0; i < sanitized.actions.length; i++) {
    const action = sanitized.actions[i];

    for (const [field, value] of Object.entries(action)) {
      if (typeof value !== 'string' || field === 'type') continue;

      const result = sanitizeString(value, patterns);
      if (result.wasRedacted) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (action as any)[field] = result.value;
        redactedCount++;
        redactedFields.push(`actions[${i}].${field}`);
      }
    }
  }

  return { output: sanitized, redactedCount, redactedFields };
}

function sanitizeString(
  value: string,
  patterns: RegExp[]
): { value: string; wasRedacted: boolean } {
  let result = value;
  let wasRedacted = false;

  for (const pattern of patterns) {
    // Reset lastIndex for stateful (global) regexes
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
      wasRedacted = true;
    }
  }

  return { value: result, wasRedacted };
}

function compileCustomPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, 'g'));
    } catch {
      // Skip invalid patterns - logged at the caller level
    }
  }
  return compiled;
}
