import { resolve } from 'node:path';
import { projectRelative } from '../shared/paths.js';
const EXECUTABLE_SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i;
function cleanId(id) {
    return id.split('?', 1)[0] ?? id;
}
function moduleFile(node) {
    const value = node.file ?? node.id;
    return value === null ? null : cleanId(value);
}
function entryModules(graph, moduleId) {
    const cleanModuleId = cleanId(moduleId);
    const direct = graph.getModuleById(moduleId) ?? graph.getModuleById(cleanModuleId);
    const byFile = graph.getModulesByFile(resolve(cleanModuleId));
    return [
        ...new Set([
            ...(direct === undefined ? [] : [direct]),
            ...(byFile ?? []),
        ]),
    ];
}
export function importedAssetFiles(graph, moduleId, root) {
    const queue = entryModules(graph, moduleId);
    const visited = new Set();
    const assets = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || visited.has(current)) {
            continue;
        }
        visited.add(current);
        for (const imported of current.importedModules) {
            queue.push(imported);
            const file = moduleFile(imported);
            if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
                continue;
            }
            const relative = projectRelative(root, file);
            if (relative !== null && relative !== '') {
                assets.add(relative);
            }
        }
    }
    return [...assets].sort();
}
export function directlyImportedAssetFiles(graph, moduleId, root) {
    const assets = new Set();
    for (const entry of entryModules(graph, moduleId)) {
        for (const imported of entry.importedModules) {
            const file = moduleFile(imported);
            if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
                continue;
            }
            const relative = projectRelative(root, file);
            if (relative !== null && relative !== '') {
                assets.add(relative);
            }
        }
    }
    return [...assets].sort();
}
//# sourceMappingURL=module-graph.js.map