#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_COLLECTION_SLUG = "milady";
const DEFAULT_COLLECTION_ADDRESS = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";
const DEFAULT_LIMIT = 100;
const DEFAULT_SLEEP_MS = 350;
const DEFAULT_MAX_PAGES = 300;
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OPENSEA_ALL_OFFERS_URL =
    "https://api.opensea.io/api/v2/offers/collection";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log(renderUsage());
    process.exit(0);
}
const envFile = args.envfile ?? args.envFile;
if (!envFile) {
    console.error(`Missing required --envfile argument.\n\n${renderUsage()}`);
    process.exit(1);
}
const collectionSlug = args.slug ?? DEFAULT_COLLECTION_SLUG;
const collectionAddress = (
    args.address ?? DEFAULT_COLLECTION_ADDRESS
).toLowerCase();
const outputDir =
    args.outDir ??
    path.join(
        "tmp",
        "offer-depth",
        `${collectionSlug}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
const pageLimit = parsePositiveInt(args.limit, DEFAULT_LIMIT);
const sleepMs = parseNonNegativeInt(args.sleepMs, DEFAULT_SLEEP_MS);
const maxPages = parsePositiveInt(args.maxPages, DEFAULT_MAX_PAGES);
const thresholdOverrideWei =
    args.thresholdEth === undefined
        ? undefined
        : ethDecimalToWei(String(args.thresholdEth));

const env = await readEnvFile(envFile);
const apiKey = resolveApiKey(env, args.apiKeyName);
if (!apiKey) {
    throw new Error(
        `OpenSea API key not found. Checked ${describeKeyLookup(args.apiKeyName)} in ${
            envFile
        }`,
    );
}

await mkdir(outputDir, { recursive: true });

const startedAt = new Date();
const pageRows = [];
const offers = [];
let next;

console.log(
    `Fetching ${collectionSlug} all-offers snapshot with limit=${pageLimit}, maxPages=${maxPages}.`,
);
console.log(`Output directory: ${outputDir}`);

for (let page = 1; page <= maxPages; page += 1) {
    const pageStartedAt = performance.now();
    const response = await fetchAllOffersPage({
        apiKey,
        collectionSlug,
        limit: pageLimit,
        next,
    });
    const durationMs = Math.round(performance.now() - pageStartedAt);
    const rawOffers = Array.isArray(response.offers) ? response.offers : [];
    const parsedOffers = rawOffers.flatMap((rawOffer) => {
        const parsed = parseOffer(rawOffer, collectionAddress);
        return parsed ? [parsed] : [];
    });
    const scopeCounts = countBy(parsedOffers, (offer) => offer.scope);
    parsedOffers.forEach((offer) => offers.push({ ...offer, page }));

    pageRows.push({
        page,
        requestMs: durationMs,
        rawOfferCount: rawOffers.length,
        parsedOfferCount: parsedOffers.length,
        firstWei: parsedOffers[0]?.priceWei ?? null,
        lastWei: parsedOffers[parsedOffers.length - 1]?.priceWei ?? null,
        maxWei: maxBigInt(parsedOffers.map((offer) => offer.priceWei)),
        minWei: minBigInt(parsedOffers.map((offer) => offer.priceWei)),
        medianWei: medianBigInt(parsedOffers.map((offer) => offer.priceWei)),
        collectionCount: scopeCounts.collection ?? 0,
        traitCount: scopeCounts.trait ?? 0,
        tokenCount: scopeCounts.token ?? 0,
        tokenSetCount: scopeCounts.token_set ?? 0,
        unknownCount: scopeCounts.unknown ?? 0,
        nextCursorPresent: typeof response.next === "string" && response.next.length > 0,
    });

    console.log(
        [
            `page=${page}`,
            `offers=${rawOffers.length}`,
            `parsed=${parsedOffers.length}`,
            `first=${formatWeiEth(parsedOffers[0]?.priceWei)}`,
            `last=${formatWeiEth(parsedOffers[parsedOffers.length - 1]?.priceWei)}`,
            `ms=${durationMs}`,
            `next=${response.next ? "yes" : "no"}`,
        ].join(" "),
    );

    next = typeof response.next === "string" ? response.next : undefined;
    if (!next || rawOffers.length === 0) {
        break;
    }
    if (sleepMs > 0) {
        await sleep(sleepMs);
    }
}

const completedAt = new Date();
const collectionOffers = offers.filter((offer) => offer.scope === "collection");
const traitOffers = offers.filter((offer) => offer.scope === "trait");
const tokenOffers = offers.filter((offer) => offer.scope === "token");
const thresholdWei =
    thresholdOverrideWei ??
    maxBigInt(collectionOffers.map((offer) => offer.priceWei)) ??
    0n;
const thresholdSource =
    thresholdOverrideWei === undefined
        ? "top collection-scoped offer"
        : "--threshold-eth";

const summary = buildSummary({
    collectionSlug,
    collectionAddress,
    startedAt,
    completedAt,
    pageLimit,
    sleepMs,
    maxPages,
    pageRows,
    offers,
    collectionOffers,
    traitOffers,
    tokenOffers,
    thresholdWei,
    thresholdSource,
});

await writeFile(
    path.join(outputDir, "summary.json"),
    JSON.stringify(summary, bigintJsonReplacer, 2),
);
await writeFile(path.join(outputDir, "pages.csv"), renderPagesCsv(pageRows));
await writeFile(path.join(outputDir, "offers.csv"), renderOffersCsv(offers));
await writeFile(path.join(outputDir, "report.html"), renderReport(summary, pageRows));

console.log("");
console.log(`Fetched pages: ${summary.pageCount}`);
console.log(`Parsed offers: ${summary.parsedOfferCount}`);
console.log(
    `Bid wall ceiling threshold: ${summary.thresholdEth} ETH (${summary.thresholdSource})`,
);
console.log(
    `Requests to cross threshold: ${
        summary.requestsToCrossThreshold ?? "not crossed"
    }`,
);
console.log(`HTML report: ${path.join(outputDir, "report.html")}`);
console.log(`Summary JSON: ${path.join(outputDir, "summary.json")}`);

function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            continue;
        }
        const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
        const key = rawKey.replace(/-([a-z])/g, (_, letter) =>
            letter.toUpperCase(),
        );
        const value =
            inlineValue ??
            (argv[index + 1] && !argv[index + 1].startsWith("--")
                ? argv[++index]
                : "true");
        parsed[key] = value;
    }
    return parsed;
}

function renderUsage() {
    return [
        "Usage:",
        "  node scripts/debug/milady-offer-depth.mjs --envfile <path> [options]",
        "",
        "Options:",
        "  --envfile <path>       Required env file containing an OpenSea API key.",
        "  --api-key-name <name>  Env key to read; defaults to snapshot, app, then bidding key lookup.",
        "  --slug <slug>         OpenSea collection slug. Default: milady.",
        "  --address <0x...>     Collection contract address. Default: Milady.",
        "  --threshold-eth <eth>  Override the collection bid-wall threshold.",
        "  --limit <count>       OpenSea page size. Default: 100.",
        "  --max-pages <count>   Maximum pages to fetch. Default: 300.",
        "  --sleep-ms <ms>       Delay between page requests. Default: 350.",
        "  --out-dir <path>      Output directory. Default: tmp/offer-depth/<slug>-<timestamp>.",
    ].join("\n");
}

async function readEnvFile(filePath) {
    const text = await readFile(filePath, "utf8");
    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }
        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}

function resolveApiKey(env, requestedName) {
    if (requestedName) {
        return env[requestedName] || process.env[requestedName];
    }
    for (const key of [
        "OPENSEA_SNAPSHOT_SECRET_KEY",
        "OPENSEA_API_KEY",
        "OPENSEA_BIDDING_SECRET_KEY",
    ]) {
        const value = env[key] || process.env[key];
        if (value) {
            return value;
        }
    }
    return undefined;
}

function describeKeyLookup(requestedName) {
    return (
        requestedName ??
        "OPENSEA_SNAPSHOT_SECRET_KEY, OPENSEA_API_KEY, OPENSEA_BIDDING_SECRET_KEY"
    );
}

async function fetchAllOffersPage({ apiKey, collectionSlug, limit, next }) {
    const url = new URL(
        `${OPENSEA_ALL_OFFERS_URL}/${encodeURIComponent(collectionSlug)}/all`,
    );
    url.searchParams.set("limit", String(limit));
    if (next) {
        url.searchParams.set("next", next);
    }

    let attempt = 0;
    while (true) {
        attempt += 1;
        const response = await fetch(url, {
            headers: {
                accept: "application/json",
                "x-api-key": apiKey,
            },
        });
        if (response.ok) {
            return await response.json();
        }
        const retryable =
            response.status === 429 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504;
        const body = await response.text();
        if (!retryable || attempt >= 5) {
            throw new Error(
                `OpenSea all-offers request failed: status=${response.status} body=${body.slice(
                    0,
                    500,
                )}`,
            );
        }
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoffMs = retryAfterMs ?? 1_000 * 2 ** (attempt - 1);
        console.warn(
            `Retrying OpenSea request after status=${response.status}, attempt=${attempt}, waitMs=${backoffMs}`,
        );
        await sleep(backoffMs);
    }
}

function parseRetryAfterMs(value) {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }
    return undefined;
}

function parseOffer(rawOffer, collectionAddress) {
    const price = extractWethUnitPrice(rawOffer, collectionAddress);
    const orderHash = stringOrUndefined(rawOffer?.orderHash) ??
        stringOrUndefined(rawOffer?.order_hash);
    const maker =
        stringOrUndefined(rawOffer?.maker?.address) ??
        stringOrUndefined(rawOffer?.maker) ??
        stringOrUndefined(getProtocolEnvelope(rawOffer)?.parameters?.offerer);
    if (!price || !orderHash || !maker) {
        return null;
    }
    return {
        orderHash,
        maker: maker.toLowerCase(),
        priceWei: price.price,
        priceEth: weiToEthNumber(price.price),
        priceSource: price.source,
        quantity: price.quantity,
        scope: resolveScope(rawOffer, collectionAddress),
    };
}

function extractWethUnitPrice(rawOrder, collectionAddress) {
    const proto = getProtocolEnvelope(rawOrder);
    if (proto?.parameters) {
        const offerSum = sumTokenItems(proto.parameters.offer, WETH_ADDRESS);
        const considerationSum = sumTokenItems(
            proto.parameters.consideration,
            WETH_ADDRESS,
        );
        const nftUnitsFromConsideration = sumNftUnits(
            proto.parameters.consideration,
            collectionAddress,
        );
        const nftUnitsFromOffer = sumNftUnits(
            proto.parameters.offer,
            collectionAddress,
        );
        const nftUnits =
            nftUnitsFromConsideration > 0n
                ? nftUnitsFromConsideration
                : nftUnitsFromOffer;
        const orderType = proto.parameters.orderType ?? proto.parameters.order_type;
        const remainingQuantityRaw =
            rawOrder?.remainingQuantity ?? rawOrder?.remaining_quantity;
        const remainingQuantity = tryParseNumber(remainingQuantityRaw);
        const isPartial =
            isPartialOrderType(orderType) ||
            (remainingQuantity !== null && remainingQuantity > 1);

        if (offerSum > 0n || considerationSum > 0n) {
            const total =
                offerSum >= considerationSum
                    ? { value: offerSum, source: "protocol.offer" }
                    : {
                          value: considerationSum,
                          source: "protocol.consideration",
                      };
            const quantity = nftUnits > 0n ? nftUnits : 1n;
            if (isPartial && quantity > 1n) {
                return {
                    price: divCeil(total.value, quantity),
                    source: `${total.source}/unit`,
                    quantity,
                };
            }
            return {
                price: total.value,
                source: total.source,
                quantity,
            };
        }
    }

    const priceRecord = asRecord(rawOrder?.price);
    const priceValue = tryParseBigInt(priceRecord.value);
    const priceCurrency = stringOrUndefined(priceRecord.currency);
    if (priceValue !== null && priceCurrency && isWethCurrency(priceCurrency)) {
        return { price: priceValue, source: "price.value", quantity: 1n };
    }

    const currentPrice =
        tryParseBigInt(rawOrder?.currentPrice) ??
        tryParseBigInt(rawOrder?.current_price);
    if (currentPrice !== null && isWethOrder(rawOrder)) {
        return { price: currentPrice, source: "currentPrice", quantity: 1n };
    }

    return null;
}

function resolveScope(rawOffer, collectionAddress) {
    const explicitTokenId = getExplicitTokenId(rawOffer, collectionAddress);
    if (explicitTokenId) {
        return "token";
    }

    const criteria = getOfferCriteria(rawOffer);
    const traits = normalizeTraitCriteria(criteria);
    if (traits.length > 0) {
        return "trait";
    }

    const encodedTokenIds = getEncodedTokenIds(criteria);
    if (encodedTokenIds && encodedTokenIds !== "*") {
        return "token_set";
    }

    if (criteria || inferNftSelectionKind(rawOffer, collectionAddress) === "criteria") {
        return "collection";
    }

    return "unknown";
}

function getOfferCriteria(rawOffer) {
    return (
        recordOrUndefined(rawOffer?.criteria) ??
        recordOrUndefined(rawOffer?.protocolData?.criteria) ??
        recordOrUndefined(rawOffer?.protocol_data?.criteria)
    );
}

function normalizeTraitCriteria(criteria) {
    if (!criteria) {
        return [];
    }
    if (Array.isArray(criteria)) {
        return dedupeTraits(criteria.flatMap((entry) => normalizeTraitCriteria(entry)));
    }
    const candidate = asRecord(criteria);
    const traitCriteria = candidate.trait ?? candidate.traits;
    const normalized = [];
    if (traitCriteria !== undefined && traitCriteria !== null) {
        normalized.push(...normalizeTraitCriteria(traitCriteria));
    }
    if (Array.isArray(candidate.numeric_traits)) {
        for (const numericTrait of candidate.numeric_traits) {
            const type =
                stringOrUndefined(numericTrait?.type) ??
                stringOrUndefined(numericTrait?.trait_type);
            const value = numericTrait?.value ?? numericTrait?.trait_value;
            if (type && value !== undefined && value !== null) {
                normalized.push({
                    type: normalizeTraitText(type),
                    value: normalizeTraitText(String(value)),
                });
            }
        }
    }
    if (normalized.length > 0) {
        return dedupeTraits(normalized);
    }
    if (isCriteriaEnvelope(candidate)) {
        return [];
    }
    const type =
        stringOrUndefined(candidate.type) ??
        stringOrUndefined(candidate.trait_type);
    const value = candidate.value ?? candidate.trait_value;
    if (type && value !== undefined && value !== null) {
        return dedupeTraits([
            {
                type: normalizeTraitText(type),
                value: normalizeTraitText(String(value)),
            },
        ]);
    }
    return dedupeTraits(
        Object.entries(candidate).flatMap(([key, rawValue]) => {
            if (
                rawValue === undefined ||
                rawValue === null ||
                typeof rawValue === "object"
            ) {
                return [];
            }
            return [
                {
                    type: normalizeTraitText(key),
                    value: normalizeTraitText(String(rawValue)),
                },
            ];
        }),
    );
}

function normalizeTraitText(value) {
    return String(value).trim();
}

function dedupeTraits(traits) {
    const seen = new Set();
    const deduped = [];
    for (const trait of traits) {
        const key = `${trait.type}\0${trait.value}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(trait);
    }
    return deduped;
}

