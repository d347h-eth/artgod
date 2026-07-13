import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const packageManifestPath = path.join(rootDir, "package.json");
const workflowsDirectory = path.join(rootDir, ".github", "workflows");
const fullCommitActionReferencePattern = /^[^\s@]+@[a-f0-9]{40}$/;
const webviewShellAclTestCommand =
    "cargo test --manifest-path src-tauri/Cargo.toml --test webview_capability_security";
const linuxRuntimeResourceLayoutTestCommand =
    "cargo test --manifest-path src-tauri/Cargo.toml --test linux_runtime_resource_layout";
const sensitiveProcessTestCommand = "yarn test:desktop:sensitive-process";
const sensitiveProcessBuildStepName = "Test sensitive process hardening";
const sensitiveProcessReleaseStepName =
    "Test release sensitive process hardening";
const sensitiveProcessGateScriptName = "test:desktop:sensitive-process";
const sensitiveProcessGateCommands = [
    "yarn build:desktop-sidecars --profile release",
    "node ./scripts/build/node-sensitive-process.test.mjs",
    "cargo test --manifest-path src-tauri/crates/artgod-sensitive-process/Cargo.toml",
    "cargo test --manifest-path src-tauri/sidecars/artgod-secret-prompt/Cargo.toml --locked",
    "runtime::supervisor::tests::trading_bot_node_args_disable_signal_started_inspection_exactly_once",
    "runtime::supervisor::tests::key_bearing_bot_environment_is_rebuilt_from_frozen_config",
];
const secretPromptParentContainmentTestCommand =
    "yarn test:desktop:secret-prompt-parent-containment";
const secretPromptParentContainmentGateScriptName =
    "test:desktop:secret-prompt-parent-containment";
const secretPromptParentContainmentGateCommands = [
    "cargo test --manifest-path src-tauri/Cargo.toml --locked --offline wallet::infra::prompt::secret_prompt_sidecar::tests --lib",
    "cargo test --manifest-path src-tauri/Cargo.toml --locked --offline wallet::infra::prompt::secret_prompt_sidecar::tests::export_reveal_fixture_never_survives_hard_parent_death --lib -- --ignored --exact",
    "cargo test --manifest-path src-tauri/sidecars/artgod-secret-prompt/Cargo.toml --locked --offline",
];
const desktopParentContainmentTestCommand =
    "yarn test:desktop:parent-containment";
const desktopParentContainmentGateScriptName =
    "test:desktop:parent-containment";
const desktopParentContainmentBuildStepName = "Test desktop parent containment";
const desktopParentContainmentReleaseStepName =
    "Test release desktop parent containment";
const macosPromptContainmentJobName = "macos-prompt-containment-check";
const macosRootCargoFetchStepName = "Fetch macOS root Cargo dependencies";
const macosRootCargoFetchCommand =
    "cargo fetch --manifest-path src-tauri/Cargo.toml --locked";
const macosPromptSidecarPrepareStepName = "Prepare macOS secret prompt sidecar";
const macosPromptSidecarPrepareCommand =
    "node ./scripts/build/prepare-desktop-sidecars.mjs --profile debug";
const macosPromptContainmentStepName = "Test secret prompt parent containment";
const windowsContainmentTarget = "x86_64-pc-windows-msvc";
const windowsSidecarPrepareCommand =
    "node ./scripts/build/prepare-desktop-sidecars.mjs --profile debug";
const windowsContainmentCheckCommand =
    "cargo check --manifest-path src-tauri/Cargo.toml --lib";
const desktopNoBundleBuildScriptName = "build:desktop:no-bundle";
const desktopNoBundleBuildCommand = "yarn build:desktop:no-bundle --debug";
const tauriNoBundleBuildStepName = "Tauri no-bundle build check";
const stagedRuntimeVerificationStepName =
    "Verify staged desktop runtime dependencies";
const stagedRuntimeVerificationCommand = "yarn check:desktop-runtime-resources";
const noBundleRuntimeVerificationStepName =
    "Verify no-bundle desktop runtime output";
const noBundleRuntimeVerificationCommand =
    "yarn check:desktop-no-bundle-runtime";
const linuxBundledRuntimeVerificationStepName =
    "Verify Linux bundled runtime integrity";
const linuxBundledRuntimeVerificationCommand =
    'yarn check:linux-bundled-runtime "src-tauri/target/${{ matrix.target }}/release/bundle"';
