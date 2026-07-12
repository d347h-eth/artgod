import { existsSync, readFileSync, writeFileSync } from "node:fs";

const fixtureContract = JSON.parse(
    readFileSync(
        new URL(
            "./secret-prompt-process-fixture-contract.json",
            import.meta.url,
        ),
        "utf8",
    ),
);
const fixturePollMilliseconds = 5;
const oversizedFixtureBytes = 8 * 1024;
const fixtureConfigurationErrorExitCode = 64;
const fixtureProtocolViolationExitCode = 65;

const [mode, pidPath, readyPath, gatePath] = process.argv.slice(2);
if (!mode || !pidPath || !readyPath) {
    process.exit(fixtureConfigurationErrorExitCode);
}

writeFileSync(pidPath, String(process.pid));

if (mode === fixtureContract.modes.blockedWriter) {
    writeFileSync(readyPath, "ready");
    setInterval(() => {}, 1_000);
} else {
    const request = await readOneRequest();
    process.stdin.pause();
    writeFileSync(readyPath, "ready");

    if (mode === fixtureContract.modes.hold) {
        await waitForOwnerLossOrExtraInput();
    } else if (mode === fixtureContract.modes.validResponse) {
        await writeResponse(validResponseFor(request));
    } else if (mode === fixtureContract.modes.gatedResponse) {
        if (!gatePath) {
            process.exit(fixtureConfigurationErrorExitCode);
        }
        await waitForPath(gatePath);
        await writeResponse(validResponseFor(request));
    } else if (mode === fixtureContract.modes.malformedResponse) {
        await writeStream(process.stdout, "not-json\n");
    } else if (mode === fixtureContract.modes.oversizedStdout) {
        await writeStream(
            process.stdout,
            `${"x".repeat(oversizedFixtureBytes)}\n`,
        );
    } else if (mode === fixtureContract.modes.oversizedStderr) {
        await writeStream(process.stderr, "x".repeat(oversizedFixtureBytes));
        await waitForOwnerLossOrExtraInput();
    } else {
        process.exit(fixtureConfigurationErrorExitCode);
    }
}

function readOneRequest() {
    return new Promise((resolve, reject) => {
        let raw = Buffer.alloc(0);
        const onData = (chunk) => {
            raw = Buffer.concat([raw, chunk]);
            const newline = raw.indexOf(0x0a);
            if (newline < 0) {
                return;
            }
            process.stdin.off("data", onData);
            const request = raw.subarray(0, newline).toString("utf8");
            raw.fill(0);
            try {
                resolve(JSON.parse(request));
            } catch (error) {
                reject(error);
            }
        };
        process.stdin.on("data", onData);
        process.stdin.once("error", reject);
        process.stdin.once("end", () =>
            reject(new Error("owner closed before request")),
        );
        process.stdin.resume();
    });
}

function waitForOwnerLossOrExtraInput() {
    return new Promise((resolve) => {
        process.stdin.once("data", () =>
            process.exit(fixtureProtocolViolationExitCode),
        );
        process.stdin.once("error", resolve);
        process.stdin.once("end", resolve);
        process.stdin.resume();
    });
}

function waitForPath(path) {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (existsSync(path)) {
                clearInterval(timer);
                resolve();
            }
        }, fixturePollMilliseconds);
    });
}

function validResponseFor(request) {
    switch (request.type) {
        case "import":
            return {
                type: "import_submitted",
                label: "Fixture wallet",
                privateKey: "0xfixture-private-key",
                passphrase: "fixture-passphrase",
                passphraseConfirmation: "fixture-passphrase",
            };
        case "unlock":
            return {
                type: "unlock_submitted",
                passphrase: "fixture-passphrase",
            };
        case "remove_confirm":
            return {
                type: "remove_confirm_submitted",
                passphrase: "fixture-passphrase",
                typedConfirmation: "REMOVE",
            };
        case "export_confirm":
            return {
                type: "export_confirm_submitted",
                passphrase: "fixture-passphrase",
                typedConfirmation: "EXPORT",
            };
        case "export_reveal":
            return { type: "export_reveal_acknowledged", acknowledged: true };
        default:
            process.exit(fixtureConfigurationErrorExitCode);
    }
}

async function writeResponse(response) {
    await writeStream(process.stdout, `${JSON.stringify(response)}\n`);
}

function writeStream(stream, value) {
    return new Promise((resolve, reject) => {
        stream.write(value, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}
