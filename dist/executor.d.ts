import * as github from '@actions/github';
import { AgentOutput } from './types';
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
export declare function executeActions(octokit: Octokit, context: Context, output: AgentOutput): Promise<ExecutionResult>;
export {};
