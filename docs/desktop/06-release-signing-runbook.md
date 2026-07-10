# Desktop Release Signing Runbook

This is the operator checklist for producing the first public desktop release.
The release workflow is `.github/workflows/tauri-release.yml`.
Signing and notarization secrets live in the GitHub Environment named
`desktop-release-signing`.

The target release artifacts are:

- Linux x64: AppImage and `.deb`
- macOS: universal DMG
- release manifest: `SHA256SUMS.txt`
- release signatures: Linux detached signatures and `SHA256SUMS.txt.asc`
- GitHub provenance attestation

## Maintainer Profile

This runbook is written for the first public release by an individual/private
person based in Germany, with no company or other legal entity behind the
project.

Release-signing consequences:

- macOS: use Apple Developer Program individual enrollment.
- Windows: deferred for the first public alpha.
- Linux: use a dedicated GPG release key and public fingerprint publication.

## Direct Signup and Purchase Links

Use these links for account setup and purchases. Re-check the vendor pages
before paying because certificate and managed-signing availability changes.

- macOS:
    - Apple Developer Program enrollment: https://developer.apple.com/programs/enroll/
    - Apple Developer account: https://developer.apple.com/account/
    - Certificates, Identifiers & Profiles: https://developer.apple.com/account/resources/certificates/list
    - App Store Connect API keys: https://appstoreconnect.apple.com/access/integrations/api
- Windows:
    - SSL.com Personal Identity Code Signing: https://www.ssl.com/certificates/iv-code-signing/
    - SSL.com eSigner for Code: https://www.ssl.com/esigner/
    - SSL.com GitHub Actions integration: https://www.ssl.com/how-to/cloud-code-signing-integration-with-github-actions/

Recommended first purchase path:

- macOS: buy only Apple Developer Program membership as an individual. Do not
  buy a separate public CA certificate for macOS Developer ID signing.
- Windows: do not buy or configure Windows signing for the first public alpha.
  Future Windows releases should use SSL.com Personal Identity Code Signing
  with eSigner CKA and `signtool.exe` on the Windows runner.
- Linux: do not buy a platform certificate. Use a dedicated release GPG key and
  publish the public key/fingerprint on stable maintainer-controlled profiles.
  Detailed setup is in `docs/desktop/05-linux-gpg-release-signing.md`.

## GitHub Environment Secret Placement

Create a GitHub Environment named `desktop-release-signing` and store all
release signing and notarization secrets there, not as repository-wide secrets.

Environment protection:

- Restrict deployments to release tags matching `v*` if the repository settings
  support tag restrictions.
- Optionally require the maintainer as reviewer before release jobs can access
  signing material.
- Under repository Settings / Rules / Rulesets, create an active tag ruleset for
  `v*` that restricts updates and deletions. Restrict creation only if the
  maintainer account has explicit bypass permission to create new release tags.
- Under repository Settings / Actions / General, enable the policy requiring
  Actions to be pinned to full commit SHAs when that setting is available.

Workflow policy:

- `.github/workflows/tauri-build-check.yml` uses no secrets and runs on pull
  requests, pushes to `main`, and manual dispatch.
- `.github/workflows/tauri-release.yml` builds on pushed `v*` tags. Its manual
  dispatch path only resumes delayed macOS notarization from an existing tag
  run; it does not rebuild or create another Apple submission.
- A shipped tag must exactly equal `v<root-package-version>`, such as
  `v0.0.1-pre-alpha.63` or `v1.0.0`. It publishes as a normal GitHub release
  and is marked Latest.
- A dry-run tag appends `-test.N` to the exact shipped tag, where `N` is a
  positive integer, such as `v0.0.1-pre-alpha.63-test.1`. It publishes as a
  GitHub pre-release and is not marked Latest. Test tags and their assets are
  public, not private staging releases.
- Initial and resumed runs require a GitHub-verified OpenPGP annotated tag whose
  target commit matches the event and checkout, is reachable from `origin/main`,
  and has synchronized project versions. Lightweight, mismatched, unsigned, or
  non-OpenPGP tags are rejected before release work.
