// Loaded only by the packaged integration test. Both clients keep their normal
// transports. Playwright serves the saved public response to the browser GET.
import { readFile, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const directory = process.env.ORDERBOOK_FIXTURE_DIR;
// Run periodic scheduler checks promptly while retaining its actual due-time policy.
if (process.env.ORDERBOOK_FIXTURE_SCHEDULER) {
    const interval = globalThis.setInterval;
    const cadence = Number(process.env.ORDERBOOK_FIXTURE_SCHEDULER);
    globalThis.setInterval = (callback, ms, ...args) =>
        interval(callback, ms === cadence ? 100 : ms, ...args);
}
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
    await appendFile(directory + "/requests", "browser\n");
    const browser = await launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (options) => {
        const page = await newPage(options);
        await page.route(
            "https://www.vvv.so/api/111k/state?orders=1",
            async (route) => {
                await appendFile(directory + "/requests", "vvv\n");
                const mode = await readFile(directory + "/mode", "utf8");
                if (mode === "interrupt") await delay(30_000);
                if (mode === "deny")
                    return route.fulfill({ status: 429, body: "denied" });
                return route.fulfill({
                    contentType: "application/json",
                    body: await readFile(directory + "/state.json"),
                });
            },
        );
        return page;
    };
    return browser;
};
const original = globalThis.fetch;
globalThis.fetch = async (request, options) => {
    const url = new URL(
        typeof request === "string" || request instanceof URL
            ? request
            : request.url,
    );
    if (url.hostname.endsWith(".opensea.io")) {
        await appendFile(directory + "/requests", "opensea\n");
        return Response.json({ offers: [], listings: [], next: null });
    }
    if (url.hostname === "127.0.0.1") return original(request, options);
    throw new Error("Unconfigured integration fixture host");
};
