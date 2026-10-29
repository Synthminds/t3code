# Build SynthOS for macOS Apple silicon

The desktop app uses the same SynthOS cockpit, GCH missions, editor, terminal, and connections as the web client. It packages its own local server. Build this fork to obtain these features; the upstream T3 download does not contain them.

## Build on a Mac

Use an Apple silicon Mac with [Vite+](https://viteplus.dev/guide/), the Node version pinned in `package.json`, Xcode Command Line Tools, and [Rust](https://www.rust-lang.org/tools/install). From this checkout:

```sh
xcode-select -p
rustup target add aarch64-apple-darwin
vp i --frozen-lockfile
vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --output-dir release/synthos-macos
```

The build produces a DMG and ZIP under `release/synthos-macos/`. Open the DMG and drag SynthOS to Applications. The app has its own `com.synthminds.synthos` identity, `synthos://` links, desktop profile, and `~/.synthos` server data. It can run alongside upstream T3. Saved provider credentials and the selected Obsidian vault belong to the host on which the app runs; the build does not include those credentials or a vault.

Local builds default to unsigned and are not notarized. macOS may require confirmation in Privacy & Security before opening them. Passkeys that require a signed, provisioned app are unavailable in that build; local sessions and normal pairing use the existing authentication path. Upstream automatic updates are disabled for this fork.

macOS packaging must run on macOS: it uses `sips`, `iconutil`, the Apple linker, and DMG tooling. A successful Linux web/server build is not evidence that a Mac app has launched.

## Build with GitHub Actions

Pushes to `feat/synthos-platform` automatically build the desktop artifacts when they change the desktop, server, web, shared packages, build scripts, toolchain, or this workflow. This permits the first build while the workflow exists only on the feature branch. Open **Actions → SynthOS macOS Apple silicon** to inspect the run and download its artifacts.

Manual **Run workflow** dispatch requires `.github/workflows/synthos-macos.yml` on the repository’s default branch. Once it is there, select the branch to build. The workflow uses GitHub’s standard `macos-15` Apple silicon runner and verifies the actual architecture before building. Standard hosted-runner compute is free for this public repository; artifact storage and retention remain subject to the account’s allowances.

It uploads the DMG, ZIP, source commit record, and SHA-256 checksums as a run artifact retained for 14 days. It verifies the packaged app identifier and executable architecture. It does not launch-test the app, publish a GitHub release, request Apple signing secrets, or enable an update feed. GitHub runner availability and account usage limits still apply.

For a public signed release, configure your own Apple Developer identity and notarization credentials using the existing [signing guidance](./development.md#signing-and-passkeys), then explicitly build with `--signed`. Use a SynthOS provisioning profile and associated domains; upstream T3 credentials are not interchangeable.
