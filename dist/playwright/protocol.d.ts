import type { TiaObservation } from '../runners/core.js';
export declare const PLAYWRIGHT_DEPENDENCIES_ATTACHMENT = "tiajs.dependencies.json";
export declare const PLAYWRIGHT_SESSION_ENV = "TIA_PLAYWRIGHT_SESSION";
export declare const PLAYWRIGHT_ROOT_ENV = "TIA_PLAYWRIGHT_ROOT";
export interface PlaywrightObservation extends TiaObservation {
    dependenciesComplete: boolean;
}
export interface PlaywrightRunReport {
    configuredTestIds: string[];
    observations: PlaywrightObservation[];
    status: 'failed' | 'interrupted' | 'passed' | 'timedout';
}
//# sourceMappingURL=protocol.d.ts.map