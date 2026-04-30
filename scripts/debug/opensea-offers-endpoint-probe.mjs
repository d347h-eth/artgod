#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_COLLECTION_SLUG = "terraforms";
const DEFAULT_CONTRACT_ADDRESS = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const OPENSEA_API_BASE_URL = "https://api.opensea.io";

const args = parseArgs(process.argv.slice(2));
const env = loadEnvFile(resolve(process.cwd(), ".env"));
const collectionSlug = args.collection ?? DEFAULT_COLLECTION_SLUG;
const contractAddress = (args.contract ?? DEFAULT_CONTRACT_ADDRESS).toLowerCase();
const limit = parsePositiveInteger(args.limit, 100);
const maxPages = parsePositiveInteger(args.pages, 20);
const outputDir = args.outputDir ?? args["output-dir"] ?? args.out;
const apiKey =
    process.env.OPENSEA_SNAPSHOT_SECRET_KEY ??
    env.OPENSEA_SNAPSHOT_SECRET_KEY ??
    process.env.OPENSEA_API_KEY ??
    env.OPENSEA_API_KEY;

if (!apiKey || !apiKey.trim()) {
    throw new Error("Missing OPENSEA_SNAPSHOT_SECRET_KEY or OPENSEA_API_KEY in environment/.env");
}