- Tag admission gives its job-scoped `GITHUB_TOKEN` only to the validation step,
  strips it from Git child-process environments, follows no API redirects, uses
  bounded API calls, and never emits API response bodies on failure.
- The release workflow build, delayed-notarization resume, release assembly, and
  publication jobs use the `desktop-release-signing` environment.
- Environment secrets are still referenced through the GitHub Actions
  `secrets.NAME` context.
- All external Actions are pinned to full commit SHAs, every checkout disables
  credential persistence, and the workflow defaults `GITHUB_TOKEN` to
  read-only repository access.
- Release assembly has read-only repository permissions while it uses the Linux
  signing secret. The separate publication job has no signing secrets and owns
  the narrow write/OIDC permissions needed for attestation and GitHub Release
  publication.
- Release assembly re-verifies every transferred Linux bundle signature before
  it signs the checksum manifest. Publication occurs only after GitHub provenance
  attestation succeeds.

## Current Tauri State

The checked-in Tauri stack is pinned for public-alpha release validation:

- Rust `tauri`: `2.11.3`
- Rust `tauri-build`: `2.6.3`
- Rust `tauri-plugin-log`: `2.8.0`
- Rust `tauri-plugin-shell`: `2.3.5`
- JavaScript `@tauri-apps/cli`: `2.11.3`
- JavaScript `@tauri-apps/api`: `2.11.1`

As of 2026-07-08, newer Tauri packages are already published:

- `tauri`: `2.11.5`
- `@tauri-apps/cli`: `2.11.4`
- `@tauri-apps/api`: `2.11.1`

Routine dependency upgrades should keep Yarn's 30-day minimum-age gate enabled.
This branch intentionally lands on `tauri` / `@tauri-apps/cli` `2.11.3` as a
public-alpha release exception; keep any later Tauri bump as a separate review
chunk from signing setup. Run `yarn security:yarn:verify` after JavaScript
dependency updates and before pushing a release tag.

Expected future upgrade shape:

```sh
yarn up @tauri-apps/cli@<cli-version> @tauri-apps/api@<api-version> -E
yarn security:yarn:verify
cargo update --manifest-path src-tauri/Cargo.toml -p tauri --precise <runtime-version>
cargo update --manifest-path src-tauri/Cargo.toml -p tauri-build -p tauri-plugin-log -p tauri-plugin-shell
```

If Cargo does not select the intended versions, update `src-tauri/Cargo.toml`
version requirements explicitly and rerun the update.

Official references:

- Tauri releases: https://v2.tauri.app/release/
- Tauri CLI options: https://v2.tauri.app/reference/cli/

## macOS Signing

Use Apple Developer ID distribution for releases outside the Mac App Store.

What to buy:

- Apple Developer Program membership as an individual developer.
- The membership is annual and Apple lists it as `99 USD` per membership year.
  The German checkout may show local currency/tax handling during enrollment.
- The Developer ID certificate is created inside the Apple Developer account;
  there is no separate macOS certificate vendor purchase.

What to create:

- `Developer ID Application` certificate.
- App Store Connect team API key for notarization.

Procedure:

1. Enroll in the Apple Developer Program as an individual.
2. Enable two-factor authentication on the Apple Account.
3. In Certificates, Identifiers & Profiles, create a `Developer ID Application`
   certificate. This requires the Account Holder role.
4. Install the downloaded `.cer` in Keychain Access on a Mac.
5. Export the certificate and private key from Keychain Access as a passworded
   `.p12`.
6. In App Store Connect, request API access if it is not enabled yet.
7. Generate a team API key with Developer access from Users and Access /
   Integrations.
8. Download the `.p8` private key once and record:
    - issuer ID
    - key ID
    - team ID if needed later
