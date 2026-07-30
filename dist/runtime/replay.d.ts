import type { CachedTestResult, RunPlan, TiaReplayAdapter, TiaReplayCompleteEvent, TiaReplayedTestEvent, TiaReplayRunEvent } from '../shared/types.js';
export type ReplayAdapterEvent = TiaReplayCompleteEvent | TiaReplayedTestEvent | TiaReplayRunEvent;
export type ReplayAdapterMethod = 'onRunComplete' | 'onRunStart' | 'onTestReplayed';
export declare function replayedResults(plan: RunPlan): CachedTestResult[];
export declare function replayRunEvent(plan: RunPlan): TiaReplayRunEvent;
export declare function notifyReplayAdapters(adapters: TiaReplayAdapter[], method: ReplayAdapterMethod, event: ReplayAdapterEvent, warn: (message: string) => void): Promise<void>;
//# sourceMappingURL=replay.d.ts.map