import type sharp from "sharp";

// Native image processor factory used by backend media adapters.
export type SharpFactory = typeof sharp;

// Lazy loader contract keeps tests and startup from eagerly importing sharp.
export type SharpFactoryLoader = () => Promise<SharpFactory>;

let sharpFactoryPromise: Promise<SharpFactory> | null = null;

// Loads sharp lazily so bootstrap startup does not require native image work.
export async function loadSharp(): Promise<SharpFactory> {
    if (!sharpFactoryPromise) {
        sharpFactoryPromise = import("sharp").then((module) => {
            const loaded = module as unknown as { default?: SharpFactory };
            return loaded.default ?? (module as unknown as SharpFactory);
        });
    }
    return sharpFactoryPromise;
}
