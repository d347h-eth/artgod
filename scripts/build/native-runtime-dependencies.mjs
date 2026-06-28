// Native runtime packages must stay external so their package-local loaders can find bundled native files.
export const NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES = Object.freeze({
    BetterSqlite3: "better-sqlite3",
    Sharp: "sharp",
});

// better-sqlite3 writes this native binding after its trusted package-local install step.
export const BETTER_SQLITE3_NATIVE_BINDING_RELATIVE_PATH =
    "build/Release/better_sqlite3.node";

// esbuild leaves these packages as runtime imports for Yarn PnP to resolve from package context.
export const NATIVE_RUNTIME_EXTERNAL_PACKAGES = Object.freeze(
    Object.values(NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES),
);
