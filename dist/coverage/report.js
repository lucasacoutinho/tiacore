import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import coverageLibrary from 'istanbul-lib-coverage';
import reportLibrary from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { projectRelative } from '../shared/paths.js';
import { coverageThresholdFailures, } from './thresholds.js';
import { selectedCoverage } from './files.js';
export function portableCoverageMap(root, coverage) {
    const portable = {};
    for (const [key, value] of Object.entries(coverage)) {
        const file = projectRelative(root, value.path || key);
        if (file === null || file === '') {
            continue;
        }
        portable[file] = {
            ...structuredClone(value),
            path: file,
        };
    }
    return portable;
}
function absoluteCoverageMap(root, coverage) {
    return Object.fromEntries(Object.entries(coverage).map(([key, value]) => {
        const path = resolve(root, value.path || key);
        return [
            path,
            {
                ...structuredClone(value),
                path,
            },
        ];
    }));
}
export function mergedGraphCoverage(graph, root) {
    const merged = coverageLibrary.createCoverageMap();
    for (const coverage of Object.values(graph.collectionCoverage)) {
        merged.merge(absoluteCoverageMap(root, coverage));
    }
    for (const coverage of Object.values(graph.testCoverage)) {
        merged.merge(absoluteCoverageMap(root, coverage));
    }
    return merged;
}
export function writeCoverageReports(graph, root, options) {
    const selected = selectedCoverage(mergedGraphCoverage(graph, root), root, options);
    const coverageMap = selected.coverage;
    const context = reportLibrary.createContext({
        coverageMap,
        dir: options.reportsDirectory,
        sourceFinder: (file) => readFileSync(file, 'utf8'),
        watermarks: options.watermarks,
    });
    for (const reporter of options.reporters) {
        reports.create(reporter.name, {
            projectRoot: root,
            skipFull: options.skipFull,
            ...reporter.options,
        }).execute(context);
    }
    return {
        files: coverageMap.files().length,
        thresholdFailures: coverageThresholdFailures(coverageMap, root, options.thresholds),
        warnings: selected.warnings,
    };
}
//# sourceMappingURL=report.js.map