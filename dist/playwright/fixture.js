import { PLAYWRIGHT_DEPENDENCIES_ATTACHMENT, PLAYWRIGHT_ROOT_ENV, PLAYWRIGHT_SESSION_ENV, } from './protocol.js';
import { sourceMapFiles } from './source-maps.js';
function tracksSource(responseUrl, resourceType) {
    return (resourceType === 'script' ||
        resourceType === 'stylesheet' ||
        /\.(?:bundle|css|[cm]?js)(?:\?|$)/i.test(responseUrl));
}
async function recordDependencies(context, use, testInfo) {
    const root = process.env[PLAYWRIGHT_ROOT_ENV];
    if (root === undefined ||
        process.env[PLAYWRIGHT_SESSION_ENV] === undefined) {
        await use();
        return;
    }
    const files = new Set();
    const pending = new Set();
    const pages = new Set();
    const observe = (page) => {
        if (pages.has(page)) {
            return;
        }
        pages.add(page);
        page.on('response', (response) => {
            const url = response.url();
            if (!tracksSource(url, response.request().resourceType())) {
                return;
            }
            const task = sourceMapFiles(url, root)
                .then((dependencies) => {
                for (const dependency of dependencies) {
                    files.add(dependency);
                }
            })
                .finally(() => pending.delete(task));
            pending.add(task);
        });
    };
    for (const page of context.pages()) {
        observe(page);
    }
    context.on('page', observe);
    await use();
    await Promise.allSettled([...pending]);
    await testInfo.attach(PLAYWRIGHT_DEPENDENCIES_ATTACHMENT, {
        body: Buffer.from(JSON.stringify([...files].sort())),
        contentType: 'application/json',
    });
}
export function withTiaFixture(test) {
    const fixtures = {
        context: async ({ context }, use, testInfo) => {
            await recordDependencies(context, async () => use(context), testInfo);
        },
    };
    return test.extend(fixtures);
}
//# sourceMappingURL=fixture.js.map