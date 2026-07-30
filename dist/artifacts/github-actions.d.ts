import type { TiaArtifactProvider, TiaGitHubActionsOptions, TiaGraph } from '../shared/types.js';
export declare function archiveGraph(archive: Uint8Array, runner: string | undefined): TiaGraph | null;
export declare function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array | null>;
export declare function createGitHubActionsArtifactProvider(source: TiaGitHubActionsOptions, request?: typeof globalThis.fetch): TiaArtifactProvider;
//# sourceMappingURL=github-actions.d.ts.map