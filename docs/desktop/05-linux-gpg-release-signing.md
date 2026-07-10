# Linux GPG Release Signing Guide

This guide explains how to create and manage the Linux release-signing key used
by `.github/workflows/tauri-release.yml`.

It is written for an Ubuntu maintainer machine and GitHub-hosted release CI.
The goal is to sign:

- Linux bundle artifacts: `*.AppImage.asc`, `*.deb.asc`
- Release checksum manifest: `SHA256SUMS.txt.asc`

The current workflow expects these GitHub Actions secrets:

- `LINUX_GPG_PRIVATE_KEY_ASC`
- `LINUX_GPG_PASSPHRASE`
- `LINUX_GPG_KEY_ID`
- optional `LINUX_GPG_OWNERTRUST`

## Recommended Decision

Use the offline-primary-key setup if you are comfortable with the extra steps.

Good default for the first public release:

- Create one offline project primary key with certification capability only.
- Add one signing subkey for Linux releases.
- Export only the signing subkey material to GitHub Actions.
- Keep the primary key and revocation material on your own encrypted storage.
- Rotate the release signing subkey on a planned schedule, for example yearly.

This gives you one stable public fingerprint for the project while limiting the
secret material stored in GitHub. If the GitHub secret leaks, you revoke and
replace the signing subkey instead of replacing the whole project identity.

The simpler single-key setup is acceptable for a small first release, but it
puts the full release key in GitHub secrets. If that secret leaks, the whole key
identity must be revoked and replaced.

## Ubuntu Prerequisites

Install GnuPG:

```sh
sudo apt update
sudo apt install gnupg2 pinentry-curses
gpg --version
```

Use a dedicated working directory and a dedicated `GNUPGHOME` while preparing
release keys. Do not create key backups inside the Git repository.

```sh
umask 077
mkdir -p "$HOME/artgod-release-signing/gnupg"
export GNUPGHOME="$HOME/artgod-release-signing/gnupg"
chmod 700 "$GNUPGHOME"
```

Choose a release email before generating the final public key. The examples use
`release@example.invalid`; replace it with a real project or maintainer-controlled
address.

## Option A: Offline Primary Key With CI Signing Subkey

This is the recommended setup.

### 1. Create The Offline Primary Key

Create a primary key that can certify subkeys but cannot directly sign release
artifacts:

```sh
RELEASE_UID="ArtGod Release Primary <release@example.invalid>"
gpg --quick-generate-key "$RELEASE_UID" ed25519 cert 2y
gpg --list-secret-keys --keyid-format long --with-fingerprint "$RELEASE_UID"
```

Copy the 40-character primary fingerprint without spaces:

```sh
PRIMARY_FPR="<primary-fingerprint-without-spaces>"
```

Create and store a revocation certificate offline:

```sh
gpg --output artgod-release-primary-revocation.asc --generate-revocation "$PRIMARY_FPR"
```

### 2. Add A Linux Release Signing Subkey

Add a signing subkey. A one-year expiry is a good starting point because it
forces deliberate rotation without creating a constant operational burden.

```sh
gpg --quick-add-key "$PRIMARY_FPR" ed25519 sign 1y
gpg --list-secret-keys --keyid-format long --with-subkey-fingerprint "$PRIMARY_FPR"
```

Record the signing subkey fingerprint from the `ssb` entry:

```sh
SIGNING_SUBKEY_FPR="<signing-subkey-fingerprint-without-spaces>"
```

### 3. Export Public And CI-Only Secret Material

Export the public project key. This is safe to publish:

```sh
gpg --armor --export "$PRIMARY_FPR" > artgod-release-public.asc
```

Export only secret subkeys for CI. GnuPG leaves the primary secret key unusable
in this export, while retaining the signing subkey material needed in CI:

```sh
gpg --armor --export-secret-subkeys "$PRIMARY_FPR" > artgod-ci-linux-signing-subkeys.asc
```

Optional ownertrust backup:

```sh
gpg --export-ownertrust > artgod-release-ownertrust.txt
```

### 4. Verify The CI Export Does Not Include The Offline Primary

Import the CI secret export into a temporary keyring and inspect it:

```sh
TMP_GNUPGHOME="$(mktemp -d)"
chmod 700 "$TMP_GNUPGHOME"
GNUPGHOME="$TMP_GNUPGHOME" gpg --import artgod-ci-linux-signing-subkeys.asc
GNUPGHOME="$TMP_GNUPGHOME" gpg --list-secret-keys --keyid-format long --with-subkey-fingerprint "$PRIMARY_FPR"
rm -r "$TMP_GNUPGHOME"
```

Expected shape:

- the primary secret key line is shown as unavailable, commonly `sec#`
- the signing subkey line is available, commonly `ssb`

Do not continue if the temporary keyring shows a usable primary secret key.

