import path from "node:path";
import {
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
    SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET,
} from "./native-runtime-dependencies.mjs";

const universalMachOArchitectures = Object.freeze(
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
        ({ machOArchitecture }) => machOArchitecture,
    ),
);

const sharpNativePackageRequirements = Object.freeze(
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.flatMap((architecture) =>
        SHARP_RUNTIME_PACKAGES_BY_NODE_TARGET[architecture.nodeTarget].map(
            (packageName) =>
                Object.freeze({
                    packageName,
                    architectures: Object.freeze([
                        architecture.machOArchitecture,
                    ]),
                }),
        ),
    ),
);

// Classifies paired Sharp packages while requiring every other shipped Mach-O to be fat.
export function resolveMacOSMachOArchitectureRequirement(filePath) {
    const normalizedPath = `/${filePath.split(path.sep).join("/")}`;
    const sharpRequirement = sharpNativePackageRequirements.find(
        ({ packageName }) =>
            normalizedPath.includes(`/node_modules/${packageName}/`),
    );
    if (sharpRequirement) {
        return sharpRequirement;
    }
    return Object.freeze({
        packageName: undefined,
        architectures: universalMachOArchitectures,
    });
}

// Verifies the final app contains both universal code and both paired Sharp closures.
export async function verifyMacOSUniversalMachOFiles(
    machOFiles,
    { commandRunner },
) {
    if (machOFiles.length === 0) {
        throw new Error(
            "No Mach-O files were provided for universal verification.",
        );
    }
    if (typeof commandRunner !== "function") {
        throw new Error(
            "macOS universal verification requires a command runner.",
        );
    }

    const seenSharpPackages = new Set();
    let universalFileCount = 0;
    for (const filePath of machOFiles) {
        const requirement = resolveMacOSMachOArchitectureRequirement(filePath);
        const { stdout } = await commandRunner("lipo", ["-archs", filePath], {
            capture: true,
        });
        const actualArchitectures = new Set(
            stdout.trim().split(/\s+/).filter(Boolean),
        );
        const missingArchitectures = requirement.architectures.filter(
            (architecture) => !actualArchitectures.has(architecture),
        );
        if (missingArchitectures.length > 0) {
            throw new Error(
                `Mach-O architecture coverage is incomplete for ${filePath}. Missing: ${missingArchitectures.join(", ")}. Found: ${[...actualArchitectures].join(", ") || "none"}.`,
            );
        }

        if (requirement.packageName) {
            seenSharpPackages.add(requirement.packageName);
        } else {
            universalFileCount += 1;
        }
    }

    const missingSharpPackages = sharpNativePackageRequirements
        .map(({ packageName }) => packageName)
        .filter((packageName) => !seenSharpPackages.has(packageName));
    if (missingSharpPackages.length > 0) {
        throw new Error(
            `Universal macOS runtime is missing native Sharp packages: ${missingSharpPackages.join(", ")}.`,
        );
    }
    if (universalFileCount === 0) {
        throw new Error(
            "Universal macOS runtime contains no fat Mach-O files.",
        );
    }

    return Object.freeze({
        machOFileCount: machOFiles.length,
        universalFileCount,
        sharpNativePackageCount: seenSharpPackages.size,
    });
}
