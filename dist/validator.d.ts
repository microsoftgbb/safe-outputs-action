import { AgentOutput } from './types';
export interface ValidationConstraints {
    maxIssues: number;
    maxComments: number;
    maxPullRequests: number;
    maxLabels: number;
    titlePrefix: string;
    allowedLabels: string[];
}
export interface BlockedAction {
    index: number;
    type: string;
    reason: string;
}
export interface ValidationResult {
    valid: boolean;
    blocked: BlockedAction[];
    passed: number;
}
export declare function validateOutput(output: AgentOutput, constraints: ValidationConstraints): ValidationResult;
