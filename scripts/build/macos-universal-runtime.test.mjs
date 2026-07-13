import assert from "node:assert/strict";
import test from "node:test";
import { MACOS_MACH_O_ARCHITECTURE } from "./native-runtime-dependencies.mjs";
import {
    resolveMacOSMachOArchitectureRequirement,
    verifyMacOSUniversalMachOFiles,
} from "./macos-universal-runtime.mjs";

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
