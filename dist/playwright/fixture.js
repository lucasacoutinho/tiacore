import { PLAYWRIGHT_DEPENDENCIES_ATTACHMENT, PLAYWRIGHT_ROOT_ENV, PLAYWRIGHT_SESSION_ENV, } from './protocol.js';
import { coveredSourceMapFiles, sourceMapFiles, } from './source-maps.js';
function tracksSource(responseUrl, resourceType) {
    return (resourceType === 'script' ||
        resourceType === 'stylesheet' ||
        /\.(?:bundle|css|[cm]?js)(?:\?|$)/i.test(responseUrl));
}
async function recordDependencies(context, initialPage, preciseCoverage, use, testInfo) {
    const root = process.env[PLAYWRIGHT_ROOT_ENV];
    if (root === undefined ||
        process.env[PLAYWRIGHT_SESSION_ENV] === undefined) {
        await use();
        return;
    }
    const files = new Set();
    const pending = new Set();
    const pages = new Set();
    const coverageStarts = new Map();
    const fallbackFiles = new Map();
    const observe = (page) => {
        if (pages.has(page)) {
            return;
        }
        pages.add(page);
        fallbackFiles.set(page, new Set());
        if (preciseCoverage) {
            coverageStarts.set(page, page.coverage
                .startJSCoverage({ resetOnNavigation: false })
                .then(() => true, () => false));
        }
        page.on('response', (response) => {
            const url = response.url();
            if (!tracksSource(url, response.request().resourceType())) {
                return;
            }
            const task = sourceMapFiles(url, root)
                .then((dependencies) => {
                const target = response.request().resourceType() === 'stylesheet'
                    ? files
                    : fallbackFiles.get(page);
                for (const dependency of dependencies) {
                    target?.add(dependency);
                }
            })
                .finally(() => pending.delete(task));
            pending.add(task);
        });
    };
    observe(initialPage);
    for (const page of context.pages()) {
        observe(page);
    }
    await (coverageStarts.get(initialPage) ?? Promise.resolve(false));
    context.on('page', observe);
    await use();
    await Promise.allSettled([...pending]);
    for (const page of pages) {
        const coverageStarted = preciseCoverage &&
            await (coverageStarts.get(page) ?? Promise.resolve(false));
        if (!coverageStarted) {
            for (const file of fallbackFiles.get(page) ?? []) {
                files.add(file);
            }
            continue;
        }
        try {
            const coverage = await page.coverage.stopJSCoverage();
            for (const entry of coverage) {
                for (const file of await coveredSourceMapFiles(entry.url, entry.source, entry.functions, root)) {
                    files.add(file);
                }
            }
        }
        catch {
            for (const file of fallbackFiles.get(page) ?? []) {
                files.add(file);
            }
        }
    }
    await testInfo.attach(PLAYWRIGHT_DEPENDENCIES_ATTACHMENT, {
        body: Buffer.from(JSON.stringify([...files].sort())),
        contentType: 'application/json',
    });
}
export function withTiaFixture(test) {
    const fixtures = {
        _tiaDependencies: [
            async ({ page }, use, testInfo) => {
                await recordDependencies(page.context(), page, page.context().browser()?.browserType().name() === 'chromium', use, testInfo);
            },
            { auto: true },
        ],
    };
    return test.extend(fixtures);
}
//# sourceMappingURL=fixture.js.map