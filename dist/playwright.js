import { fileURLToPath } from 'node:url';
import { withTiaFixture } from './playwright/fixture.js';
import { TiaPlaywrightRunner, } from './playwright/runner.js';
export function tia(value) {
    if (value === undefined) {
        return [
            fileURLToPath(new URL('./playwright/reporter.js', import.meta.url)),
        ];
    }
    if (typeof value === 'function') {
        return withTiaFixture(value);
    }
    return new TiaPlaywrightRunner(value);
}
//# sourceMappingURL=playwright.js.map