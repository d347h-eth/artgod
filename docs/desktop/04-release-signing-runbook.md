# Desktop Release Signing Runbook

This is the operator checklist for producing the first public desktop release.
The release workflow is `.github/workflows/tauri-release.yml`.

The target release artifacts are:

- Linux x64: AppImage and `.deb`
- Windows x64: NSIS installer
- macOS: universal DMG
- release manifest: `SHA256SUMS.txt`
- release signatures: Linux detached signatures and `SHA256SUMS.txt.asc`
- GitHub provenance attestation

## Direct Signup and Purchase Links

Use these links for account setup and purchases. Re-check the vendor pages
before paying because certificate and managed-signing availability changes.

- macOS:
  - Apple Developer Program enrollment: https://developer.apple.com/programs/enroll/
  - Apple Developer account: https://developer.apple.com/account/
  - Certificates, Identifiers & Profiles: https://developer.apple.com/account/resources/certificates/list
  - App Store Connect API keys: https://appstoreconnect.apple.com/access/integrations/api
- Windows preferred path:
  - Azure account signup: https://azure.microsoft.com/free/
  - Azure Artifact Signing product page: https://azure.microsoft.com/en-us/products/artifact-signing
  - Azure Artifact Signing pricing: https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
  - Azure portal Artifact Signing Accounts: https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.CodeSigning%2FcodeSigningAccounts
- Windows fallback vendors:
  - SSL.com Personal Identity Code Signing: https://www.ssl.com/certificates/iv-code-signing/
  - Certum Open Source Code Signing: https://shop.certum.eu/open-source-code-signing.html

Recommended first purchase path:

- macOS: buy only Apple Developer Program membership as an individual. Do not
  buy a separate public CA certificate for macOS Developer ID signing.
- Windows: prefer Azure Artifact Signing if the individual-developer public
  trust path is available for the maintainer's country. If it is unavailable,
  use a public code-signing vendor such as SSL.com or Certum, but plan a
  workflow change for that vendor's cloud-signing or hardware-token flow.
- Linux: do not buy a platform certificate. Use a dedicated release GPG key and
  publish the public key/fingerprint on stable maintainer-controlled profiles.

## Current Tauri State

The current checked-in Tauri stack is not fully current:

- Rust `tauri`: `2.10.2`
- Rust `tauri-build`: `2.5.5`
- JavaScript `@tauri-apps/cli`: locked to `2.6.0`
- JavaScript `@tauri-apps/api`: locked to `2.9.1`

As of 2026-06-23, the current Tauri v2 release line is:

- `tauri`: `2.11.3`
- `@tauri-apps/api`: `2.11.1`
- `tauri-cli` / `@tauri-apps/cli`: `2.11.3`
- `tauri-bundler`: `2.9.3`

Upgrade Tauri before a public release candidate, but keep it as a separate
review chunk from signing setup. The release pipeline should be green on the
current stack first, then the Tauri upgrade should run through the same matrix.

Expected upgrade shape:

```sh
yarn up @tauri-apps/cli@2.11.3 @tauri-apps/api@2.11.1
cargo update --manifest-path src-tauri/Cargo.toml -p tauri -p tauri-build -p tauri-plugin-log -p tauri-plugin-shell
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
9. Set GitHub Actions secrets:
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

Official references:

- Apple Developer Program: https://developer.apple.com/programs/
- Apple Developer Program enrollment: https://developer.apple.com/programs/enroll/
- Apple enrollment requirements: https://developer.apple.com/programs/enroll/
- Developer ID certificates: https://developer.apple.com/help/account/certificates/create-developer-id-certificates
- Developer ID / notarization overview: https://developer.apple.com/developer-id/
- App Store Connect API keys: https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/

## Windows Signing

Prefer Azure Artifact Signing for an individual developer release.
It is Microsoft's managed successor naming for Trusted Signing and avoids
exporting private keys into CI. The service keeps keys in Microsoft-managed
FIPS 140-2 Level 3 hardware modules and does not support importing or exporting
private keys or certificates.

### Option A: Azure Artifact Signing

Use this path unless there is a strong reason to buy a traditional CA
certificate.

Availability note:

- Public Trust Artifact Signing is currently available to organizations in the
  USA, Canada, the European Union, and the United Kingdom, and to individual
  developers in the USA and Canada. For an individual developer outside those
  regions, use a traditional code-signing vendor or reassess the current
  Microsoft availability before release.

What to buy:

- Azure Artifact Signing account with public trust signing.
- Microsoft lists Basic and Premium plans. The public pricing page is dynamic,
  so confirm the actual monthly price in the Azure portal or pricing calculator
  before creating the Artifact Signing account.

What to create:

- Artifact Signing account.
- Public identity validation for `Individual`.
- Public Trust certificate profile.
- Microsoft Entra app registration for GitHub Actions.
- Client secret for that app registration.
- RBAC assignment granting the app `Artifact Signing Certificate Profile Signer`
  on the certificate profile scope.

Procedure:

1. Create or use an Azure subscription.
2. Register the `Microsoft.CodeSigning` resource provider.
3. Create an Artifact Signing account in a supported region.
4. In the Artifact Signing account, create an Individual / Public identity
   validation request. Use the exact name from government ID.
5. Complete the emailed identity verification flow. Microsoft documents public
   identity validation as taking 1 to 20 business days, sometimes longer.
6. Create a Public Trust certificate profile from the completed identity
   validation.
7. Create a Microsoft Entra app registration for GitHub Actions.
8. Create a client secret on that app registration.
9. Assign `Artifact Signing Certificate Profile Signer` to that app on the
   certificate profile scope.
10. Set GitHub Actions secrets:
    - `AZURE_ARTIFACT_SIGNING_ENDPOINT`: region endpoint, for example `https://wus2.codesigning.azure.net`
    - `AZURE_ARTIFACT_SIGNING_ACCOUNT`: Artifact Signing account name
    - `AZURE_ARTIFACT_SIGNING_CERT_PROFILE`: certificate profile name
    - `AZURE_CLIENT_ID`: app registration client ID
    - `AZURE_CLIENT_SECRET`: app registration client secret value
    - `AZURE_TENANT_ID`: Entra tenant ID

