# ArtGod Patch

## Source

This directory vendors `eth-keystore` 0.5.0 from crates.io.

- Crates.io archive checksum:
  `1fda3bf123be441da5260717e0661c25a2fd9cb2b2c1d20bf2e05580047158ab`
- Upstream license: Apache-2.0

## Direct Implementation Comparison

The remediation was checked directly against immutable upstream release sources
on 2026-07-12:

| Project | Pinned source                                                                                                                                               | Writer observed in that source                                                              | Default scrypt profile                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Foundry | [`v1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`, 2026-05-08)](https://github.com/foundry-rs/foundry/tree/4072e48705af9d93e3c0f6e29e93b5e9a40caed8)    | `alloy-signer-local` 2.0.1 delegates to the unmodified registry `eth-keystore` 0.5.0 writer | `N=2^13`, `r=8`, `p=1`, `dklen=32`           |
| Geth    | [`v1.17.4` (`36a7dc72e96b3f42846be925cfeb2fad18489917`, 2026-06-22)](https://github.com/ethereum/go-ethereum/tree/36a7dc72e96b3f42846be925cfeb2fad18489917) | Geth's parameterized wrapper calls unmodified `golang.org/x/crypto/scrypt` 0.48.0           | Standard: `N=2^18`, `r=8`, `p=1`, `dklen=32` |

Immutable review anchors:

- Foundry's [`alloy-signer-local` resolution](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/Cargo.lock#L867-L884), exact [`eth-keystore` package](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/Cargo.lock#L4318-L4337), [`PrivateKeySigner::encrypt_keystore` call](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/cast/src/cmd/wallet/mod.rs#L773-L779), and the published [`alloy-signer-local` 2.0.1](https://docs.rs/crate/alloy-signer-local/2.0.1/source/src/private_key.rs) plus [`eth-keystore` 0.5.0](https://docs.rs/crate/eth-keystore/0.5.0/source/src/lib.rs) sources
- Geth's [standard and light policies](https://github.com/ethereum/go-ethereum/blob/36a7dc72e96b3f42846be925cfeb2fad18489917/accounts/keystore/passphrase.go#L52-L69), [parameterized writer](https://github.com/ethereum/go-ethereum/blob/36a7dc72e96b3f42846be925cfeb2fad18489917/accounts/keystore/passphrase.go#L139-L197), and [decrypted-address binding](https://github.com/ethereum/go-ethereum/blob/36a7dc72e96b3f42846be925cfeb2fad18489917/accounts/keystore/passphrase.go#L82-L96)

The then-current master snapshots were also checked: Foundry
[`61a1bb421e4aa5c4ce38da57f5e9064b0aff3330`](https://github.com/foundry-rs/foundry/tree/61a1bb421e4aa5c4ce38da57f5e9064b0aff3330)
and Geth
[`3ab52d837d7baec73b53cdfbdb3bfb5fee6a81fe`](https://github.com/ethereum/go-ethereum/tree/3ab52d837d7baec73b53cdfbdb3bfb5fee6a81fe).
Their relevant keystore behavior matched the pinned releases.

This comparison established that:

- ArtGod patches the `eth-keystore` wrapper, not the RustCrypto scrypt primitive
- Foundry proves Ethereum V3 read interoperability but retains the weak
  `eth-keystore` writer default
- Geth already owns a parameterized in-memory writer and uses the profile ArtGod
  selected as its standard default
- Geth also exposes an explicit weaker light profile, while ArtGod deliberately
  enforces one production write policy
- checked-in keystore samples and test vectors prove reader behavior; they do
  not establish the defaults used by a production writer

The Geth comparison also highlighted its decrypted-key address binding. ArtGod's
desktop adapter now performs the same identity check before returning key
material to export, remove verification, or bot-unlock callers. That adapter
also takes immediate zeroizing ownership of the plaintext allocation returned by
`decrypt_key` before constructing the Alloy signer. Those adapter changes are
outside this vendored crate.

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
