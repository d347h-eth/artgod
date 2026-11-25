import type { Browser, Page } from "playwright-core";
import {
    VVV_BOOK_LIMIT_BYTES,
    VVV_MARKET,
    consumeVvvBook,
} from "./vvv-orderbook.js";
import type { BookMarket, BookObservation } from "../../domain/orderbook.js";

const STATE_URL = "https://www.vvv.so/api/111k/state?orders=1";
const READER_PAGE = new URL("/artgod-orderbook-reader", STATE_URL).href;
const BOOK_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 64;
type BookWindow = Window & { bookRows?: unknown[] };

/** Chromium makes one identified anonymous request to the public book. The
 * same-origin reader document is local, so the session runs only our decoder. */
export class VvvBrowserBookReader {
    private browser: Browser | null = null;
    private page: Page | null = null;

    async read(market: BookMarket, visit: (record: BookObservation) => void) {
        if (
            market.chainId !== VVV_MARKET.chainId ||
            market.reference !== VVV_MARKET.reference ||
            market.contract !== VVV_MARKET.contract
        )
            throw new Error("Unrecognized VVV market");
        const page = await this.session();
        const timeout = setTimeout(() => {
            void page.close().catch(() => {});
        }, BOOK_TIMEOUT_MS);
        try {
            const header = await page.evaluate(
                async ({ url, maxBytes }) => {
                    const response = await fetch(url, {
                        cache: "no-store",
                        credentials: "omit",
                        redirect: "error",
                        headers: { Accept: "application/json" },
                    });
                    if (!response.ok)
                        throw new Error(
                            "VVV book unavailable (HTTP " +
                                response.status +
                                ")",
                        );
                    if (
                        !response.headers
                            .get("content-type")
                            ?.includes("application/json") ||
                        !response.body
                    )
                        throw new Error("Expected VVV book JSON");
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder("utf-8", { fatal: true });
                    const parts: string[] = [];
                    let bytes = 0;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        if (bytes > maxBytes) {
                            await reader.cancel();
                            throw new Error("VVV response exceeds size limit");
                        }
                        parts.push(decoder.decode(value, { stream: true }));
                    }
                    parts.push(decoder.decode());
                    const { chainId, contract, orders } = JSON.parse(
                        parts.join(""),
                    );
                    if (!Array.isArray(orders))
                        throw new Error("Invalid VVV orders");
                    (window as BookWindow).bookRows = orders;
                    return { chainId, contract, length: orders.length };
                },
                { url: STATE_URL, maxBytes: VVV_BOOK_LIMIT_BYTES },
            );
            await consumeVvvBook(market, { ...header, orders: [] }, visit);
            for (let start = 0; start < header.length; start += PAGE_SIZE) {
                const orders = await page.evaluate(
                    ([offset, count]) =>
                        (window as BookWindow).bookRows!.slice(
                            offset,
                            offset + count,
                        ),
                    [start, PAGE_SIZE] as const,
                );
                await consumeVvvBook(market, { ...header, orders }, visit);
            }
        } catch (error) {
            await this.close();
            throw error;
        } finally {
            clearTimeout(timeout);
            if (!page.isClosed())
                await page.evaluate(() => {
                    delete (window as BookWindow).bookRows;
                });
        }
    }

    private async session() {
        if (this.page && !this.page.isClosed() && this.browser?.isConnected())
            return this.page;
        await this.close();
        const { chromium } = await import("playwright-core");
        this.browser = await chromium.launch({ timeout: BOOK_TIMEOUT_MS });
        try {
            const page = await this.browser.newPage({
                serviceWorkers: "block",
                userAgent: "ArtGod-Orderbook",
            });
            await page.route(READER_PAGE, (route) =>
                route.fulfill({
                    contentType: "text/html",
                    body: "<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; connect-src 'self'\"><title>Orderbook</title>",
                }),
            );
            await page.goto(READER_PAGE);
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