const offers = [];
const pages = [];
let next;
for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
        `/api/v2/offers/collection/${encodeURIComponent(collectionSlug)}/all`,
        OPENSEA_API_BASE_URL,
    );
    url.searchParams.set("limit", String(limit));
    if (next) {
        url.searchParams.set("next", next);
    }

    const response = await fetch(url, {
        headers: {
            accept: "application/json",
            "x-api-key": apiKey,
        },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenSea request failed: status=${response.status}, body=${body.slice(0, 500)}`);
    }

    const payload = await response.json();
    const pageOffers = Array.isArray(payload.offers) ? payload.offers : [];
    pages.push({
        page,
        next: typeof payload.next === "string" ? payload.next : null,
        offerCount: pageOffers.length,
        response: payload,
    });
    offers.push(...pageOffers);
    console.log(`page=${page} offers=${pageOffers.length} next=${payload.next ? "yes" : "no"}`);

    if (!payload.next) {
        break;
    }
    next = payload.next;
}

const classified = offers.map((offer) => classifyOffer(offer, contractAddress));
const counts = countBy(classified.map((entry) => entry.classification));
const tokenScoped = classified.filter((entry) => entry.classification === "token-scoped");
const criteriaScoped = classified.filter((entry) => entry.classification === "criteria-scoped");
const collectionScoped = classified.filter((entry) => entry.classification === "collection-scoped");
const unknownScoped = classified.filter((entry) => entry.classification === "unknown");

console.log("\n== Endpoint ==");
console.log(`path=/api/v2/offers/collection/${collectionSlug}/all`);
console.log(`collection=${collectionSlug}`);
console.log(`contract=${contractAddress}`);
console.log(`pagesFetched=${Math.min(maxPages, Math.ceil(offers.length / limit) || 1)}`);
console.log(`totalOffers=${offers.length}`);

console.log("\n== Classification ==");
Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => console.log(`${key}: ${value}`));

printSamples("token-scoped", tokenScoped);
printSamples("criteria-scoped", criteriaScoped);
printSamples("collection-scoped", collectionScoped);
printSamples("unknown", unknownScoped);

if (outputDir) {
    const outputPath = writeDumpFile(outputDir, {
        endpoint: {
            path: `/api/v2/offers/collection/${collectionSlug}/all`,
            collectionSlug,
            contractAddress,
            limit,
            maxPages,
            fetchedAt: new Date().toISOString(),
        },
        summary: {
            totalOffers: offers.length,
            classificationCounts: counts,
        },
        classifications: classified,
        pages,
        offers,
    });
    console.log(`\nDump written: ${outputPath}`);
}

function classifyOffer(rawOffer, targetContractAddress) {
    const record = asRecord(rawOffer);
    const protocolData = asRecord(record.protocol_data ?? record.protocolData);
    const parameters = asRecord(protocolData?.parameters);
    const items = [
        ...asArray(parameters?.offer),
        ...asArray(parameters?.consideration),
    ].map(asRecord);
    const nftItems = items.filter((item) => {
        const token = stringOrUndefined(item?.token)?.toLowerCase();
        if (token && token !== targetContractAddress) {
            return false;
        }
        return [2, 3, 4, 5].includes(Number(item?.itemType));
    });
    const explicitNftItems = nftItems.filter((item) => [2, 3].includes(Number(item?.itemType)));
    const criteriaNftItems = nftItems.filter((item) => [4, 5].includes(Number(item?.itemType)));
    const criteria = asRecord(record.criteria ?? protocolData?.criteria);
    const traitEntries = normalizeTraitEntries(criteria?.trait ?? criteria?.traits);
    const encodedTokenIds = stringOrUndefined(criteria?.encoded_token_ids ?? criteria?.encodedTokenIds);
    const asset = asRecord(record.asset);

    let classification = "unknown";
    if (explicitNftItems.length > 0 || asset?.identifier || asset?.token_id || asset?.tokenId) {
        classification = "token-scoped";
    } else if (traitEntries.length > 0 || (encodedTokenIds && encodedTokenIds !== "*")) {
        classification = "criteria-scoped";
    } else if (criteriaNftItems.length > 0 || !encodedTokenIds || encodedTokenIds === "*") {
        classification = "collection-scoped";
    }

    return {
        classification,
        orderHash: stringOrUndefined(record.order_hash ?? record.orderHash) ?? "unknown",
        price: readPrice(record),
        assetIdentifier:
            stringOrUndefined(asset?.identifier ?? asset?.token_id ?? asset?.tokenId) ?? null,
        criteria: {
            traitCount: traitEntries.length,
            traits: traitEntries.slice(0, 3),
            encodedTokenIds: encodedTokenIds ?? null,
        },
        nftItems: nftItems.map((item) => ({
            itemType: Number(item?.itemType),
            token: stringOrUndefined(item?.token) ?? null,
            identifierOrCriteria: stringOrUndefined(item?.identifierOrCriteria) ?? null,
        })),
    };
}

function readPrice(record) {
    const price = asRecord(record.price);
    const current = asRecord(price?.current);
    return {
        value: stringOrUndefined(current?.value ?? price?.value) ?? null,
        currency: stringOrUndefined(current?.currency ?? price?.currency) ?? null,
    };
}

function printSamples(label, entries) {
    console.log(`\n== ${label} samples ==`);
    if (entries.length === 0) {
        console.log("none");
        return;
    }
    entries.slice(0, 5).forEach((entry, index) => {
        console.log(
            `${index + 1}. order=${entry.orderHash} price=${entry.price.value ?? "n/a"} ${entry.price.currency ?? ""}`.trim(),
        );
        console.log(`   assetIdentifier=${entry.assetIdentifier ?? "n/a"}`);
        console.log(`   criteria=${JSON.stringify(entry.criteria)}`);
        console.log(`   nftItems=${JSON.stringify(entry.nftItems.slice(0, 4))}`);
    });
}

function normalizeTraitEntries(value) {
    if (!value) {
        return [];
    }
    const entries = Array.isArray(value) ? value : [value];
    return entries
        .map(asRecord)
        .filter(Boolean)
        .map((entry) => ({
            type: stringOrUndefined(entry.type ?? entry.trait_type) ?? "unknown",
            value: stringOrUndefined(entry.value) ?? "unknown",
        }));
}

function countBy(values) {
    return values.reduce((acc, value) => {
        acc[value] = (acc[value] ?? 0) + 1;
        return acc;
    }, {});
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}

function stringOrUndefined(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePositiveInteger(raw, fallback) {
    if (!raw || !/^\d+$/.test(String(raw))) {
        return fallback;
    }
    return Math.max(1, Number(raw));
}

function parseArgs(rawArgs) {
    const parsed = {};
    for (let index = 0; index < rawArgs.length; index += 1) {
        const arg = rawArgs[index];
        if (!arg.startsWith("--")) {
            continue;
        }
        const [key, inlineValue] = arg.slice(2).split("=", 2);
        parsed[key] = inlineValue ?? rawArgs[index + 1];
        if (inlineValue === undefined) {
            index += 1;
        }
    }
    return parsed;
}

function loadEnvFile(path) {
    if (!existsSync(path)) {
        return {};
    }

    const result = {};
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex === -1) {
            continue;
        }
        const key = trimmed.slice(0, equalsIndex).trim();
        let value = trimmed.slice(equalsIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}

function writeDumpFile(outputDir, payload) {
    const resolvedDir = resolve(process.cwd(), outputDir);
    mkdirSync(resolvedDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `opensea-offers-${collectionSlug}-${timestamp}.json`;
    const outputPath = resolve(resolvedDir, filename);
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    return outputPath;
}
