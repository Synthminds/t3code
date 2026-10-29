# Connect the Claude–Obsidian memory bridge

SynthOS captures reviewed mission notes through its Obsidian adapter. Claude can read and search the same notes through the user's [obsidian-second-brain fork](https://github.com/Synthminds/obsidian-second-brain). Both must point at the same vault on the host running them. This does not require a second orchestration server or paid inference for lexical search and note operations.

The qualified source is commit `fe84aa94ea75a46a213d94304fe9f0501c18f109` (MIT, plugin version `0.17.0`), with Python 3.12 and `mcp==1.30.0`. The bridge exposes twelve stdio tools, including capture, read, search, and validation. This setup uses its MCP server without installing background-agent hooks.

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
