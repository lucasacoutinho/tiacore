import { databaseEdges } from './database.js';
import { viewEdges } from './views.js';
export function frameworkAdapters(options) {
    if (options === undefined) {
        return [];
    }
    const adapters = [];
    if (options.views) {
        adapters.push(viewEdges(options.views));
    }
    if (options.database) {
        adapters.push(databaseEdges(options.database));
    }
    if (options.adapters !== undefined) {
        adapters.push(...(Array.isArray(options.adapters)
            ? options.adapters
            : [options.adapters]));
    }
    return adapters;
}
export function frameworkFingerprint(adapters) {
    return JSON.stringify(adapters.map((adapter) => ({
        fingerprint: adapter.fingerprint ?? '',
        name: adapter.name,
    })));
}
//# sourceMappingURL=index.js.map