9. Set GitHub Actions Environment secrets in `desktop-release-signing`:
    - `APPLE_CERTIFICATE`: base64 content of the exported `.p12`
    - `APPLE_CERTIFICATE_PASSWORD`: `.p12` export password
    - `APPLE_SIGNING_IDENTITY`: `Developer ID Application: <legal name> (<team id>)`
    - `APPLE_API_KEY_P8_B64`: base64 content of the App Store Connect `.p8`
    - `APPLE_API_KEY_ID`: App Store Connect key ID
    - `APPLE_API_ISSUER`: App Store Connect issuer ID

Important naming rule:

- `APPLE_API_KEY_P8_B64` is intentionally not named `APPLE_API_KEY`.
- Tauri uses `APPLE_API_KEY` to mean the App Store Connect key ID, while this
  workflow manually decodes the `.p8` file for `notarytool`.

The workflow imports the `.p12` into a temporary keychain, signs the `.app`,
notarizes the DMG with `xcrun notarytool`, staples the DMG, validates the
stapled ticket, and then runs Gatekeeper assessment on the DMG.

### Secret handling

- Signing and notarization credentials remain GitHub Environment secrets, so
  GitHub's runner masking protects their exact configured values.
- The generated keychain password is registered with `add-mask` before its
  first use, remains local to the keychain setup step, and is never exported
  through `GITHUB_ENV`.
- The temporary `.p12` uses mode `0600` and is deleted immediately after import.
  The temporary keychain is deleted and explicitly unlinked as soon as the
  signed Tauri build returns, before artifact upload Actions run.
- Each submit, poll, or resume command independently decodes the `.p8` into a
  mode-`0600` file under a unique mode-`0700` directory. The helper removes that
  directory before returning, so artifact Actions never run while the API key
  exists on disk.
- Apple API credentials are removed from every `notarytool`, `stapler`, and
  `spctl` child-process environment; authenticated values reach `notarytool`
  only through its required arguments.
- `scripts/build/macos-notarization.mjs` redacts exact credentials, common
  serialized forms, private-key payload fragments, authorization headers, and
  JWT-shaped derived credentials before writing child output to the runner's
  stdout/stderr. The same redactor covers thrown command errors and every
  persisted notarization diagnostic.
- Redaction tests inject sentinel credentials into split stdout chunks, stderr,
  failed command arguments, exception inspection, diagnostic files, and the
  command-scoped API-key lifecycle. Run the complete release security suite
  with `yarn test:desktop:release`.
- The shared output redactor rejects non-empty secrets shorter than four
  characters instead of silently allowing values it cannot safely stream.

GitHub masking remains defense in depth for the custom notarization commands;
raw `notarytool` output is not written to the public runner log first.

The notarization submission does not use `notarytool submit --wait`. The tag
run instead:

1. verifies and hashes the signed DMG
2. preserves that exact pre-staple DMG as an internal workflow artifact
3. submits it once with verbose upload diagnostics
4. persists the Apple submission ID before polling
5. polls with bounded retries for transient App Store Connect failures
6. verifies the accepted Apple log contains the same DMG SHA-256
7. staples, validates, and Gatekeeper-assesses the preserved DMG

If Apple is still processing when the initial poll window closes, the macOS
build job fails intentionally and the GitHub Release is not published. The
signed DMG and notarization state remain attached to that Actions run for the
configured retention period.

To finish a delayed submission:

1. Wait until `xcrun notarytool info <submission-id> ...` reports `Accepted`.
2. Open the `Tauri Release` workflow and choose `Run workflow`.
3. Select the original release tag in the workflow ref selector, not `main`.
4. Enter the numeric run ID from the original failed tag run. It is the number
   after `/actions/runs/` in that run's URL.
5. Start the workflow. It downloads the original DMG and submission state,
   verifies the repository, tag, commit, source run, size, and SHA-256, then
   queries the existing Apple submission and staples that DMG.

The resume path never submits another DMG. If Apple still reports processing,
the resume run exits without publishing; repeat it later using the same
original tag and source run ID. Verbose diagnostics and the pre-staple DMG
are internal workflow artifacts, not GitHub Release assets. Diagnostic text is
credential-redacted before upload.

