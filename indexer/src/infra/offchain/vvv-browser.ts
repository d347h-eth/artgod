import type { Browser, Page } from "playwright-core";
import {
    VVV_BOOK_LIMIT_BYTES,
    VVV_MARKETS,
    consumeVvvBookStream,
    type VvvMarketLocation,
} from "./vvv-orderbook.js";
import type { BookMarket, BookObservation } from "../../domain/orderbook.js";

const BOOK_TIMEOUT_MS = 45_000;
const CHUNK_BYTES = 64 * 1024;
type BookWindow = Window & {
    bookStream?: {
        reader: ReadableStreamBYOBReader;
        decoder: TextDecoder;
        bytes: number;
    };
};

/** Pull one bounded piece of UTF-8 at a time. The next read waits until the
 * indexer has validated and staged the finished orders from this piece. */
async function* readBookChunks(page: Page) {
    for (;;) {
        const chunk = await page.evaluate(
            async ({ size, limit }) => {
                const stream = (window as BookWindow).bookStream!;
                const { done, value } = await stream.reader.read(
                    new Uint8Array(size),
                );
                stream.bytes += value?.byteLength ?? 0;
                if (stream.bytes > limit) {
                    await stream.reader.cancel();
                    throw new Error("VVV response exceeds size limit");
                }
                return {
                    done,
                    text: stream.decoder.decode(value, { stream: !done }),
                };
            },
            { size: CHUNK_BYTES, limit: VVV_BOOK_LIMIT_BYTES },
        );
        if (chunk.text) yield chunk.text;
        if (chunk.done) return;
    }
}

/** The catalog's public JSON document establishes the origin for anonymous
 * in-page book requests. Keep its browser open across scheduled reads. */
export class VvvBrowserBookReader {
    private browser: Browser | null = null;
    private page: Page | null = null;

    constructor(
        private readonly markets: readonly VvvMarketLocation[] = VVV_MARKETS,
    ) {}

    async read(market: BookMarket, visit: (record: BookObservation) => void) {
        const location = this.markets.find(
            ({ market: entry }) =>
                entry.venue === market.venue &&
                entry.chainId === market.chainId &&
                entry.reference === market.reference &&
                entry.contract === market.contract,
        );
        if (!location) throw new Error("Unrecognized VVV market");
        const page = await this.session(location);
        const timeout = setTimeout(() => {
            void page.close().catch(() => {});
        }, BOOK_TIMEOUT_MS);
        try {
            await page.evaluate(async (url) => {
                const response = await fetch(url, {
                    cache: "no-store",
                    credentials: "omit",
                    redirect: "error",
                    headers: { Accept: "application/json" },
                });
                if (!response.ok)
                    throw new Error(
                        "VVV book unavailable (HTTP " + response.status + ")",
                    );
                if (
                    !response.headers
                        .get("content-type")
                        ?.includes("application/json") ||
                    !response.body
                )
                    throw new Error("Expected VVV book JSON");
                (window as BookWindow).bookStream = {
                    reader: response.body.getReader({ mode: "byob" }),
                    decoder: new TextDecoder("utf-8", { fatal: true }),
                    bytes: 0,
                };
            }, location.bookUrl);
            await consumeVvvBookStream(market, readBookChunks(page), visit);
        } catch (error) {
            await this.close();
            throw error;
        } finally {
            clearTimeout(timeout);
            if (!page.isClosed())
                await page.evaluate(() => {
                    delete (window as BookWindow).bookStream;
                });
        }
    }

    private async session(market: VvvMarketLocation) {
        if (
            this.page?.url() === market.readerUrl &&
            !this.page.isClosed() &&
            this.browser?.isConnected()
        )
            return this.page;
        if (!this.browser?.isConnected()) {
            await this.close();
            const { chromium } = await import("playwright-core");
            this.browser = await chromium.launch({ timeout: BOOK_TIMEOUT_MS });
        }
        try {
            await this.page?.close();
            const page = await this.browser.newPage({
                serviceWorkers: "block",
                acceptDownloads: false,
            });
            await page.route("**/*", (route) => {
                const request = route.request();
                return request.method() === "GET" &&
                    (request.url() === market.readerUrl ||
                        request.url() === market.bookUrl)
                    ? route.fallback()
                    : route.abort();
            });
            const response = await page.goto(market.readerUrl, {
                waitUntil: "domcontentloaded",
                timeout: BOOK_TIMEOUT_MS,
            });
            if (!response?.ok())
                throw new Error(
                    "VVV reader unavailable (HTTP " + response?.status() + ")",
                );
            if (
                response.url() !== market.readerUrl ||
                !response
                    .headers()
                    ["content-type"]?.includes("application/json")
            )
                throw new Error("Expected the VVV public JSON reader document");
            this.page = page;
            return page;
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async close() {
        const browser = this.browser;
        this.browser = null;
        this.page = null;
        await browser?.close();
    }
}