function isCriteriaEnvelope(record) {
    return (
        "merkle_root" in record ||
        "merkleRoot" in record ||
        "encoded_token_ids" in record ||
        "encodedTokenIds" in record ||
        "contract" in record
    );
}

function getEncodedTokenIds(criteria) {
    return (
        stringOrUndefined(criteria?.encoded_token_ids) ??
        stringOrUndefined(criteria?.encodedTokenIds)
    );
}

function getExplicitTokenId(rawOffer, collectionAddress) {
    const nftItems = getNftItems(rawOffer, collectionAddress);
    const item = nftItems.find((candidate) =>
        [2, 3].includes(readItemType(candidate)),
    );
    if (!item) {
        return null;
    }
    return (
        stringOrUndefined(item.identifierOrCriteria) ??
        stringOrUndefined(item.identifier_or_criteria) ??
        null
    );
}

function inferNftSelectionKind(rawOffer, collectionAddress) {
    const nftItems = getNftItems(rawOffer, collectionAddress);
    if (nftItems.length === 0) {
        return "unknown";
    }
    if (nftItems.some((item) => [2, 3].includes(readItemType(item)))) {
        return "item";
    }
    if (nftItems.some((item) => [4, 5].includes(readItemType(item)))) {
        return "criteria";
    }
    return "unknown";
}