Portal starting points:

- Azure signup: https://azure.microsoft.com/free/
- Artifact Signing Accounts: https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.CodeSigning%2FcodeSigningAccounts

If the Azure portal deep link changes, sign in to the Azure portal and search
for `Artifact Signing Accounts`.

The workflow installs `artifact-signing-cli`, writes a temporary Tauri config
with a `trusted-signing-cli ... %1` sign command, builds the Windows bundle, and
then verifies the installer signature with `signtool verify`.

Official references:

- Azure Artifact Signing: https://azure.microsoft.com/en-us/products/artifact-signing
- Artifact Signing pricing: https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- Artifact Signing setup quickstart: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Artifact Signing certificate management: https://learn.microsoft.com/en-us/azure/trusted-signing/concept-trusted-signing-cert-management
- Artifact Signing roles: https://learn.microsoft.com/en-us/azure/trusted-signing/tutorial-assign-roles
- Tauri Windows signing: https://v2.tauri.app/distribute/sign/windows/

### Option B: Exportable PFX Certificate

Use this only if the issuer gives you an exportable code-signing certificate.
Many modern OV/EV issuance flows use hardware or managed signing instead of an
exportable private key. Tauri's own OV certificate guide warns that its PFX
instructions apply only to OV certificates acquired before 2023-06-01 and says
to follow the issuer documentation for EV certificates and OV certificates
issued after that date.

What to set in GitHub Actions:

- `WINDOWS_CERT_PFX_B64`: base64 content of the `.pfx`
- `WINDOWS_CERT_PASSWORD`: `.pfx` password
- optional `WINDOWS_CERT_SHA1`: certificate thumbprint

The workflow imports the `.pfx` into the Windows certificate store, writes a
temporary Tauri config with `certificateThumbprint`, signs during `tauri build`,
and verifies the installer with `signtool verify`.

SmartScreen expectation:

- EV certificates usually receive immediate SmartScreen reputation.
- OV or individual certificates can still show warnings until Microsoft builds
  reputation for the certificate and downloaded files.

Individual/open-source vendor notes:

- SSL.com sells Personal Identity Code Signing certificates for independent
  developers and individual contributors. Their current order page offers
  YubiKey token and eSigner cloud signing options, not an ordinary CI-friendly
  exported private key by default.
- Certum sells an Open Source Code Signing set intended for open-source
  software. Its current page describes a cryptographic card/card-reader set, so
  GitHub-hosted CI signing would need a vendor/cloud integration or a
  self-hosted runner with hardware access.
- The current workflow's PFX backend is a fallback for an issuer-provided
  exportable `.pfx`. Do not assume a newly purchased public code-signing
  certificate will be exportable.

## Linux Signing

Linux release trust is repository-local rather than platform-vendor trust.
Use a dedicated release GPG key and publish the public key/fingerprint on stable
profiles controlled by the maintainer.

Recommended procedure:

1. Generate a dedicated signing key used only for ArtGod releases.
2. Protect it with a strong passphrase.
3. Publish the public key and full fingerprint on the project README, GitHub
   profile, and any stable personal/project site.
4. Store GitHub Actions secrets:
   - `LINUX_GPG_PRIVATE_KEY_ASC`
   - `LINUX_GPG_PASSPHRASE`
   - `LINUX_GPG_KEY_ID`
   - optional `LINUX_GPG_OWNERTRUST`
5. Test verification from a clean machine before the first public tag.

Example commands:

```sh
gpg --quick-gen-key "ArtGod Release Signing <release@example.invalid>" ed25519 sign 2y
gpg --list-secret-keys --keyid-format long
gpg --armor --export <key-id> > artgod-release-signing-public.asc
gpg --armor --export-secret-keys <key-id> > artgod-release-signing-private.asc
gpg --export-ownertrust > artgod-release-signing-ownertrust.txt
```

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
3. Run the Linux build check workflow on the release branch.
4. Run the release workflow once manually or on a private dry-run tag.
5. Install each produced artifact on a clean Linux, Windows, and macOS machine.
6. Verify macOS Gatekeeper opens the DMG without bypass actions.
7. Verify Windows installer publisher is the intended individual or Artifact
   Signing identity.
8. Verify Linux GPG signatures and checksum manifest from a clean keyring.