### 5. Test Local Signing With The CI Export

Use the temporary keyring again so the test matches GitHub Actions:

```sh
TMP_GNUPGHOME="$(mktemp -d)"
chmod 700 "$TMP_GNUPGHOME"
printf 'test artifact\n' > test-artifact.txt
GNUPGHOME="$TMP_GNUPGHOME" gpg --import artgod-ci-linux-signing-subkeys.asc
GNUPGHOME="$TMP_GNUPGHOME" gpg --armor --detach-sign --local-user "$PRIMARY_FPR" test-artifact.txt
GNUPGHOME="$TMP_GNUPGHOME" gpg --verify test-artifact.txt.asc test-artifact.txt
rm -r "$TMP_GNUPGHOME"
rm -f test-artifact.txt test-artifact.txt.asc
```

If the key has more than one valid signing subkey later, use a dry-run release
to confirm GnuPG selects the intended active signing subkey. Prefer keeping only
one unexpired CI-exported signing subkey unless there is a concrete rotation
need.

### 6. Back Up Offline Material

Back up these files outside the repository:

- `artgod-release-public.asc`
- `artgod-release-primary-revocation.asc`
- `artgod-release-ownertrust.txt`, if created
- an encrypted archive or offline backup of the full `GNUPGHOME`

Recommended storage:

- one encrypted local backup
- one encrypted offline removable backup
- a printed or separately stored copy of the primary fingerprint

Do not put the full primary-key secret export in GitHub, a cloud drive, chat,
issue tracker, or project repository.

## Option B: Simple Dedicated Release Key

Use this only if you want the least operational complexity for a small first
release and accept that GitHub stores the full release-signing key.

```sh
RELEASE_UID="ArtGod Linux Release Signing <release@example.invalid>"
gpg --quick-generate-key "$RELEASE_UID" ed25519 sign 1y
gpg --list-secret-keys --keyid-format long --with-fingerprint "$RELEASE_UID"
```

Copy the fingerprint:

```sh
RELEASE_FPR="<release-key-fingerprint-without-spaces>"
```

Export public and secret material:

```sh
gpg --armor --export "$RELEASE_FPR" > artgod-linux-release-public.asc
gpg --armor --export-secret-keys "$RELEASE_FPR" > artgod-linux-release-private.asc
gpg --export-ownertrust > artgod-linux-release-ownertrust.txt
```

Set `LINUX_GPG_KEY_ID` to `RELEASE_FPR` and set `LINUX_GPG_PRIVATE_KEY_ASC` to
the contents of `artgod-linux-release-private.asc`.

## GitHub Actions Secret Setup

Use GitHub Environment secrets in `desktop-release-signing`, not repository-wide
secrets. The release workflow attaches this environment to both jobs that need
signing material.

Environment secret values:

- `LINUX_GPG_PRIVATE_KEY_ASC`: contents of `artgod-ci-linux-signing-subkeys.asc`
  for the recommended setup, or `artgod-linux-release-private.asc` for the
  simple setup
- `LINUX_GPG_PASSPHRASE`: passphrase for the exported signing key material
- `LINUX_GPG_KEY_ID`: exact 40-character primary fingerprint for the
  recommended setup, or release key fingerprint for the simple setup
- `LINUX_GPG_OWNERTRUST`: optional contents of the ownertrust export

`LINUX_GPG_PASSPHRASE` must be one line because CI supplies it through GPG's
passphrase file descriptor. Ownertrust affects local trust presentation; it is
not required for cryptographic signature validity.

Browser path:

1. Open the GitHub repository.
2. Go to `Settings` / `Environments`.
3. Create or open `desktop-release-signing`.
4. Add each secret above under Environment secrets.
5. Confirm the release workflow fails fast if any required Linux GPG secret is
   missing.

Optional `gh` CLI path:

```sh
gh secret set --env desktop-release-signing LINUX_GPG_PRIVATE_KEY_ASC < artgod-ci-linux-signing-subkeys.asc
gh secret set --env desktop-release-signing LINUX_GPG_PASSPHRASE
printf '%s' "$PRIMARY_FPR" | gh secret set --env desktop-release-signing LINUX_GPG_KEY_ID
gh secret set --env desktop-release-signing LINUX_GPG_OWNERTRUST < artgod-release-ownertrust.txt
```

If using the simple setup, replace the private-key file and fingerprint with the
simple key export and `RELEASE_FPR`.

## How The Current CI Workflow Uses The Key

The Linux build job:

1. Runs `scripts/build/linux-gpg-signing.mjs sign-bundles`.
2. Creates a unique temporary `GNUPGHOME` with process umask `077` and mode
   `0700`.
3. Removes every Linux signing secret from the environment inherited by GPG.
4. Imports `LINUX_GPG_PRIVATE_KEY_ASC` through stdin and imports ownertrust when
   present.
