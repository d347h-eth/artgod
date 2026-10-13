# Windows Build and Test

The build-check workflow produces an **unsigned Windows x64 NSIS test installer**
for Windows 11. It is a CI artifact, separate from official signed releases.
Windows ARM64 packaging and native Admin/browser journey qualification remain open.

## Build Contract

On a Windows x64 host with the documented Node/Yarn, Rust, MSVC and Windows SDK:

```sh
yarn install --immutable --mode=skip-build
yarn security:yarn:verify
yarn cargo:age-gate
yarn build:desktop:windows-bundle
yarn check:windows-bundled-runtime
```

The maintained Windows wrapper uses the shared locked Tauri launcher and Cargo's
configured target directory. `config/tauri-windows-bundler-tools.json` pins NSIS
3.11 and the Tauri NSIS plugin 0.5.3 by fixed GitHub asset IDs, SHA-256, size and
publication timestamp. The shared packaging input owner enforces at least 30
days before cache inspection, verifies upstream metadata on downloads, and
rehashes cached bytes. Each build freshly extracts the verified archive into
Tauri's local tools directory and replaces the plugin with the verified bytes.
It requires every file checked by the pinned bundler before starting Tauri.

The same production hook used on Linux/macOS builds only the trusted SQLite
binding, Admin/Userland and the pruned desktop runtime. Node/NATS acquisition,
reviewed package-local SQLite/Sharp closures, forbidden PnP state and exporter
checks remain owned by the existing runtime scripts. Cargo runs with `--locked`.
The installer is per-user and does not need an administrator install.

WebView2 is an **OS-managed prerequisite**. The wrapper sets
`webviewInstallMode.type` to `skip`: no Microsoft bootstrapper, offline installer,
or fixed WebView runtime is acquired or embedded. Windows 11 normally supplies
Evergreen WebView2; verify its presence before testing. A stripped installation
without WebView2 needs separately provisioned WebView2. This avoids the moving
installer-download path but does not pin or age-gate the OS-managed WebView.
See [Tauri's installer modes](https://v2.tauri.app/distribute/windows-installer/).

CI silently installs the actual NSIS payload into an isolated worktree `tmp/`
directory. It compares all runtime files with staging and with the wallet
recipient hashes emitted by the Rust release build, checks installed shell and
prompt bytes, executes SQLite/Sharp operations through each installed package
tree using bundled Node, and proves installed NATS binds IPv4 loopback. Native
sensitive-process tests execute the Windows WER/Job Object paths. This proof
does not start the desktop UI or place marketplace orders.

## Download and Windows 11 QA

Open the successful **Tauri Build Check** run for the feature branch/PR. Download
`windows-x64-test-<commit>` from its Artifacts section within 14 days and extract
the ZIP. It contains the installer, `SHA256SUMS.txt`, `build-info.json` with the
exact checked-out commit, and this guide. PR runs build the GitHub merge commit;
the recorded commit identifies the tested source.

In PowerShell, compare the result with the included checksum before installing:

```powershell
Get-FileHash .\ArtGod_0.1.3-alpha_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

Use the actual installer filename if the application version changes. Checksums
detect corruption; this test artifact has no Authenticode or release-key signature.
Windows may show an unknown-publisher/SmartScreen warning for an unsigned build.

On the spare machine, test this sequence with disposable app data:

1. Install as your normal user; open ArtGod and verify native Admin renders.
2. Save RPC/OpenSea configuration through Admin; start the runtime and verify
   readiness, logs and Userland browser opening.
3. Browse a collection and image to exercise SQLite and Sharp in the app.
4. Import a disposable wallet, unlock it, cancel a prompt and verify secrets
   never appear in Admin or logs. Do not use a funded wallet for this test.
5. Stop/restart the runtime; hide/reopen Admin through the tray.
6. Use tray shutdown, then relaunch and confirm configuration persists and no
   duplicate runtime remains. Test uninstall/reinstall without expecting an
   automatic app-data purge.

Record the build commit, Windows version, WebView2 version, failed step and
relevant sanitized logs. Signing, native journey QA, hard-parent-death Windows
proof and explicit wallet current-user ACL hardening remain release gaps.
Common runner/bootstrap input gaps are tracked in
[build input controls](../development/01-local-development.md#build-input-controls-and-remaining-gaps).
