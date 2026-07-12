import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const workflowsDirectory = path.join(rootDir, ".github", "workflows");
const fullCommitActionReferencePattern = /^[^\s@]+@[a-f0-9]{40}$/;
const webviewShellAclTestCommand =
    "cargo test --manifest-path src-tauri/Cargo.toml --test webview_capability_security";
const botHardParentDeathTestCommand = "yarn test:desktop:parent-containment";
const botHardParentDeathBuildStepName =
    "Test bot hard-parent-death containment";
const botHardParentDeathReleaseStepName =
    "Test release bot hard-parent-death containment";
const windowsContainmentTarget = "x86_64-pc-windows-msvc";
const windowsSidecarPrepareCommand =
    "node ./scripts/build/prepare-desktop-sidecars.mjs --profile debug";
const windowsContainmentCheckCommand =
    "cargo check --manifest-path src-tauri/Cargo.toml --lib";

test("pins every external GitHub Action to a full commit SHA", async () => {
    for (const workflow of await readWorkflows()) {
        const actionReferences = [
            ...workflow.source.matchAll(/^\s*uses:\s+([^\s#]+)/gm),
        ].map((match) => match[1]);
        assert.ok(
            actionReferences.length > 0,
            `${workflow.name} has no Action references to validate.`,
        );
        for (const actionReference of actionReferences) {
            if (actionReference.startsWith("./")) {
                continue;
            }
            assert.match(
                actionReference,
                fullCommitActionReferencePattern,
                `${workflow.name} uses mutable Action reference ${actionReference}.`,
            );
        }
    }
});

test("keeps checkout credentials out of subsequent workflow steps", async () => {
    for (const workflow of await readWorkflows()) {
        const stepPattern =
            /^\s{12}- name: .+(?:\n(?!\s{12}- name: )[\s\S])*?(?=^\s{12}- name: |\s*$)/gm;
        const checkoutSteps = [...workflow.source.matchAll(stepPattern)]
            .map((match) => match[0])
            .filter((step) => step.includes("uses: actions/checkout@"));

        for (const checkoutStep of checkoutSteps) {
            assert.match(
                checkoutStep,
                /persist-credentials:\s*false/,
                `${workflow.name} persists checkout credentials.`,
            );
        }
    }
});

test("separates signing, attestation, and publication trust boundaries", async () => {
    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );

    assert.match(releaseWorkflow, /^permissions:\n\s{4}contents: read$/m);
    assert.match(releaseWorkflow, /^\s{4}assemble-release:$/m);
    assert.match(releaseWorkflow, /^\s{4}publish-release:$/m);
    assert.match(
        releaseWorkflow,
        /^\s{12}attestations: write\n\s{12}contents: write\n\s{12}id-token: write$/m,
    );

    const cleanupIndex = releaseWorkflow.indexOf(
        "Remove temporary macOS signing credentials",
    );
    const firstArtifactActionIndex = releaseWorkflow.indexOf(
        "Preserve macOS notarization input",
    );
    const attestationIndex = releaseWorkflow.indexOf(
        "Attest release artifacts",
    );
    const releaseKeyIndex = releaseWorkflow.indexOf(
        "Include release verification key",
    );
    const checksumIndex = releaseWorkflow.indexOf("Generate checksums");
    const releaseStagingIndex = releaseWorkflow.indexOf(
        "Stage GitHub release assets",
    );
    const publicationIndex = releaseWorkflow.indexOf(
        "Publish staged GitHub release",
    );
    assert.ok(cleanupIndex >= 0 && cleanupIndex < firstArtifactActionIndex);
    assert.ok(releaseKeyIndex >= 0 && releaseKeyIndex < checksumIndex);
    assert.ok(
        attestationIndex >= 0 &&
            attestationIndex < releaseStagingIndex &&
            releaseStagingIndex < publicationIndex,
    );
    const publishJob = extractWorkflowJob(releaseWorkflow, "publish-release");
    const releaseActionReferences = publishJob.match(
        /uses: softprops\/action-gh-release@/g,
    );
    assert.equal(releaseActionReferences?.length, 1);
    assert.match(
        publishJob,
        /Stage GitHub release assets\n\s+id: staged-release[\s\S]*draft:\s*true/,
    );
    assert.match(
        publishJob,
        /Publish staged GitHub release\n\s+run: node \.\/scripts\/build\/github-release-publication\.mjs publish/,
    );
    assert.match(
        publishJob,
        /STAGED_GITHUB_RELEASE_ID:\s*\$\{\{ steps\.staged-release\.outputs\.id \}\}/,
    );
    assert.match(publishJob, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
    assert.match(
        releaseWorkflow,
        /DESKTOP_RELEASE_PUBLIC_KEY_FILE_NAME:\s*artgod-release-public\.asc/,
    );
    assert.doesNotMatch(releaseWorkflow, /APPLE_API_KEY_PATH=/);
    assert.doesNotMatch(releaseWorkflow, /MACOS_NOTARIZATION_KEY_FILE_NAME/);
});

test("admits signed mainline tags before initial or resumed release work", async () => {
    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const admissionCommand =
        "node ./scripts/build/desktop-release-admission.mjs validate";

    for (const jobName of [
        "dependency-security",
        "resume-macos-notarization",
    ]) {
        const job = extractWorkflowJob(releaseWorkflow, jobName);
        assert.match(job, /fetch-depth:\s*0/);
        assert.match(job, new RegExp(admissionCommand.replaceAll(".", "\\.")));
        assert.match(job, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
    }

    const assembleJob = extractWorkflowJob(releaseWorkflow, "assemble-release");
    assert.match(assembleJob, /desktop-release-admission\.mjs metadata/);
    assert.doesNotMatch(releaseWorkflow, /contains\(github\.ref_name/);
    assert.doesNotMatch(
        releaseWorkflow,
        /macos-notarization\.mjs validate-ref/,
    );
});

test("publishes only after successful release assembly", async () => {
    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const assembleJob = extractWorkflowJob(releaseWorkflow, "assemble-release");
    const publishJob = extractWorkflowJob(releaseWorkflow, "publish-release");

    assert.match(assembleJob, /!cancelled\(\)/);
    assert.doesNotMatch(assembleJob, /always\(\)/);
    assert.match(publishJob, /!cancelled\(\)/);
    assert.match(publishJob, /needs\.assemble-release\.result == 'success'/);
});

test("starts the final bundled Node runtime before macOS notarization", async () => {
    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const buildJob = extractWorkflowJob(releaseWorkflow, "build");
    const nodeVerificationIndex = buildJob.indexOf(
        "Verify macOS signing and bundled Node startup",
    );
    const notarizationInputIndex = buildJob.indexOf(
        "Prepare macOS notarization input",
    );

    assert.ok(nodeVerificationIndex >= 0);
    assert.ok(nodeVerificationIndex < notarizationInputIndex);
    assert.match(
        buildJob,
        /macos-code-signing\.mjs verify-dmg "src-tauri\/target\/\$\{\{ matrix\.target \}\}\/release\/bundle\/dmg"/,
    );
});

test("checks synchronized project versions on ordinary desktop builds", async () => {
    const buildCheckWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    assert.match(
        buildCheckWorkflow,
        /run:\s*node \.\/scripts\/build\/sync-version\.mjs --check/,
    );
    assert.doesNotMatch(buildCheckWorkflow, /run:\s*yarn check:version/);
});

test("runs the resolved WebView shell ACL test in build and release lanes", async () => {
    for (const workflowName of ["tauri-build-check.yml", "tauri-release.yml"]) {
        const workflow = await readFile(
            path.join(workflowsDirectory, workflowName),
            "utf8",
        );
        assert.ok(
            workflow.includes(webviewShellAclTestCommand),
            `${workflowName} does not run the resolved WebView shell ACL test.`,
        );
    }
});

test("runs bot hard-parent-death containment in the ordinary Tauri build job", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const tauriCheckJob = extractWorkflowJob(workflow, "tauri-check");
    const containmentStep = extractWorkflowStep(
        tauriCheckJob,
        botHardParentDeathBuildStepName,
    );

    assert.equal(countOccurrences(workflow, botHardParentDeathTestCommand), 1);
    assert.doesNotMatch(tauriCheckJob, /^ {8}continue-on-error:/m);
    assertStepRunsCommand(containmentStep, botHardParentDeathTestCommand);
    assertStepIsRequired(containmentStep);
    assertStepPrecedes(
        tauriCheckJob,
        "Tauri no-bundle build check",
        botHardParentDeathBuildStepName,
    );
});

test("runs release containment on both build platforms before artifacts leave the job", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const buildJob = extractWorkflowJob(workflow, "build");
    const containmentStep = extractWorkflowStep(
        buildJob,
        botHardParentDeathReleaseStepName,
    );

    assert.equal(countOccurrences(workflow, botHardParentDeathTestCommand), 1);
    assert.match(buildJob, /^ {20}- os: ubuntu-22\.04$/m);
    assert.match(buildJob, /^ {20}- os: macos-latest$/m);
    assert.doesNotMatch(buildJob, /^ {8}continue-on-error:/m);
    assertStepRunsCommand(containmentStep, botHardParentDeathTestCommand);
    assertStepIsRequired(containmentStep);

    for (const buildStepName of [
        "Build Linux Tauri bundle",
        "Build macOS Tauri bundle",
    ]) {
        assertStepPrecedes(
            buildJob,
            buildStepName,
            botHardParentDeathReleaseStepName,
        );
    }
    for (const protectedStepName of [
        "Collect release artifacts",
        "Prepare macOS notarization input",
        "Preserve macOS notarization input",
        "Submit macOS DMG for notarization",
        "Preserve macOS notarization submission state",
        "Poll, verify, and staple macOS DMG",
        "Preserve macOS notarization diagnostics",
        "Upload Linux build artifacts",
        "Upload macOS build artifacts",
    ]) {
        assertStepPrecedes(
            buildJob,
            botHardParentDeathReleaseStepName,
            protectedStepName,
        );
    }
});

test("compiles the Windows Job Object containment path", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const windowsJob = extractWorkflowJob(
        workflow,
        "windows-containment-check",
    );
    const sidecarStep = extractWorkflowStep(
        windowsJob,
        "Prepare Windows secret prompt sidecar",
    );
    const checkStep = extractWorkflowStep(
        windowsJob,
        "Check Windows Job Object containment",
    );

    assert.match(windowsJob, /^ {8}runs-on: windows-latest$/m);
    assert.doesNotMatch(windowsJob, /^ {8}if:/m);
    assert.match(
        windowsJob,
        new RegExp(
            `^ {12}CARGO_BUILD_TARGET: ${escapeRegExp(windowsContainmentTarget)}$`,
            "m",
        ),
    );
    assert.match(
        windowsJob,
        /^ {18}targets: \$\{\{ env\.CARGO_BUILD_TARGET \}\}$/m,
    );
    assertStepRunsCommand(sidecarStep, windowsSidecarPrepareCommand);
    assertStepIsRequired(sidecarStep);
    assertStepRunsCommand(checkStep, windowsContainmentCheckCommand);
    assertStepIsRequired(checkStep);
    assertStepPrecedes(
        windowsJob,
        "Prepare Windows secret prompt sidecar",
        "Check Windows Job Object containment",
    );
    assert.doesNotMatch(windowsJob, /^ {8}continue-on-error:/m);
});

async function readWorkflows() {
    const workflowNames = (await readdir(workflowsDirectory))
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort();
    return await Promise.all(
        workflowNames.map(async (name) => ({
            name,
            source: await readFile(path.join(workflowsDirectory, name), "utf8"),
        })),
    );
}

function extractWorkflowJob(source, jobName) {
    const marker = `    ${jobName}:\n`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `Workflow job ${jobName} was not found.`);
    const remaining = source.slice(start + marker.length);
    const nextJob = remaining.match(/^    [a-z0-9_-]+:\n/m);
    return source.slice(
        start,
        nextJob ? start + marker.length + nextJob.index : source.length,
    );
}

function extractWorkflowStep(jobSource, stepName) {
    const marker = `            - name: ${stepName}\n`;
    const start = jobSource.indexOf(marker);
    assert.notEqual(start, -1, `Workflow step ${stepName} was not found.`);
    const remaining = jobSource.slice(start + marker.length);
    const nextStep = remaining.match(/^ {12}- name: /m);
    return jobSource.slice(
        start,
        nextStep ? start + marker.length + nextStep.index : jobSource.length,
    );
}

function assertStepRunsCommand(step, command) {
    assert.match(
        step,
        new RegExp(`^ {14}run: ${escapeRegExp(command)}\\s*$`, "m"),
    );
}

function assertStepIsRequired(step) {
    assert.doesNotMatch(step, /^ {14}if:/m);
    assert.doesNotMatch(step, /^ {14}continue-on-error:/m);
}

function assertStepPrecedes(jobSource, firstStepName, secondStepName) {
    const firstIndex = jobSource.indexOf(`- name: ${firstStepName}`);
    const secondIndex = jobSource.indexOf(`- name: ${secondStepName}`);
    assert.ok(firstIndex >= 0, `Workflow step ${firstStepName} was not found.`);
    assert.ok(
        secondIndex >= 0,
        `Workflow step ${secondStepName} was not found.`,
    );
    assert.ok(
        firstIndex < secondIndex,
        `${firstStepName} must run before ${secondStepName}.`,
    );
}

function countOccurrences(source, value) {
    return source.split(value).length - 1;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
