import { registerHooks } from 'node:module';
const shim = new URL('./node-discovery-shim.js', import.meta.url).href;
const commonJsShim = new URL('./node-discovery-shim.cjs', import.meta.url).href;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:test' || specifier === 'test') {
            return {
                shortCircuit: true,
                url: context.conditions.includes('require')
                    ? commonJsShim
                    : shim,
            };
        }
        return nextResolve(specifier, context);
    },
});
//# sourceMappingURL=node-discovery-register.js.map