Before DMG assembly, `beforeBundleCommand` runs
`scripts/build/macos-code-signing.mjs sign-staged` on the macOS runner. This
signs staged executable/loadable Mach-O files copied as runtime resources or
sidecars, including the bundled Node runtime, bundled NATS runtime, native
`.node` add-ons, and the secret-prompt sidecar. The release workflow then runs
`scripts/build/macos-code-signing.mjs verify-dmg` against the produced DMG,
mounts it, and verifies the contained `.app` before notarization.
Runtime resource staging also removes copied Yarn cache archives for packages
that PnP resolves from `.yarn/unplugged`. Those archives duplicate the unpacked
runtime packages and can contain unsigned native Mach-O binaries that Apple
notarization scans inside the DMG but `codesign` cannot sign in place.

Official references:

- Apple Developer Program: https://developer.apple.com/programs/
- Apple Developer Program enrollment: https://developer.apple.com/programs/enroll/
- Apple enrollment requirements: https://developer.apple.com/programs/enroll/
- Developer ID certificates: https://developer.apple.com/help/account/certificates/create-developer-id-certificates
- Developer ID / notarization overview: https://developer.apple.com/developer-id/
- Custom notarization workflow: https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- App Store Connect API keys: https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api
- GitHub Actions artifacts: https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts
- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub Actions log masking: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/

## Windows Signing

Windows release builds are deferred for the first public alpha. The release
workflow does not build or publish Windows artifacts.

When Windows releases are enabled later, use SSL.com Personal Identity Code
Signing with eSigner for Code.

Expected shape:

- SSL.com validates the maintainer's individual identity.
- The Authenticode publisher identity is the maintainer's personal name.
- Private key material stays in SSL.com's cloud HSM.
- GitHub-hosted Windows CI signs through eSigner CKA and `signtool.exe`.
- Do not use an exported certificate-file signing path for this release.

Procedure:

1. Buy SSL.com Personal Identity Code Signing.
2. Select eSigner for Code as the signing method.
3. Complete SSL.com individual identity validation.
4. Confirm the eSigner account, credential, and automation access are active.
5. Re-enable Windows in `.github/workflows/tauri-release.yml` with a job that installs
   eSigner CKA, signs the Windows installer with `signtool.exe`, timestamps the
   signature, and verifies the result with `signtool verify`.
6. Dry-run on the exact
   `v<root-package-version>-test.<positive-integer>` tag form and verify the
   final installer shows the maintainer's personal name as Publisher.

Expected workflow direction:

- Keep the Windows build on `windows-latest`.
- Build the NSIS installer first.
- Install/configure SSL.com eSigner CKA on the runner.
- Run `signtool.exe sign` against the produced installer through eSigner CKA.
- Run `signtool verify /pa /v` on the signed installer.
- Upload only the signed installer.

Official references:

- SSL.com Personal Identity Code Signing: https://www.ssl.com/certificates/iv-code-signing/
- SSL.com eSigner for Code: https://www.ssl.com/esigner/
- SSL.com GitHub Actions integration: https://www.ssl.com/how-to/cloud-code-signing-integration-with-github-actions/
- Tauri Windows signing: https://v2.tauri.app/distribute/sign/windows/

SmartScreen expectation:

- EV certificates historically have stronger initial SmartScreen reputation,
  but they are normally organization-oriented and not the baseline fit for this
  maintainer profile.
- Individual certificates can still show warnings until Microsoft builds
  reputation for the certificate and downloaded files.

## Linux Signing

Linux release trust is repository-local rather than platform-vendor trust.
Use a dedicated release GPG key and publish the public key/fingerprint on stable
profiles controlled by the maintainer.

Detailed Ubuntu setup, CI secret configuration, multi-key tradeoffs, rotation,
and compromise response are documented in:

- `docs/desktop/05-linux-gpg-release-signing.md`

Recommended key model:

- Preferred: offline project primary key plus one CI-exported Linux release
  signing subkey.
- Simpler fallback: one dedicated Linux release key exported into GitHub
  Actions secrets.

Recommended procedure:

