import { resolve } from 'node:path';
import { projectRelative } from '../shared/paths.js';
export function resolveFrameworkEdges(adapters, context) {
    const files = new Set();
    for (const adapter of adapters) {
        try {
            for (const file of adapter.resolve(context)) {
                const relative = projectRelative(context.root, resolve(context.root, file));
                if (relative !== null && relative !== '') {
                    files.add(relative);
                }
            }
        }
        catch {
            return { complete: false, files: [] };
        }
    }
    return { complete: true, files: [...files].sort() };
}
//# sourceMappingURL=resolve.js.map