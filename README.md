# SynthOS · Night Riders

SynthOS brings the GCH multi-model workflow and Night Riders cockpit into a customized [T3 Code](https://github.com/pingdotgg/t3code) workspace. T3 owns agent execution, terminals, projects and checkpoints. SynthOS adds durable missions, knowledge and memory connections, reviewed mail, and device intake.

The lead car stays at the top of the cockpit. Search, grep and documentation motorcycles represent their assigned roles; activity lights follow observed work. Midnight Protocol extends the synthwave palette across the editor, terminal and settings.

## Run this fork

Install [Vite+](https://viteplus.dev/guide/) and use the Node and package-manager versions pinned in `package.json`.

```sh
vp i
vp run dev
```

Open the URL printed by the runner, complete pairing, then choose **SynthOS** in the sidebar or visit `/synthos` on that origin. Provider logins belong to the host running the server.

To build and run the local CLI with the bundled web app:

```sh
vp run --filter t3 build
node apps/server/dist/bin.mjs --no-browser
```

The CLI is named `gch`; this checkout runs it directly through the entrypoint above. Upstream T3 installers and automatic release updates do not install this fork. SynthOS uses its own `.synthos` data directory and desktop identity. Upstream telemetry is disabled by default.

## Use the platform

- [Cockpit, model roles, tools, knowledge and AgentMail](docs/user/synthos.md)
- [Fieldy, Harness and G2 companion setup](docs/user/synthos-devices.md)
- [Always-on Linux service from this checkout](scripts/synthos-service/README.md)
- [T3 workspace and provider documentation](docs/README.md)

Workflows use configured provider IDs, frozen GCH task packets, persistent budgets, candidate checkpoints and explicit human decisions. Model availability and tool installation remain separate from authentication and observed activity. The supply deck includes the original 41 tools; terminal handoffs use the existing T3 terminal.

## Qualification boundaries

A prepared workflow does not start a provider call. Starting it can consume a subscription or API allowance. Missing usage or authoritative check receipts holds the workflow. Native provider APIs do not provide a universal hard spend cap or physically read-only role sandbox. Production publishing and automatic merge are not enabled by approving a local evidence package.

Connection adapters and companion transports require the intended credentials and hardware for live qualification. The browser cockpit also serves phone-sized screens; a customized native mobile release is not included. No account credentials or production device pairing are bundled.

## Provenance

GCH source is pinned to [Synthminds/GCH at a11ebfb](https://github.com/Synthminds/GCH/tree/a11ebfb89bbc7fcf9cb47df54454b66412ddeedc). The policy snapshot retains the canonical rules 1.9 text, source hashes for prior editions, and the 3.0 factory lineage. Workers receive the current kernel, not a concatenation of conflicting historical rules. Host limits and current human instructions retain precedence.

T3 Code remains the upstream foundation at commit `9e09926d97824179d97311d1a810c6b5bb60d2d1`. Its [MIT license](LICENSE) and third-party notices remain intact. The [upstream README](https://github.com/pingdotgg/t3code/blob/9e09926d97824179d97311d1a810c6b5bb60d2d1/README.md) describes the original product and its public releases.
