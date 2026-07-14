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

// Mach-O load commands that declare the minimum supported macOS version.
const MACH_O_BUILD_VERSION_LOAD_COMMAND = "LC_BUILD_VERSION";
const MACH_O_LEGACY_MACOS_VERSION_LOAD_COMMAND = "LC_VERSION_MIN_MACOSX";
const MACH_O_LEGACY_VERSION_LOAD_COMMAND_PREFIX = "LC_VERSION_MIN_";
// Apple identifies macOS as platform 1; newer tools may print its symbolic name.
const MACH_O_MACOS_PLATFORM_VALUES = new Set(["1", "MACOS"]);

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

// Rejects any shipped architecture slice built for a newer macOS than the app supports.
export async function verifyMacOSDeploymentTargets(
    machOFiles,
    minimumSystemVersion,
    { commandRunner },
) {
    if (machOFiles.length === 0) {
        throw new Error(
            "No Mach-O files were provided for deployment-target verification.",
        );
    }
    if (typeof commandRunner !== "function") {
        throw new Error(
            "macOS deployment-target verification requires a command runner.",
        );
    }

    const supportedVersion = parseMacOSVersion(
        minimumSystemVersion,
        "Configured minimum macOS version",
    );
    let architectureSliceCount = 0;

    for (const filePath of machOFiles) {
        const { stdout: architectureOutput } = await commandRunner(
            "lipo",
            ["-archs", filePath],
            { capture: true },
        );
        const architectures = architectureOutput
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (architectures.length === 0) {
            throw new Error(
                `Mach-O file reports no architecture slices: ${filePath}`,
            );
        }

        for (const architecture of architectures) {
            const { stdout: loadCommands } = await commandRunner(
                "otool",
                ["-arch", architecture, "-l", filePath],
                { capture: true },
            );
            const deploymentCommands =
                extractMachODeploymentCommands(loadCommands);
            const [deploymentCommand] = deploymentCommands;
            if (
                deploymentCommands.length !== 1 ||
                !deploymentCommand?.isMacOS ||
                !deploymentCommand.minimumVersion
            ) {
                throw new Error(
                    `Mach-O slice has no unambiguous macOS deployment target: ${filePath} (${architecture}). Found: ${formatDeploymentCommands(deploymentCommands)}.`,
                );
            }

            const deploymentTarget = deploymentCommand.minimumVersion;
            const targetVersion = parseMacOSVersion(
                deploymentTarget,
                `Mach-O deployment target for ${filePath} (${architecture})`,
            );
            if (compareMacOSVersions(targetVersion, supportedVersion) > 0) {
                throw new Error(
                    `Mach-O slice requires macOS ${deploymentTarget}, newer than configured minimum ${minimumSystemVersion}: ${filePath} (${architecture}).`,
                );
            }
            architectureSliceCount += 1;
        }
    }

    return Object.freeze({
        machOFileCount: machOFiles.length,
        architectureSliceCount,
        minimumSystemVersion,
    });
}

function extractMachODeploymentCommands(loadCommands) {
    const deploymentCommands = [];
    const commandBlocks = loadCommands.split(
        /(?=^[ \t]*Load command \d+[ \t]*$)/m,
    );

    for (const block of commandBlocks) {
        const command = block.match(/^[ \t]*cmd[ \t]+(\S+)[ \t]*$/m)?.[1];
        if (command === MACH_O_BUILD_VERSION_LOAD_COMMAND) {
            const platform = block.match(
                /^[ \t]*platform[ \t]+(\S+)[ \t]*$/m,
            )?.[1];
            const minimumVersion = block.match(
                /^[ \t]*minos[ \t]+(\d+(?:\.\d+){1,2})[ \t]*$/m,
            )?.[1];
            deploymentCommands.push({
                command,
                platform,
                minimumVersion,
                isMacOS:
                    typeof platform === "string" &&
                    MACH_O_MACOS_PLATFORM_VALUES.has(platform.toUpperCase()),
            });
            continue;
        }

        if (command?.startsWith(MACH_O_LEGACY_VERSION_LOAD_COMMAND_PREFIX)) {
            const minimumVersion = block.match(
                /^[ \t]*version[ \t]+(\d+(?:\.\d+){1,2})[ \t]*$/m,
            )?.[1];
            deploymentCommands.push({
                command,
                platform: command.slice(
                    MACH_O_LEGACY_VERSION_LOAD_COMMAND_PREFIX.length,
                ),
                minimumVersion,
                isMacOS: command === MACH_O_LEGACY_MACOS_VERSION_LOAD_COMMAND,
            });
        }
    }

    return deploymentCommands;
}

function formatDeploymentCommands(deploymentCommands) {
    if (deploymentCommands.length === 0) return "none";
    return deploymentCommands
        .map(
            ({ command, platform, minimumVersion }) =>
                `${command}(platform=${platform ?? "missing"}, minimum=${minimumVersion ?? "missing"})`,
        )
        .join(", ");
}

function parseMacOSVersion(value, label) {
    if (typeof value !== "string" || !/^\d+(?:\.\d+){1,2}$/.test(value)) {
        throw new Error(`${label} is invalid: ${value ?? "missing"}.`);
    }
    const components = value.split(".").map(Number);
    while (components.length < 3) components.push(0);
    return components;
}

function compareMacOSVersions(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}
