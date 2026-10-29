# Find the relevant boundaries

Read `AGENTS.md`, choose the matching routes below, then read their `load` documents before editing. Multiple routes can apply. `paths` identifies starting areas; `skip` is an initial search optimization, never a restriction on investigating a dependency. Follow imports, contracts, and observed evidence beyond a route when needed.

The versioned block is also consumed by SynthOS context routing. Keep it as the single route definition. Rules remain in the linked authoritative documents; this map does not grant permissions or replace GCH policy.

```json
{
  "version": 1,
  "routes": [
    {
      "id": "orchestration",
      "keywords": [
        "gch",
        "mission",
        "workflow",
        "orchestration",
        "dispatch",
        "packet",
        "handoff",
        "context"
      ],
      "roles": ["architect", "pm", "router", "crew", "lead", "reviewer", "advisor"],
      "paths": ["apps/server/src/synthos", "apps/server/src/orchestration-v2"],
      "load": [
        "apps/server/src/synthos/CONTEXT.md",
        "docs/internals/overview.md",
        "docs/internals/context-handoffs.md"
      ],
      "skip": ["apps/marketing"]
    },
    {
      "id": "providers",
      "keywords": ["provider", "codex", "claude", "opencode", "model", "usage", "token"],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs"],
      "paths": ["apps/server/src", "packages/provider-core"],
      "load": ["docs/internals/providers.md", "docs/internals/adding-a-provider.md"],
      "skip": ["apps/marketing"]
    },
    {
      "id": "ui",
      "keywords": ["ui", "theme", "cockpit", "dashboard", "deck", "scene", "react", "synthwave"],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs"],
      "paths": [
        "apps/web/src/components/synthos",
        "packages/client-runtime",
        "packages/shared/src/themePalettes.ts"
      ],
      "load": ["docs/internals/web-ui.md"],
      "skip": ["apps/marketing", "apps/server/src/device"]
    },
    {
      "id": "contracts",
      "keywords": ["contract", "schema", "rpc", "permission", "transport", "api"],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs"],
      "paths": ["packages/contracts", "packages/client-runtime"],
      "load": ["docs/internals/overview.md", "docs/internals/effect-services.md"],
      "skip": ["apps/marketing"]
    },
    {
      "id": "devices",
      "keywords": ["device", "harness", "glasses", "fieldy", "g2", "ssh", "pairing"],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs"],
      "paths": ["apps/server/src/device", "apps/web/src/components/synthos/SynthosDevices.tsx"],
      "load": ["docs/internals/devices.md", "docs/user/synthos-devices.md"],
      "skip": ["apps/marketing"]
    },
    {
      "id": "memory",
      "keywords": [
        "memory",
        "obsidian",
        "vault",
        "recall",
        "knowledge",
        "neighborhood",
        "context",
        "graph",
        "synthome",
        "synthbrain",
        "synthmind"
      ],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs", "router"],
      "paths": [
        "apps/server/src/synthos-connections",
        "apps/server/src/synthos-knowledge",
        "apps/server/src/synthos-context",
        "apps/server/src/synthos-graph"
      ],
      "load": [
        "apps/server/src/synthos-connections/CONTEXT.md",
        "docs/operations/synthos-memory.md"
      ],
      "skip": ["apps/marketing", "apps/server/src/device"]
    },
    {
      "id": "desktop",
      "keywords": ["desktop", "electron", "macos", "installer", "packaging", "dmg", "signing"],
      "roles": ["architect", "crew", "lead", "reviewer", "search", "grep", "docs"],
      "paths": ["apps/desktop", ".github/workflows/synthos-macos.yml"],
      "load": ["docs/operations/synthos-desktop.md"],
      "skip": ["apps/mobile", "apps/marketing"]
    }
  ]
}
```

For work spanning routes, inspect each affected client and provider as required by `AGENTS.md`. If no route fits, use normal repository search and record relevant boundaries in the task handoff. Update a route when its ownership or authoritative guidance changes; do not turn it into a file catalog.