function getNftItems(rawOrder, collectionAddress) {
    const parameters = getProtocolEnvelope(rawOrder)?.parameters;
    const items = [
        ...arrayOrEmpty(parameters?.offer),
        ...arrayOrEmpty(parameters?.consideration),
    ];
    return items.filter((item) => {
        const itemType = readItemType(item);
        if (![2, 3, 4, 5].includes(itemType)) {
            return false;
        }
        const token = stringOrUndefined(item?.token)?.toLowerCase();
        return !collectionAddress || !token || token === collectionAddress;
    });
}

function getProtocolEnvelope(rawOrder) {
    return (
        recordOrUndefined(rawOrder?.protocolData) ??
        recordOrUndefined(rawOrder?.protocol_data)
    );
}

function sumTokenItems(items, tokenAddress) {
    return arrayOrEmpty(items)
        .filter((item) => isWethCurrency(item?.token, tokenAddress))
        .reduce((sum, item) => {
            const start = tryParseBigInt(item?.startAmount ?? item?.start_amount);
            const end = tryParseBigInt(item?.endAmount ?? item?.end_amount);
            return sum + (end ?? start ?? 0n);
        }, 0n);
}

function sumNftUnits(items, collectionAddress) {
    return arrayOrEmpty(items)
        .filter((item) => {
            const itemType = readItemType(item);
            if (![2, 3, 4, 5].includes(itemType)) {
                return false;
            }
            const token = stringOrUndefined(item?.token)?.toLowerCase();
            return !collectionAddress || !token || token === collectionAddress;
        })
        .reduce((sum, item) => {
            const start = tryParseBigInt(item?.startAmount ?? item?.start_amount);
            const end = tryParseBigInt(item?.endAmount ?? item?.end_amount);
            return sum + (end ?? start ?? 1n);
        }, 0n);
}

