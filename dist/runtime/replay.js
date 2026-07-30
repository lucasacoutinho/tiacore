export function replayedResults(plan) {
    if (plan.mode !== 'replay' || plan.graph === null) {
        return [];
    }
    const affectedIds = new Set(plan.affectedTestIds);
    const wholeFiles = new Set(plan.wholeTestFiles);
    return Object.values(plan.graph.results)
        .filter((result) => result.state !== 'failed' &&
        !affectedIds.has(result.id) &&
        !wholeFiles.has(result.file))
        .sort((left, right) => left.id.localeCompare(right.id));
}
export function replayRunEvent(plan) {
    return {
        affectedTestIds: [...plan.affectedTestIds],
        affectedTests: [...plan.affectedTests],
        changedFiles: [...plan.changedFiles],
        mode: plan.mode,
        reason: plan.reason,
        replayedTests: plan.replayedTests,
        wholeTestFiles: [...plan.wholeTestFiles],
    };
}
export async function notifyReplayAdapters(adapters, method, event, warn) {
    for (const adapter of adapters) {
        const handler = adapter[method];
        if (handler === undefined) {
            continue;
        }
        try {
            await handler.call(adapter, event);
        }
        catch (error) {
            warn(`TIA replay adapter ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
//# sourceMappingURL=replay.js.map