5. Requires exactly one imported primary key matching `LINUX_GPG_KEY_ID` and a
   usable on-disk signing key or subkey.
6. Signs each AppImage and `.deb` with an armored detached signature while
   supplying the passphrase through file descriptor 0, never a process
   argument.
7. Verifies each signature through GPG's machine-readable `VALIDSIG` status and
   requires the expected primary and imported signing-key fingerprints.
8. Kills the temporary GPG agent and removes `GNUPGHOME` before the artifact
   upload action runs.

The release job:

1. Downloads all build artifacts.
2. Generates `SHA256SUMS.txt`.
3. Runs the same helper with `finalize-release` in a fresh temporary GPG
   session.
4. Re-verifies every transferred AppImage and `.deb` signature against the
   expected primary and signing-subkey fingerprints.
5. Creates and provenance-verifies `SHA256SUMS.txt.asc` only after those
   transferred signatures pass.
6. Removes the temporary keyring before any publishing action runs.
7. Publishes artifacts, signatures, checksums, and GitHub provenance
   attestations.

All GPG stdout, stderr, failures, and key payload fragments pass through the
shared secret-output redactor before reaching the public runner log. The helper
refuses unsafe `--passphrase` arguments and refuses to run signing commands
without a populated redactor. Run the macOS and Linux signing security suite
with:

```sh
yarn test:desktop:signing
```

GPG may still print the release UID, primary fingerprint, signing-subkey
fingerprint, and signature status. Those values are intentionally public and
must match the public key information consumers use for verification.

This means the `desktop-release-signing` environment must be attached to both
the Linux matrix build job and the final release job.

## Public Key Publication

Before the first public tag, publish:

- the public key file
- the primary fingerprint
- the expected Linux artifact verification commands
- the rotation policy

Good locations:

- project README
- GitHub release notes
- maintainer GitHub profile
- maintainer-controlled website or DNS-backed page
- a checked-in public key file such as `docs/desktop/keys/artgod-release-public.asc`

Consumers should verify both the checksum manifest signature and the individual
artifact signature:

```sh
gpg --import artgod-release-public.asc
gpg --fingerprint "<release-key-or-primary-fingerprint>"
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
gpg --verify ArtGod-x.y.z.AppImage.asc ArtGod-x.y.z.AppImage
gpg --verify ArtGod-x.y.z.deb.asc ArtGod-x.y.z.deb
```

The fingerprint must be checked against a maintainer-controlled source. A valid
signature only proves control of the imported key.

## Rotation

Recommended schedule:

- signing subkey expiry: 1 year
- rotation window: create the next signing subkey 30 to 60 days before expiry
- primary key expiry: 2 years, extended from the offline primary key before it
  expires

Rotation steps for the recommended setup:

1. Restore or open the offline primary `GNUPGHOME`.
2. Add a new signing subkey:
   `gpg --quick-add-key "$PRIMARY_FPR" ed25519 sign 1y`.
3. Export the updated public key:
   `gpg --armor --export "$PRIMARY_FPR" > artgod-release-public.asc`.
4. Export updated CI signing subkeys:
   `gpg --armor --export-secret-subkeys "$PRIMARY_FPR" > artgod-ci-linux-signing-subkeys.asc`.
5. Update `LINUX_GPG_PRIVATE_KEY_ASC` in GitHub.
6. Dry-run the release workflow on the exact
   `v<root-package-version>-test.<positive-integer>` tag form.
7. Publish the updated public key and fingerprint notes.

If you want CI to carry only one active signing subkey, revoke or expire the old
subkey and then export again. Keep enough overlap for users to verify older
release signatures against the historical public key.

## Compromise Response

If the GitHub signing secret is suspected to be exposed:

1. Disable or remove `LINUX_GPG_PRIVATE_KEY_ASC` immediately.
2. Delete any draft release produced after the suspected exposure time.
3. Revoke the exposed signing subkey from the offline primary key.
4. Publish the updated public key with the revoked subkey.
5. Add a new signing subkey.
6. Update GitHub secrets.
7. Rebuild and re-sign a replacement release.
8. Publish a short incident note that names the affected key fingerprint,
   affected release tags, and replacement release tags.

If using the simple single-key setup, compromise requires revoking the entire
release key and publishing a new public key identity.

## References

- GnuPG manual: https://www.gnupg.org/documentation/manuals/gnupg/
- GnuPG key management: https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html
- GnuPG operational commands: https://www.gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html
- GnuPG unattended usage: https://www.gnupg.org/documentation/manuals/gnupg-devel/Unattended-Usage-of-GPG.html
- GnuPG passphrase options: https://gnupg.org/documentation/manuals/gnupg26/gpg.1.html
- GitHub Actions secrets: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
- GitHub Actions environments: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
