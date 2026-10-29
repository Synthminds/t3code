# Connect the Claude–Obsidian memory bridge

SynthOS captures reviewed mission notes through its Obsidian adapter. Claude can read and search the same notes through the user's [obsidian-second-brain fork](https://github.com/Synthminds/obsidian-second-brain). Both must point at the same vault on the host running them. This does not require a second orchestration server or paid inference for lexical search and note operations.

The qualified source is commit `fe84aa94ea75a46a213d94304fe9f0501c18f109` (MIT, plugin version `0.17.0`), with Python 3.12 and `mcp==1.30.0`. The bridge exposes twelve stdio tools, including capture, read, search, and validation. This setup uses its MCP server without installing background-agent hooks.

SynthOS automatic recall uses the host's own vault adapter and project context settings; it does not need a running second-brain MCP process. Configure approved project paths and allowed neighborhoods in the [Context Deck](../user/synthos.md#supply-focused-context). Claude's MCP connection can read the same vault, but its independent tool calls do not automatically appear in a SynthOS context manifest. Use a synthetic vault to qualify recall before enabling the user's project paths.

## Install on the Mac

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then use a dedicated tools directory:

```sh
tools_dir="$HOME/.local/share/synthos-tools"
mkdir -p "$tools_dir"
git clone https://github.com/Synthminds/obsidian-second-brain "$tools_dir/obsidian-second-brain"
git -C "$tools_dir/obsidian-second-brain" checkout --detach fe84aa94ea75a46a213d94304fe9f0501c18f109
uv venv --python 3.12 "$tools_dir/obsidian-mcp-venv"
uv pip install --python "$tools_dir/obsidian-mcp-venv/bin/python" 'mcp==1.30.0'
```

Use the existing checkout and environment if they are already installed; inspect their versions before updating them. Do not install a vault template over an existing vault.

## Use one vault

Set `SYNTHOS_OBSIDIAN_VAULT_ROOT` to the absolute vault directory in the environment that launches the SynthOS server or desktop app. A desktop app launched from Finder does not automatically inherit variables exported in a terminal. For an unsigned source build, launch the packaged executable from the configured shell; use the actual app name and vault path:

```sh
export SYNTHOS_OBSIDIAN_VAULT_ROOT="/Users/YOU/Documents/YOUR_VAULT"
"/Applications/SynthOS (Beta).app/Contents/MacOS/SynthOS (Beta)"
```

For Claude, merge a stdio MCP entry into the project's `.mcp.json`, preserving unrelated entries and replacing the absolute paths:

```json
{
  "mcpServers": {
    "synthos_obsidian": {
      "command": "/Users/YOU/.local/share/synthos-tools/obsidian-mcp-venv/bin/python",
      "args": [
        "/Users/YOU/.local/share/synthos-tools/obsidian-second-brain/integrations/obsidian-mcp-server/server.py"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/YOU/Documents/YOUR_VAULT",
        "OBSIDIAN_BG_AGENT_ENABLED": "0",
        "OBSIDIAN_SEARCH_SEMANTIC": "0",
        "OBSIDIAN_POST_WRITE_CMD": ""
      }
    }
  }
}
```

Keep tool approvals enabled for the bridge's write operations. They use the bridge's own semantics; they do not inherit SynthOS's preview approval or expected-version checks. The disabled background hook can otherwise launch unattended writing, and post-write commands can run arbitrary configured commands. Neither is needed for reviewed capture.

Start a new Claude session and confirm the MCP tools are available. Save a synthetic note from **SynthOS → Decisions → Memory cassette**, then ask Claude to read its exact vault-relative path. Verify the content and source references before using the connection for durable project knowledge. Existing notes require reading the current version before replacement in SynthOS; a conflict retains the draft for review.

The full second-brain plugin additionally offers `/obsidian-save`, `/obsidian-find`, and lifecycle hooks. Use its [installation guide](https://github.com/Synthminds/obsidian-second-brain/tree/fe84aa94ea75a46a213d94304fe9f0501c18f109) if those are desired after this shared-vault path is qualified. Installing Claude-Mem as another observer is a separate choice; this integration does not install it or enable automatic transcript capture.

## Federated graph snapshots

In **SynthOS → Knowledge**, select a project, open **Project graph sources and recall**, enable Synthome, then search and refresh. Refresh imports a bounded public MCP snapshot. It replaces that project's previous Synthome snapshot; pins outside the replacement block future dispatch until removed or refreshed back into scope. The source revision and partial-coverage warning stay visible. Neither centrality nor similarity establishes factual reliability.

For SynthBrain, approve vault folders before enabling the source. Import the JSON `{ nodes, links }` export produced by its graph command. The adapter filters out unapproved paths and relationships before persistence. The basic export contains titles and similarity relationships, not note bodies; Obsidian recall supplies approved note text separately. A normalized `SynthosGraphSnapshot` can also be imported through the CLI for typed relationships with provenance. No import writes to the vault or source repository.

Use `gch synthos graph request.json` for `settings`, `configure`, `refresh`, `import_brain`, `import`, `explore`, `align`, `unalign`, `history`, and `select`. Requests include `projectId`; mutations require the current `expectedVersion` (configuration uses `settings.version`). Alignment assertions require manual provenance, an explicit rationale, and `reviewed: true`; they preserve both original identities. `same_as`, `relates_to`, and `supersedes` never automatically replace or merge sources. Supply `workflowId` on `select` for a mission-only selection. Pins and automatic recall are project settings affecting future attempts, not already frozen packets.

The optional synthmind process bridge requires a clean checkout at `3e3ca9e039d3015d2dbdcd76ee4d3e5d61287b07`, Node `22.23.1`, and these host environment variables:

```sh
export SYNTHMIND_ROOT=/absolute/path/to/synthmind
export SYNTHMIND_NODE=/absolute/path/to/node-22.23.1
```

Restart the T3 host after setting them. The bridge verifies the checkout and runtime before using synthmind's federation, neighborhood, and path functions over the bounded, approved projection. Without this configuration, the built-in deterministic explorer remains available. A configured but invalid engine returns an error rather than silently switching engines. Node 26 library embedding is not qualified.

Graph recall shares the existing five-source/4 KiB supplemental memory allowance. A required selection that is unavailable or exceeds the allowance blocks dispatch. Optional evidence may be omitted; inspect the Context Deck for the actual packet. Refreshing or reconfiguring a graph changes its revision and invalidates a pending packet before launch.

On hosts using an HTTP proxy, enable Node’s standard proxy support (`NODE_USE_ENV_PROXY=1`) before starting T3. Do not remove proxy or CA configuration.
