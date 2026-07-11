# ArtGod Patch

## Source

This directory vendors `eth-keystore` 0.5.0 from crates.io.

- Crates.io archive checksum:
  `1fda3bf123be441da5260717e0661c25a2fd9cb2b2c1d20bf2e05580047158ab`
- Upstream license: Apache-2.0

## Archive-to-Vendor Inventory

The runtime library files come from the checksummed archive. ArtGod's Rust
source changes are limited to `src/lib.rs` and `src/error.rs`.

Intentional non-runtime layout differences are:

- `.cargo-ok` and `.cargo_vcs_info.json` are omitted registry-extraction
  metadata
- `.github/workflows/ci.yml` is omitted upstream repository CI
- `tests/mod.rs` is omitted because the crates.io archive excludes the fixture
  directory it requires; ArtGod keeps roundtrip, wrong-passphrase, and fixture
  coverage in the desktop and vendored-library suites
- `.gitignore` also excludes the standalone vendored-crate `Cargo.lock`
- this `ARTGOD-PATCH.md` provenance record is added

## Before This Patch

The upstream writer had one private, non-configurable scrypt policy:

| Parameter          | Upstream value   |
| ------------------ | ---------------- |
| `N`                | `2^13` (`8,192`) |
| `r`                | `8`              |
| `p`                | `1`              |
| `dklen`            | `32`             |
| Approximate memory | 8 MiB            |

`eth_keystore::encrypt_key` always used those values and wrote directly to a
destination file. It did not expose an in-memory document writer or accept
caller-selected work parameters. Alloy's `PrivateKeySigner::encrypt_keystore`
delegated to that function, so ArtGod could not strengthen the KDF through the
Alloy API.

## After This Patch

The source-pinned writer has one explicit ArtGod production policy:

| Parameter          | ArtGod value       |
| ------------------ | ------------------ |
| `N`                | `2^18` (`262,144`) |
| `r`                | `8`                |
| `p`                | `1`                |
| `dklen`            | `32`               |
| Approximate memory | 256 MiB            |

The patch adds:

- `ScryptKdfParams`, the explicit work-parameter input
- `ARTGOD_SCRYPT_KDF_PARAMS`, the single production policy
- `ETHEREUM_V3_DERIVED_KEY_LENGTH`, the owned format constant
- `encrypt_key_to_keystore`, an in-memory writer that requires explicit scrypt
  parameters
- validation that `N` is a non-zero power of two
- the `zeroize` dependency in both Cargo manifests
- zeroizing wrappers for derived encryption and MAC key buffers

The existing compatibility writer now consumes `ARTGOD_SCRYPT_KDF_PARAMS` too.
This prevents Alloy's convenience API from bypassing the production policy,
while ArtGod's production adapter calls the explicit in-memory writer and owns
atomic private-file persistence.

## Deliberately Unchanged

The patch does not change:

- the Ethereum V3 JSON shape
- AES-128-CTR encryption
- Keccak MAC construction
- salt, IV, or UUID generation
- PBKDF2 and scrypt derivation algorithms
- PBKDF2 and scrypt decryption behavior

There is no legacy-file migration code. No persisted desktop ArtGod keystores
exist that require preservation, so unlock and export remain decrypt-only
operations.
