export function moduleFailureObservation(file) {
    return {
        file,
        files: [file],
        fullName: `${file} (module failure)`,
        id: `module:${file}`,
        state: 'failed',
    };
}
export function fullyExecutedFiles(plan, observations, initial) {
    const files = new Set(initial);
    for (const observation of observations) {
        if (observation.id === `module:${observation.file}`) {
            files.add(observation.file);
        }
    }
    if (plan.mode === 'replay' && plan.graph !== null) {
        for (const id of plan.affectedTestIds) {
            if (id.startsWith('module:')) {
                const result = plan.graph.results[id];
                if (result !== undefined) {
                    files.add(result.file);
                }
            }
        }
    }
    return [...files].sort();
}
//# sourceMappingURL=observations.js.map