const tauriRuntimeOutputReconciliationTestCommand =
    "cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --test tauri_runtime_output_reconciliation";
const tauriRuntimeOutputReconciliationStepName =
    "Test Tauri runtime output reconciliation";
const desktopAdminManifestTestScriptName = "test:desktop:admin-manifest";
const desktopAdminManifestTestCommand =
    "cargo test --manifest-path src-tauri/Cargo.toml --locked runtime::app_config_manifest::tests::observability_settings_are_not_admin_managed --lib -- --exact";
const desktopAdminManifestStepName = "Test desktop Admin manifest";
const desktopAdminManifestWorkflowCommand = "yarn test:desktop:admin-manifest";

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

test("tests reconciliation and final output around one no-bundle build", async () => {
    const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
    );
    assert.equal(
        packageManifest.scripts?.[desktopNoBundleBuildScriptName],
        "tauri build --no-bundle --ci",
    );

    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const tauriCheckJob = extractWorkflowJob(workflow, "tauri-check");
    const reconciliationStep = extractWorkflowStep(
        tauriCheckJob,
        tauriRuntimeOutputReconciliationStepName,
    );
    const buildStep = extractWorkflowStep(
        tauriCheckJob,
        tauriNoBundleBuildStepName,
    );
    const runtimeVerificationStep = extractWorkflowStep(
        tauriCheckJob,
        stagedRuntimeVerificationStepName,
    );
    const noBundleRuntimeVerificationStep = extractWorkflowStep(
        tauriCheckJob,
        noBundleRuntimeVerificationStepName,
    );

    assert.ok(
        reconciliationStep.includes(
            tauriRuntimeOutputReconciliationTestCommand,
        ),
    );
    assert.equal(
        countOccurrences(tauriCheckJob, desktopNoBundleBuildCommand),
        1,
    );
    assertStepIsRequired(reconciliationStep);
    assertStepIsRequired(buildStep);
    assertStepRunsCommand(
        runtimeVerificationStep,
        stagedRuntimeVerificationCommand,
    );
    assertStepIsRequired(runtimeVerificationStep);
    assertStepRunsCommand(
        noBundleRuntimeVerificationStep,
        noBundleRuntimeVerificationCommand,
    );
    assertStepIsRequired(noBundleRuntimeVerificationStep);
    assertStepPrecedes(
        tauriCheckJob,
        tauriNoBundleBuildStepName,
        stagedRuntimeVerificationStepName,
    );
    assertStepPrecedes(
        tauriCheckJob,
        stagedRuntimeVerificationStepName,
        noBundleRuntimeVerificationStepName,
    );
});

test("gates desktop Admin observability removal in Tauri jobs", async () => {
    const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
    );
    assert.equal(
        packageManifest.scripts?.[desktopAdminManifestTestScriptName],
        desktopAdminManifestTestCommand,
    );
    assert.doesNotMatch(
        packageManifest.scripts?.["test:desktop:release-inputs"] ?? "",
        new RegExp(
            `(?:^|&& )yarn ${desktopAdminManifestTestScriptName}(?: |&&|$)`,
        ),
    );

    const buildCheckWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const buildCheckJob = extractWorkflowJob(buildCheckWorkflow, "tauri-check");
    const buildCheckStep = extractWorkflowStep(
        buildCheckJob,
        desktopAdminManifestStepName,
    );
    assertStepRunsCommand(buildCheckStep, desktopAdminManifestWorkflowCommand);
    assertStepIsRequired(buildCheckStep);

    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const releaseBuildJob = extractWorkflowJob(releaseWorkflow, "build");
    const releaseBuildStep = extractWorkflowStep(
        releaseBuildJob,
        desktopAdminManifestStepName,
    );
    assertStepRunsCommand(
        releaseBuildStep,
        desktopAdminManifestWorkflowCommand,
    );
    assert.match(releaseBuildStep, /^ {14}if: runner\.os == 'Linux'$/m);
    assert.doesNotMatch(releaseBuildStep, /^ {14}continue-on-error:/m);
});

