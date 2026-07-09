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

Workflow policy:

- `.github/workflows/tauri-build-check.yml` uses no secrets and runs on pull
  requests, pushes to `main`, and manual dispatch.
- `.github/workflows/tauri-release.yml` runs on pushed `v*` tags.
- Shipped alpha/beta/rc tags, such as `v0.0.1-alpha.1`, publish as normal
  GitHub releases and are marked Latest. GitHub releases flagged as
  pre-releases cannot be marked Latest, so the workflow reserves the GitHub
  pre-release flag for test tags only.
- Test tags containing `-test.`, such as `v0.0.1-test.1`, publish as GitHub
  pre-releases and are not marked Latest.
- Plain stable tags such as `v1.0.0` also publish as normal Latest releases.
- The release workflow `build` and `release` jobs declare
  `environment: desktop-release-signing`.
- Environment secrets are still referenced through the GitHub Actions
  `secrets.NAME` context.

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
- App Store Connect API keys: https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api
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
6. Dry-run on a `-test.` tag and verify the final installer shows the
   maintainer's personal name as Publisher.

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

Consumer verification:

```sh
gpg --import artgod-release-signing-public.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
gpg --verify ArtGod-x.y.z.AppImage.asc ArtGod-x.y.z.AppImage
gpg --verify ArtGod-x.y.z.deb.asc ArtGod-x.y.z.deb
```

## Release Tag Checklist

Before pushing a `v*` tag:

1. Run `yarn sync:version`.
2. Confirm root `package.json`, workspace manifests, `src-tauri/tauri.conf.json`,
   and Cargo package version match.
3. Confirm the build check workflow passed after merge to `main`.
4. Run the release workflow once on a `-test.` dry-run tag.
5. Install each produced artifact on a clean Linux and macOS machine.
6. Verify macOS Gatekeeper opens the DMG without bypass actions.
7. Verify Linux GPG signatures and checksum manifest from a clean keyring.