function readItemType(item) {
    const parsed = tryParseNumber(item?.itemType ?? item?.item_type);
    return parsed ?? -1;
}

function isWethOrder(rawOrder) {
    const protocolParameters = getProtocolEnvelope(rawOrder)?.parameters;
    const allItems = [
        ...arrayOrEmpty(protocolParameters?.offer),
        ...arrayOrEmpty(protocolParameters?.consideration),
    ];
    return allItems.some((item) => isWethCurrency(item?.token));
}

function isWethCurrency(value, wethAddress = WETH_ADDRESS) {
    return stringOrUndefined(value)?.toLowerCase() === wethAddress.toLowerCase();
}

function isPartialOrderType(orderType) {
    const parsed = tryParseNumber(orderType);
    return parsed === 1 || parsed === 3;
}

function divCeil(value, divisor) {
    return (value + divisor - 1n) / divisor;
}

function buildSummary({
    collectionSlug,
    collectionAddress,
    startedAt,
    completedAt,
    pageLimit,
    sleepMs,
    maxPages,
    pageRows,
    offers,
    collectionOffers,
    traitOffers,
    tokenOffers,
    thresholdWei,
    thresholdSource,
}) {
    const thresholdCrossPage =
        pageRows.find(
            (page) => page.minWei !== null && page.minWei <= thresholdWei,
        )?.page ?? null;
    const firstPageBelowThreshold =
        pageRows.find(
            (page) => page.maxWei !== null && page.maxWei < thresholdWei,
        )?.page ?? null;
    const requestsSavedAtThreshold =
        thresholdCrossPage === null ? 0 : Math.max(0, pageRows.length - thresholdCrossPage);
    const offersAtOrAboveThreshold = offers.filter(
        (offer) => offer.priceWei >= thresholdWei,
    ).length;
    const totalRequestMs = pageRows.reduce((sum, page) => sum + page.requestMs, 0);
    const scopeCounts = countBy(offers, (offer) => offer.scope);

    return {
        collectionSlug,
        collectionAddress,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        elapsedMs: completedAt.getTime() - startedAt.getTime(),
        totalRequestMs,
        pageLimit,
        sleepMs,
        maxPages,
        pageCount: pageRows.length,
        rawOfferCount: pageRows.reduce((sum, page) => sum + page.rawOfferCount, 0),
        parsedOfferCount: offers.length,
        scopeCounts,
        topPriceEth: formatWeiEth(maxBigInt(offers.map((offer) => offer.priceWei))),
        lowestFetchedPriceEth: formatWeiEth(
            minBigInt(offers.map((offer) => offer.priceWei)),
        ),
        topCollectionPriceEth: formatWeiEth(
            maxBigInt(collectionOffers.map((offer) => offer.priceWei)),
        ),
        topTraitPriceEth: formatWeiEth(
            maxBigInt(traitOffers.map((offer) => offer.priceWei)),
        ),
        topTokenPriceEth: formatWeiEth(
            maxBigInt(tokenOffers.map((offer) => offer.priceWei)),
        ),
        thresholdWei,
        thresholdEth: formatWeiEth(thresholdWei),
        thresholdSource,
        requestsToCrossThreshold: thresholdCrossPage,
        firstPageWhollyBelowThreshold: firstPageBelowThreshold,
        requestsSavedAtThreshold,
        offersAtOrAboveThreshold,
        thresholdShareOfOffers:
            offers.length === 0 ? 0 : offersAtOrAboveThreshold / offers.length,
        pageSummaries: pageRows.map((page) => ({
            ...page,
            firstEth: formatWeiEth(page.firstWei),
            lastEth: formatWeiEth(page.lastWei),
            maxEth: formatWeiEth(page.maxWei),
            minEth: formatWeiEth(page.minWei),
            medianEth: formatWeiEth(page.medianWei),
        })),
    };
}

