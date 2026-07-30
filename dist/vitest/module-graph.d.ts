interface ModuleNodeLike {
    file: string | null;
    id: string | null;
    importedModules: Set<ModuleNodeLike>;
}
export interface ModuleGraphLike {
    getModuleById(id: string): ModuleNodeLike | undefined;
    getModulesByFile(file: string): Set<ModuleNodeLike> | undefined;
}
export declare function importedAssetFiles(graph: ModuleGraphLike, moduleId: string, root: string): string[];
export declare function directlyImportedAssetFiles(graph: ModuleGraphLike, moduleId: string, root: string): string[];
export {};
//# sourceMappingURL=module-graph.d.ts.map