import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
    parseAddress,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };

const MARKET_OPTIONS = {
    "chain-id": { type: "string" },
    "weth-address": { type: "string" },
} as const;

function positiveId(value: string | undefined, name: string): number {
    const id = parsePositiveInteger(value, name);
    if (!Number.isSafeInteger(id)) throw new Error(`Invalid ${name}: ${value}`);
    return id;
}

function marketInputs(values: Record<string, string | boolean | undefined>) {
    return {
        chainId: positiveId(
            parseRequiredString(
                values["chain-id"] as string | undefined,
                "--chain-id",
            ),
            "--chain-id",
        ),
        wethAddress: parseAddress(
            values["weth-address"] as string | undefined,
            "--weth-address",
        ),
    };
}

/** These copy-only tools deliberately read no environment or database-derived configuration. */
export function parseStorageProfileArgs(args: string[]) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            ...MARKET_OPTIONS,
            "copied-db": { type: "boolean" },
            "plan-only": { type: "boolean" },
        },
    });
    if (positionals.length !== 2 || !values["copied-db"])
        throw new Error(
            "Usage: profile-collection-storage.ts <copied-db> <collection-id> --copied-db --chain-id <id> --weth-address <address> [--plan-only]",
        );
    return {
        ...marketInputs(values),
        databasePath: resolve(positionals[0]!),
        collectionId: positiveId(positionals[1], "collection-id"),
        planOnly: values["plan-only"] === true,
    };
}

export function parseStorageVerificationArgs(args: string[]) {
    const compactKey = runtime.arguments.compact.slice(2);
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            ...MARKET_OPTIONS,
            "mutate-copy": { type: "boolean" },
            "skip-read-baseline": { type: "boolean" },
            "runtime-root": { type: "string" },
            [compactKey]: { type: "boolean" },
        },
    });
    if (positionals.length !== 1 || !values["mutate-copy"])
        throw new Error(
            "Usage: verify-sqlite-market-data-recovery.ts <copied-db> --mutate-copy --chain-id <id> --weth-address <address> [--compact] [--skip-read-baseline] [--runtime-root <directory>]",
        );
    const runtimeRoot = values["runtime-root"] as string | undefined;
    if (
        runtimeRoot !== undefined &&
        (!runtimeRoot.trim() || runtimeRoot.startsWith("--"))
    )
        throw new Error("--runtime-root requires a staged runtime directory");
    if (runtimeRoot && !values["skip-read-baseline"])
        throw new Error(
            "Bundled QA requires --skip-read-baseline so its preflight remains read-only; profile baseline reads separately",
        );
    return {
        ...marketInputs(values),
        databasePath: resolve(positionals[0]!),
        compact: Reflect.get(values, compactKey) === true,
        skipReadBaseline: values["skip-read-baseline"] === true,
        runtimeRoot: runtimeRoot ? resolve(runtimeRoot) : null,
    };
}