1. Generate the chosen release key material on the maintainer's Ubuntu machine.
2. Protect every private key export with a strong passphrase.
3. Publish the public key and full fingerprint on the project README, GitHub
   profile, and any stable personal/project site.
4. Store GitHub Actions Environment secrets in `desktop-release-signing`:
    - `LINUX_GPG_PRIVATE_KEY_ASC`
    - `LINUX_GPG_PASSPHRASE`
    - `LINUX_GPG_KEY_ID`
    - optional `LINUX_GPG_OWNERTRUST`
5. Test verification from a clean machine before the first public tag.

CI uses `scripts/build/linux-gpg-signing.mjs` for both Linux bundle signatures
and `SHA256SUMS.txt.asc`. It validates the exact imported primary fingerprint,
selects only usable on-disk signing material, sends the passphrase over a file
descriptor, verifies the resulting `VALIDSIG` primary/signing fingerprints,
re-verifies every downloaded bundle signature after cross-job artifact transfer,
redacts all GPG output before emission, and removes the temporary keyring before
later Actions steps. Run its security coverage with
`yarn test:desktop:signing`.

Consumer verification:

```sh
gpg --import artgod-release-signing-public.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
gpg --verify ArtGod-x.y.z.AppImage.asc ArtGod-x.y.z.AppImage
gpg --verify ArtGod-x.y.z.deb.asc ArtGod-x.y.z.deb
```

## Release Tag Procedure

The tag-signing key is the maintainer's normal personal Git signing key. It is
separate from the dedicated Linux artifact release key stored in the protected
GitHub Environment. Before the first run:

1. Add the public part of the personal tag-signing GPG key to the maintainer's
   GitHub account under Settings / SSH and GPG keys.
2. Ensure the signing UID email is a verified email on that GitHub account.
3. Configure Git to use that key for signing and confirm `git tag -s` can access
   its private key locally.
4. Publish the Linux artifact-signing public key and fingerprint as described in
   `docs/desktop/05-linux-gpg-release-signing.md`.

After the version commit is merged to `main`, prepare a dry run from that exact
commit:

```sh
git switch main
git pull --ff-only origin main
git fetch origin --tags
yarn sync:version
yarn check:version
git diff --exit-code

VERSION="$(node --input-type=commonjs -p 'require("./package.json").version')"
TEST_TAG="v${VERSION}-test.1"
git tag -s "$TEST_TAG" -m "ArtGod ${TEST_TAG}"
git verify-tag "$TEST_TAG"
git push origin "$TEST_TAG"
```

Use `git tag -s -u <personal-signing-key-fingerprint> ...` when Git has more
than one candidate signing key. The workflow independently asks GitHub to
verify the OpenPGP signature; a locally valid tag still fails admission if the
public key or signing identity is not configured correctly on GitHub.

If macOS notarization is delayed, manually resume the workflow using the same
test tag and original run ID. A successful resume publishes the finalized DMG
with the Linux assets under that same test-tag GitHub Release.

After installing and verifying the dry-run artifacts on clean Linux and macOS
machines, push the public tag on the same commit. This is a new build and
release, not a promotion of the test-tag artifacts:

```sh
RELEASE_TAG="v${VERSION}"
test "$(git rev-parse HEAD)" = "$(git rev-parse "${TEST_TAG}^{commit}")"
git tag -s "$RELEASE_TAG" -m "ArtGod ${RELEASE_TAG}"
git verify-tag "$RELEASE_TAG"
git push origin "$RELEASE_TAG"
```

For both runs, verify Gatekeeper opens the DMG without bypass actions, verify
the Linux signatures and checksum manifest from a clean keyring, and confirm
the GitHub Release contains only the expected signed/stapled artifacts.

Official GitHub references:

- Git tag API and signature verification: https://docs.github.com/en/rest/git/tags
- Add a GPG key to a GitHub account: https://docs.github.com/en/authentication/managing-commit-signature-verification/adding-a-gpg-key-to-your-github-account
- Create a repository tag ruleset: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- Ruleset update/delete restrictions: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