function renderPagesCsv(pageRows) {
    const header = [
        "page",
        "request_ms",
        "raw_offer_count",
        "parsed_offer_count",
        "first_eth",
        "last_eth",
        "max_eth",
        "min_eth",
        "median_eth",
        "collection_count",
        "trait_count",
        "token_count",
        "token_set_count",
        "unknown_count",
        "next_cursor_present",
    ];
    const rows = pageRows.map((page) => [
        page.page,
        page.requestMs,
        page.rawOfferCount,
        page.parsedOfferCount,
        formatWeiEth(page.firstWei),
        formatWeiEth(page.lastWei),
        formatWeiEth(page.maxWei),
        formatWeiEth(page.minWei),
        formatWeiEth(page.medianWei),
        page.collectionCount,
        page.traitCount,
        page.tokenCount,
        page.tokenSetCount,
        page.unknownCount,
        page.nextCursorPresent,
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function renderOffersCsv(offers) {
    const header = [
        "page",
        "order_hash",
        "maker",
        "scope",
        "price_eth",
        "price_wei",
        "price_source",
        "quantity",
    ];
    const rows = offers.map((offer) => [
        offer.page,
        offer.orderHash,
        offer.maker,
        offer.scope,
        formatWeiEth(offer.priceWei),
        offer.priceWei.toString(),
        offer.priceSource,
        offer.quantity.toString(),
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function renderReport(summary, pageRows) {
    const chart = renderSvgChart(summary, pageRows);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(summary.collectionSlug)} offer depth</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #242222;
      --panel: #2e2b2a;
      --text: #f4efe8;
      --muted: #b8afa8;
      --cyan: #9ee7f5;
      --pink: #ff9bc8;
      --yellow: #fff129;
      --orange: #ff8a3d;
      --line: #5b5550;
    }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    h1, h2 { margin: 0 0 12px; color: var(--pink); letter-spacing: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 16px; margin-top: 28px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin: 18px 0;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 10px 12px;
    }
    .metric strong { display: block; color: var(--yellow); font-size: 18px; }
    .metric span { color: var(--muted); font-size: 12px; }
    .chart {
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 12px;
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      background: var(--panel);
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 6px 8px;
      text-align: right;
      white-space: nowrap;
    }
    th:first-child, td:first-child { text-align: left; }
    th { color: var(--pink); }
    .note { color: var(--muted); max-width: 980px; }
    .legend { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); }
    .swatch { display: inline-block; width: 18px; height: 3px; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <h1>${escapeHtml(summary.collectionSlug)} all-offers depth</h1>
  <p class="note">Generated ${escapeHtml(summary.completedAt)}. Threshold defaults to the top collection-scoped offer unless <code>--threshold-eth</code> is provided.</p>
  <div class="grid">
    ${metric("Pages fetched", summary.pageCount)}
    ${metric("Parsed offers", summary.parsedOfferCount)}
    ${metric("Top price", `${summary.topPriceEth} ETH`)}
    ${metric("Lowest fetched", `${summary.lowestFetchedPriceEth} ETH`)}
    ${metric("Bid wall ceiling", `${summary.thresholdEth} ETH`)}
    ${metric("Requests to cross", summary.requestsToCrossThreshold ?? "not crossed")}
    ${metric("Requests saved", summary.requestsSavedAtThreshold)}
    ${metric("Offers >= threshold", `${summary.offersAtOrAboveThreshold} (${formatPercent(summary.thresholdShareOfOffers)})`)}
  </div>
  <div class="legend">
    <span><i class="swatch" style="background: var(--cyan)"></i>page first/last band</span>
    <span><i class="swatch" style="background: var(--yellow)"></i>page median</span>
    <span><i class="swatch" style="background: var(--orange)"></i>bid wall ceiling</span>
  </div>
  <div class="chart">${chart}</div>
  <h2>Scope summary</h2>
  <table>
    <thead><tr><th>Scope</th><th>Offers</th></tr></thead>
    <tbody>
      ${Object.entries(summary.scopeCounts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(
              ([scope, count]) =>
                  `<tr><td>${escapeHtml(scope)}</td><td>${count}</td></tr>`,
          )
          .join("")}
    </tbody>
  </table>
  <h2>Top page samples</h2>
  <table>
    <thead><tr><th>Page</th><th>First ETH</th><th>Median ETH</th><th>Last ETH</th><th>Token</th><th>Trait</th><th>Collection</th><th>Request ms</th></tr></thead>
    <tbody>
      ${summary.pageSummaries
          .slice(0, 40)
          .map(
              (page) =>
                  `<tr><td>${page.page}</td><td>${page.firstEth}</td><td>${page.medianEth}</td><td>${page.lastEth}</td><td>${page.tokenCount}</td><td>${page.traitCount}</td><td>${page.collectionCount}</td><td>${page.requestMs}</td></tr>`,
          )
          .join("")}
    </tbody>
  </table>
</body>
</html>`;
}

function renderSvgChart(summary, pageRows) {
    const width = Math.max(980, pageRows.length * 8 + 120);
    const height = 520;
    const margin = { top: 34, right: 32, bottom: 58, left: 82 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const maxEth = Math.max(
        Number(summary.topPriceEth) || 0,
        Number(summary.thresholdEth) || 0,
    );
    const minEth = 0;
    const x = (page) =>
        margin.left + ((page - 1) / Math.max(1, pageRows.length - 1)) * innerWidth;
    const y = (eth) =>
        margin.top +
        innerHeight -
        ((Math.max(minEth, Math.min(maxEth, eth)) - minEth) /
            Math.max(0.0000001, maxEth - minEth)) *
            innerHeight;
    const thresholdY = y(Number(summary.thresholdEth));
    const crossingX =
        summary.requestsToCrossThreshold === null
            ? null
            : x(summary.requestsToCrossThreshold);
    const bandPath = pageRows
        .map((page, index) => {
            const px = x(page.page);
            const py = y(weiToEthNumber(page.firstWei ?? page.maxWei ?? 0n));
            return `${index === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
        })
        .join(" ");
    const bandBottom = pageRows
        .slice()
        .reverse()
        .map((page) => {
            const px = x(page.page);
            const py = y(weiToEthNumber(page.lastWei ?? page.minWei ?? 0n));
            return `L${px.toFixed(2)},${py.toFixed(2)}`;
        })
        .join(" ");
    const medianPath = pageRows
        .map((page, index) => {
            const px = x(page.page);
            const py = y(weiToEthNumber(page.medianWei ?? page.lastWei ?? 0n));
            return `${index === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
        })
        .join(" ");
    const yTicks = makeTicks(maxEth, 6);
    const xTicks = makeTicks(pageRows.length, Math.min(12, pageRows.length)).map(
        (tick) => Math.max(1, Math.round(tick)),
    );

    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Offer price by request depth">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#2e2b2a" />
      ${yTicks
          .map(
              (tick) =>
                  `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#5b5550" stroke-width="1" />
                   <text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end" fill="#b8afa8" font-size="12">${tick.toFixed(3)}</text>`,
          )
          .join("")}
      ${xTicks
          .map(
              (tick) =>
                  `<line x1="${x(tick)}" x2="${x(tick)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#3f3a37" stroke-width="1" />
                   <text x="${x(tick)}" y="${height - margin.bottom + 22}" text-anchor="middle" fill="#b8afa8" font-size="12">${tick}</text>`,
          )
          .join("")}
      <path d="${bandPath} ${bandBottom} Z" fill="#9ee7f5" opacity="0.22" />
      <path d="${bandPath}" fill="none" stroke="#9ee7f5" stroke-width="2" />
      <path d="${medianPath}" fill="none" stroke="#fff129" stroke-width="2" />
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${thresholdY}" y2="${thresholdY}" stroke="#ff8a3d" stroke-width="3" stroke-dasharray="8 6" />
      ${
          crossingX === null
              ? ""
              : `<line x1="${crossingX}" x2="${crossingX}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#ff8a3d" stroke-width="2" opacity="0.65" />`
      }
      <text x="${margin.left}" y="${margin.top - 12}" fill="#ff8a3d" font-size="13">bid wall ceiling ${escapeHtml(summary.thresholdEth)} ETH</text>
      <text x="${margin.left + innerWidth / 2}" y="${height - 14}" fill="#b8afa8" font-size="13" text-anchor="middle">OpenSea all-offers request/page depth</text>
      <text transform="translate(20 ${margin.top + innerHeight / 2}) rotate(-90)" fill="#b8afa8" font-size="13" text-anchor="middle">offer value ETH</text>
    </svg>`;
}

function metric(label, value) {
    return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function makeTicks(max, count) {
    if (max <= 0 || count <= 1) {
        return [0];
    }
    return Array.from({ length: count }, (_, index) => (max * index) / (count - 1));
}

function countBy(values, getKey) {
    const counts = {};
    for (const value of values) {
        const key = getKey(value);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

function maxBigInt(values) {
    const present = values.filter((value) => typeof value === "bigint");
    if (present.length === 0) {
        return null;
    }
    return present.reduce((max, value) => (value > max ? value : max), present[0]);
}

function minBigInt(values) {
    const present = values.filter((value) => typeof value === "bigint");
    if (present.length === 0) {
        return null;
    }
    return present.reduce((min, value) => (value < min ? value : min), present[0]);
}

function medianBigInt(values) {
    const present = values
        .filter((value) => typeof value === "bigint")
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (present.length === 0) {
        return null;
    }
    return present[Math.floor(present.length / 2)];
}

function ethDecimalToWei(value) {
    const [wholeRaw, fractionRaw = ""] = value.split(".");
    const whole = wholeRaw || "0";
    const fraction = fractionRaw.padEnd(18, "0").slice(0, 18);
    return BigInt(whole) * 10n ** 18n + BigInt(fraction || "0");
}

function weiToEthNumber(value) {
    if (typeof value !== "bigint") {
        return 0;
    }
    return Number(value) / 1e18;
}

function formatWeiEth(value) {
    if (typeof value !== "bigint") {
        return "";
    }
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0");
    return `${whole}.${fraction.slice(0, 6)}`.replace(/\.?0+$/, "");
}

function formatPercent(value) {
    return `${(value * 100).toFixed(2)}%`;
}

function tryParseBigInt(value) {
    if (typeof value === "bigint") {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        return BigInt(value);
    }
    return null;
}

function tryParseNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
}

function asRecord(value) {
    return value && typeof value === "object" ? value : {};
}

function recordOrUndefined(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}

function stringOrUndefined(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function csvCell(value) {
    const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function bigintJsonReplacer(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
