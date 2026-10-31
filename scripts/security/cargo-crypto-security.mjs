#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";
import { DESKTOP_RUST_TARGET } from "../build/native-runtime-dependencies.mjs";
import { compareSemver } from "./cargo-age-gate-utils.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

// RustSec's fixed floor; optional lockfile entries are not proof that a crate is compiled.
export const CRYPTO_BIGINT_SECURITY_FLOOR = "0.7.6";
const CRYPTO_BIGINT_CRATE = "crypto-bigint";
const AES_CRATE = "aes";
const ZEROIZE_FEATURE = "zeroize";
const DESKTOP_CRYPTO_CRATES = [
    "eth-keystore",
    "k256",
    CRYPTO_BIGINT_CRATE,
    AES_CRATE,
];
const FEATURE_MODES = ["default", "all"];
// The all-target union catches any enabled legacy crate, but can combine AES features
// from different platforms. Inspect each native target too so that union cannot hide a gap.
export const CARGO_CRYPTO_TARGETS = Object.freeze([
    "all",
    ...Object.values(DESKTOP_RUST_TARGET).filter(
        (target) => target !== DESKTOP_RUST_TARGET.DarwinUniversal,
    ),
]);

export function parseCargoCryptoTree(source) {
    const entries = source
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
            const match = /^([\w-]+) v(\S+)(?: \(.*\))?\|(.*)$/.exec(line);
            if (!match)
                throw new Error(`Unrecognized Cargo tree entry: ${line}`);
            return {
                name: match[1],
                version: match[2],
                features: new Set(
                    match[3]
                        .replace(/\s*\(\*\)$/, "")
                        .split(",")
                        .filter(Boolean),
                ),
            };
        });
    if (entries.length === 0)
        throw new Error("Cargo returned an empty dependency tree");
    return entries;
}

export function findCryptoViolations(
    entries,
    { requireWalletStack = false } = {},
) {
    const violations = [];
    if (requireWalletStack) {
        for (const name of DESKTOP_CRYPTO_CRATES) {
            if (!entries.some((entry) => entry.name === name)) {
                violations.push(`required wallet dependency ${name} is absent`);
            }
        }
    }
    for (const entry of entries) {
        if (
            entry.name === CRYPTO_BIGINT_CRATE &&
            compareSemver(entry.version, CRYPTO_BIGINT_SECURITY_FLOOR) < 0
        ) {
            violations.push(
                `${entry.name}@${entry.version} is below the RUSTSEC-2026-0387 fixed floor ${CRYPTO_BIGINT_SECURITY_FLOOR}`,
            );
        }
        if (entry.name === AES_CRATE && !entry.features.has(ZEROIZE_FEATURE)) {
            violations.push(
                `${entry.name}@${entry.version} is missing ${ZEROIZE_FEATURE}`,
            );
        }
    }
    return [...new Set(violations)];
}

async function runCargo(args, options) {
    const result = await execFileAsync("cargo", args, {
        cwd: options.cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
    });
    return result.stdout;
}

export async function checkCargoCryptoSecurity({
    projectRoot = rootDir,
    offline = false,
    cargo = runCargo,
} = {}) {
    const violations = [];
    let graphCount = 0;
    for (const project of Object.values(DESKTOP_CARGO_PROJECTS)) {
        for (const features of FEATURE_MODES) {
            for (const target of CARGO_CRYPTO_TARGETS) {
                // `cargo metadata` includes inactive optional resolution edges. `tree` selects enabled
                // features, and --target all includes every platform without cross-compiling anything.
                const args = [
                    "tree",
                    "--manifest-path",
                    project.manifestPath,
                    "--locked",
                    "--target",
                    target,
                    "--edges",
                    "normal,build,dev",
                    "--prefix",
                    "none",
                    "--format",
                    "{p}|{f}",
                ];
                if (offline) args.push("--offline");
                if (features === "all") args.push("--all-features");
                const entries = parseCargoCryptoTree(
                    await cargo(args, { cwd: projectRoot }),
                );
                for (const message of findCryptoViolations(entries, {
                    requireWalletStack:
                        project === DESKTOP_CARGO_PROJECTS.Desktop,
                })) {
                    violations.push(
                        `${project.manifestPath} (${target}, ${features} features): ${message}`,
                    );
                }
                graphCount += 1;
            }
        }
    }
    return { graphCount, violations };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        const args = process.argv.slice(2);
        if (args.some((arg) => arg !== "--offline")) {
            throw new Error(
                "Usage: node scripts/security/cargo-crypto-security.mjs [--offline]",
            );
        }
        const result = await checkCargoCryptoSecurity({
            offline: args.includes("--offline"),
        });
        if (result.violations.length)
            throw new Error(result.violations.join("\n"));
        console.log(
            `Cargo crypto security passed: ${result.graphCount} enabled graphs across all targets.`,
        );
    } catch (error) {
        console.error(`Cargo crypto security failed: ${error.message}`);
        process.exitCode = 1;
    }
}
