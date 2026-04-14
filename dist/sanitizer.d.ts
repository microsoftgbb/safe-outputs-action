import { AgentOutput } from './types';
export interface SanitizeResult {
    output: AgentOutput;
    redactedCount: number;
    redactedFields: string[];
}
export declare function sanitizeOutput(output: AgentOutput, customPatterns?: string[]): SanitizeResult;
