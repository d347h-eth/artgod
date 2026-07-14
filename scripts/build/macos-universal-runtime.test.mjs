import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MACOS_MACH_O_ARCHITECTURE } from "./native-runtime-dependencies.mjs";
import {
    resolveMacOSMachOArchitectureRequirement,
    verifyMacOSDeploymentTargets,
    verifyMacOSUniversalMachOFiles,
} from "./macos-universal-runtime.mjs";

const tauriConfig = JSON.parse(
    await readFile(
        new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
    ),
);
const minimumSystemVersion = tauriConfig.bundle.macOS.minimumSystemVersion;
const minimumSystemVersionMajor = Number(minimumSystemVersion.split(".")[0]);
const olderSystemVersion = `${minimumSystemVersionMajor - 1}.0`;
const newerSystemVersion = `${minimumSystemVersionMajor + 1}.0`;

const universalFiles = [
    "/Volumes/ArtGod/ArtGod.app/Contents/MacOS/artgod-desktop",
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/node/node",
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/nats/nats-server",
    "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
];
const sharpFilesByArchitecture = new Map([
    [
        "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/backend/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
        MACOS_MACH_O_ARCHITECTURE.Arm64,
    ],
    [
        "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/backend/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib",
        MACOS_MACH_O_ARCHITECTURE.Arm64,
    ],
    [
        "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/backend/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node",
        MACOS_MACH_O_ARCHITECTURE.X64,
    ],
    [
        "/Volumes/ArtGod/ArtGod.app/Contents/Resources/resources/runtime/backend/node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.dylib",
        MACOS_MACH_O_ARCHITECTURE.X64,
    ],
]);

test("classifies universal and architecture-paired Mach-O files", () => {
    assert.deepEqual(
        resolveMacOSMachOArchitectureRequirement(universalFiles[0])
            .architectures,
        [MACOS_MACH_O_ARCHITECTURE.Arm64, MACOS_MACH_O_ARCHITECTURE.X64],
    );
    for (const [filePath, architecture] of sharpFilesByArchitecture) {
        assert.deepEqual(
            resolveMacOSMachOArchitectureRequirement(filePath).architectures,
            [architecture],
        );
    }
});

test("accepts fat runtime code plus both Sharp architecture pairs", async () => {
    const files = [...universalFiles, ...sharpFilesByArchitecture.keys()];
    const result = await verifyMacOSUniversalMachOFiles(files, {
        async commandRunner(command, args, options) {
            assert.equal(command, "lipo");
            assert.equal(args[0], "-archs");
            assert.deepEqual(options, { capture: true });
            const filePath = args[1];
            return {
                stdout: sharpFilesByArchitecture.has(filePath)
                    ? `${sharpFilesByArchitecture.get(filePath)}\n`
                    : "arm64 x86_64\n",
                stderr: "",
            };
        },
    });

    assert.deepEqual(result, {
        machOFileCount: files.length,
        universalFileCount: universalFiles.length,
        sharpNativePackageCount: sharpFilesByArchitecture.size,
    });
});

test("rejects a required fat binary with only one architecture", async () => {
    await assert.rejects(
        verifyMacOSUniversalMachOFiles(
            [...universalFiles, ...sharpFilesByArchitecture.keys()],
            {
                async commandRunner(_command, args) {
                    const filePath = args[1];
                    return {
                        stdout:
                            filePath === universalFiles[0]
                                ? "arm64\n"
                                : (sharpFilesByArchitecture.get(filePath) ??
                                  "arm64 x86_64\n"),
                        stderr: "",
                    };
                },
            },
        ),
        /Missing: x86_64/,
    );
});

test("rejects a missing Sharp architecture package", async () => {
    const files = [
        ...universalFiles,
        ...[...sharpFilesByArchitecture.keys()].slice(0, -1),
    ];
    await assert.rejects(
        verifyMacOSUniversalMachOFiles(files, {
            async commandRunner(_command, args) {
                const filePath = args[1];
                return {
                    stdout:
                        sharpFilesByArchitecture.get(filePath) ??
                        "arm64 x86_64\n",
                    stderr: "",
                };
            },
        }),
        /missing native Sharp packages: @img\/sharp-libvips-darwin-x64/,
    );
});