test("verifies staged and final runtime bytes after release packaging", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const buildJob = extractWorkflowJob(workflow, "build");
    const stagedVerificationStep = extractWorkflowStep(
        buildJob,
        stagedRuntimeVerificationStepName,
    );
    const linuxBundleVerificationStep = extractWorkflowStep(
        buildJob,
        linuxBundledRuntimeVerificationStepName,
    );

    assertStepRunsCommand(
        stagedVerificationStep,
        stagedRuntimeVerificationCommand,
    );
    assertStepIsRequired(stagedVerificationStep);
    assertStepRunsCommand(
        linuxBundleVerificationStep,
        linuxBundledRuntimeVerificationCommand,
    );
    assert.match(
        linuxBundleVerificationStep,
        /^ {14}if: runner\.os == 'Linux'$/m,
    );
    assert.doesNotMatch(
        linuxBundleVerificationStep,
        /^ {14}continue-on-error:/m,
    );

    for (const buildStepName of [
        "Build Linux Tauri bundle",
        "Build macOS Tauri bundle",
    ]) {
        assertStepPrecedes(
            buildJob,
            buildStepName,
            stagedRuntimeVerificationStepName,
        );
    }
    assertStepPrecedes(
        buildJob,
        stagedRuntimeVerificationStepName,
        linuxBundledRuntimeVerificationStepName,
    );
    assertStepPrecedes(
        buildJob,
        linuxBundledRuntimeVerificationStepName,
        "Collect release artifacts",
    );
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

test("tests the Linux runtime resource layout in build and release lanes", async () => {
    for (const workflowName of ["tauri-build-check.yml", "tauri-release.yml"]) {
        const workflow = await readFile(
            path.join(workflowsDirectory, workflowName),
            "utf8",
        );
        assert.ok(
            workflow.includes(linuxRuntimeResourceLayoutTestCommand),
            `${workflowName} does not test the Linux runtime resource layout.`,
        );
    }
});

test("runs desktop parent containment in the ordinary Linux Tauri build job", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const tauriCheckJob = extractWorkflowJob(workflow, "tauri-check");
    const containmentStep = extractWorkflowStep(
        tauriCheckJob,
        desktopParentContainmentBuildStepName,
    );

    assert.equal(
        countOccurrences(workflow, desktopParentContainmentTestCommand),
        1,
    );
    assert.doesNotMatch(tauriCheckJob, /^ {8}continue-on-error:/m);
    assertStepRunsCommand(containmentStep, desktopParentContainmentTestCommand);
    assertStepIsRequired(containmentStep);
    assertStepPrecedes(
        tauriCheckJob,
        desktopParentContainmentBuildStepName,
        "Tauri no-bundle build check",
    );
});

test("runs sensitive-process hardening before the ordinary Tauri build", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const tauriCheckJob = extractWorkflowJob(workflow, "tauri-check");
    const hardeningStep = extractWorkflowStep(
        tauriCheckJob,
        sensitiveProcessBuildStepName,
    );

    assert.equal(countOccurrences(workflow, sensitiveProcessTestCommand), 1);
    assertStepRunsCommand(hardeningStep, sensitiveProcessTestCommand);
    assertStepIsRequired(hardeningStep);
    assertStepPrecedes(
        tauriCheckJob,
        sensitiveProcessBuildStepName,
        desktopParentContainmentBuildStepName,
    );
    assertStepPrecedes(
        tauriCheckJob,
        sensitiveProcessBuildStepName,
        "Tauri no-bundle build check",
    );
});

test("keeps every sensitive-process proof in the release gate alias", async () => {
    const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
    );
    const gateScript =
        packageManifest.scripts?.[sensitiveProcessGateScriptName];
    assert.equal(typeof gateScript, "string");

    let previousCommandIndex = -1;
    for (const command of sensitiveProcessGateCommands) {
        const commandIndex = gateScript.indexOf(command);
        assert.ok(
            commandIndex >= 0,
            `${sensitiveProcessGateScriptName} omits ${command}.`,
        );
        assert.ok(
            commandIndex > previousCommandIndex,
            `${sensitiveProcessGateScriptName} runs ${command} out of order.`,
        );
        previousCommandIndex = commandIndex;
    }
});

