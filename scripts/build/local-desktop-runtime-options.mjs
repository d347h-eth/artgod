import { NATIVE_RUNTIME_EXTERNAL_PACKAGES } from "./native-runtime-dependencies.mjs";

// Shared only by the local builder and its exporter smoke harness.
export function localRuntimeBuildOptions(rootDir) {
    return {
        absWorkingDir: rootDir,
        outExtension: { ".js": ".mjs" },
        bundle: true,
        format: "esm",
        // Preserve lazy chunks for the full local and deploy runtime graph.
        splitting: true,
        platform: "node",
        target: "node24",
        chunkNames: "chunks/[name]-[hash]",
        sourcemap: false,
        minify: false,
        metafile: true,
        external: NATIVE_RUNTIME_EXTERNAL_PACKAGES,
        banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; import { dirname as __dirnameOf } from "node:path"; import { fileURLToPath as __fileURLToPath } from "node:url"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);',
        },
        legalComments: "none",
        logLevel: "info",
        // Keep runtime builds isolated from the repository-level project references
        // (especially frontend/.svelte-kit) so clean builds stay warning-free.
        tsconfigRaw: {
            compilerOptions: {
                target: "ES2022",
                module: "ESNext",
                moduleResolution: "bundler",
                resolveJsonModule: true,
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                isolatedModules: true,
            },
        },
    };
}