test("accepts modern and legacy deployment targets at or below the supported minimum", async () => {
    const files = [universalFiles[0], [...sharpFilesByArchitecture.keys()][0]];
    const result = await verifyMacOSDeploymentTargets(
        files,
        minimumSystemVersion,
        {
            async commandRunner(command, args, options) {
                assert.deepEqual(options, { capture: true });
                if (command === "lipo") {
                    assert.equal(args[0], "-archs");
                    return {
                        stdout: sharpFilesByArchitecture.has(args[1])
                            ? `${MACOS_MACH_O_ARCHITECTURE.Arm64}\n`
                            : `${MACOS_MACH_O_ARCHITECTURE.Arm64} ${MACOS_MACH_O_ARCHITECTURE.X64}\n`,
                        stderr: "",
                    };
                }

                assert.equal(command, "otool");
                assert.equal(args[0], "-arch");
                assert.equal(args[2], "-l");
                assert.equal(files.includes(args[3]), true);
                return {
                    stdout:
                        args[1] === MACOS_MACH_O_ARCHITECTURE.X64
                            ? createLegacyDeploymentTargetOutput(
                                  olderSystemVersion,
                              )
                            : createBuildVersionOutput(
                                  minimumSystemVersion,
                                  sharpFilesByArchitecture.has(args[3])
                                      ? "1"
                                      : "macos",
                              ),
                    stderr: "",
                };
            },
        },
    );

    assert.deepEqual(result, {
        machOFileCount: files.length,
        architectureSliceCount: 3,
        minimumSystemVersion,
    });
});

test("rejects a Mach-O slice built for a newer macOS", async () => {
    await assert.rejects(
        verifyMacOSDeploymentTargets(
            [universalFiles[0]],
            minimumSystemVersion,
            {
                async commandRunner(command) {
                    return {
                        stdout:
                            command === "lipo"
                                ? `${MACOS_MACH_O_ARCHITECTURE.Arm64}\n`
                                : createBuildVersionOutput(newerSystemVersion),
                        stderr: "",
                    };
                },
            },
        ),
        new RegExp(
            `requires macOS ${newerSystemVersion}.*configured minimum ${minimumSystemVersion}`,
        ),
    );
});

test("rejects a Mach-O slice without one unambiguous macOS target", async () => {
    for (const loadCommands of [
        "Load command 1\n      cmd LC_SYMTAB\n",
        [
            createBuildVersionOutput(minimumSystemVersion),
            createLegacyDeploymentTargetOutput(olderSystemVersion),
        ].join("\n"),
        [
            createBuildVersionOutput(minimumSystemVersion),
            createBuildVersionOutput(minimumSystemVersion),
        ].join("\n"),
        [
            createBuildVersionOutput(minimumSystemVersion, "IOS"),
            createBuildVersionOutput(minimumSystemVersion),
        ].join("\n"),
    ]) {
        await assert.rejects(
            verifyMacOSDeploymentTargets(
                [universalFiles[0]],
                minimumSystemVersion,
                {
                    async commandRunner(command) {
                        return {
                            stdout:
                                command === "lipo"
                                    ? `${MACOS_MACH_O_ARCHITECTURE.X64}\n`
                                    : loadCommands,
                            stderr: "",
                        };
                    },
                },
            ),
            /no unambiguous macOS deployment target/,
        );
    }
});

function createBuildVersionOutput(minimumVersion, platform = "macos") {
    return [
        "Load command 10",
        "      cmd LC_BUILD_VERSION",
        "  cmdsize 32",
        ` platform ${platform}`,
        `    minos ${minimumVersion}`,
        `      sdk ${minimumVersion}`,
        "   ntools 1",
        "",
    ].join("\n");
}

function createLegacyDeploymentTargetOutput(minimumVersion) {
    return [
        "Load command 9",
        "      cmd LC_VERSION_MIN_MACOSX",
        "  cmdsize 16",
        `  version ${minimumVersion}`,
        `      sdk ${minimumVersion}`,
        "",
    ].join("\n");
}