test("keeps prompt lifecycle proofs in the combined parent-containment gate", async () => {
    const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
    );
    const promptGateScript =
        packageManifest.scripts?.[secretPromptParentContainmentGateScriptName];
    assert.equal(typeof promptGateScript, "string");

    let previousCommandIndex = -1;
    for (const command of secretPromptParentContainmentGateCommands) {
        const commandIndex = promptGateScript.indexOf(command);
        assert.ok(
            commandIndex >= 0,
            `${secretPromptParentContainmentGateScriptName} omits ${command}.`,
        );
        assert.ok(
            commandIndex > previousCommandIndex,
            `${secretPromptParentContainmentGateScriptName} runs ${command} out of order.`,
        );
        previousCommandIndex = commandIndex;
    }

    const combinedGateScript =
        packageManifest.scripts?.[desktopParentContainmentGateScriptName];
    assert.equal(typeof combinedGateScript, "string");
    assert.ok(
        combinedGateScript.includes(secretPromptParentContainmentTestCommand),
        `${desktopParentContainmentGateScriptName} omits ${secretPromptParentContainmentTestCommand}.`,
    );
});

test("runs prompt parent containment in an ordinary required macOS job", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-build-check.yml"),
        "utf8",
    );
    const macosJob = extractWorkflowJob(
        workflow,
        macosPromptContainmentJobName,
    );
    const rootCargoFetchStep = extractWorkflowStep(
        macosJob,
        macosRootCargoFetchStepName,
    );
    const sidecarStep = extractWorkflowStep(
        macosJob,
        macosPromptSidecarPrepareStepName,
    );
    const containmentStep = extractWorkflowStep(
        macosJob,
        macosPromptContainmentStepName,
    );

    assert.match(macosJob, /^ {8}runs-on: macos-latest$/m);
    assert.doesNotMatch(macosJob, /^ {8}if:/m);
    assert.doesNotMatch(macosJob, /^ {8}continue-on-error:/m);
    assertStepRunsCommand(rootCargoFetchStep, macosRootCargoFetchCommand);
    assertStepIsRequired(rootCargoFetchStep);
    assertStepRunsCommand(sidecarStep, macosPromptSidecarPrepareCommand);
    assertStepIsRequired(sidecarStep);
    assertStepRunsCommand(
        containmentStep,
        secretPromptParentContainmentTestCommand,
    );
    assertStepIsRequired(containmentStep);
    assertStepPrecedes(
        macosJob,
        macosPromptSidecarPrepareStepName,
        macosPromptContainmentStepName,
    );
    assertStepPrecedes(
        macosJob,
        macosRootCargoFetchStepName,
        macosPromptContainmentStepName,
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
        desktopParentContainmentReleaseStepName,
    );

    assert.equal(
        countOccurrences(workflow, desktopParentContainmentTestCommand),
        1,
    );
    assert.match(buildJob, /^ {20}- os: ubuntu-22\.04$/m);
    assert.match(buildJob, /^ {20}- os: macos-latest$/m);
    assert.doesNotMatch(buildJob, /^ {8}continue-on-error:/m);
    assertStepRunsCommand(containmentStep, desktopParentContainmentTestCommand);
    assertStepIsRequired(containmentStep);

    for (const buildStepName of [
        "Build Linux Tauri bundle",
        "Build macOS Tauri bundle",
    ]) {
        assertStepPrecedes(
            buildJob,
            desktopParentContainmentReleaseStepName,
            buildStepName,
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
            desktopParentContainmentReleaseStepName,
            protectedStepName,
        );
    }
});

test("runs release sensitive-process hardening on both platforms before packaging", async () => {
    const workflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );
    const buildJob = extractWorkflowJob(workflow, "build");
    const hardeningStep = extractWorkflowStep(
        buildJob,
        sensitiveProcessReleaseStepName,
    );

    assert.equal(countOccurrences(workflow, sensitiveProcessTestCommand), 1);
    assert.match(buildJob, /^ {20}- os: ubuntu-22\.04$/m);
    assert.match(buildJob, /^ {20}- os: macos-latest$/m);
    assertStepRunsCommand(hardeningStep, sensitiveProcessTestCommand);
    assertStepIsRequired(hardeningStep);
    assertStepPrecedes(
        buildJob,
        sensitiveProcessReleaseStepName,
        desktopParentContainmentReleaseStepName,
    );
    for (const buildStepName of [
        "Build Linux Tauri bundle",
        "Build macOS Tauri bundle",
    ]) {
        assertStepPrecedes(
            buildJob,
            sensitiveProcessReleaseStepName,
            buildStepName,
        );
    }
});

test("compiles the Windows sensitive-process hardening path", async () => {
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
        "Check Windows sensitive-process hardening",
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
        "Check Windows sensitive-process hardening",
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
