# godot-mcp

An MCP server for working with Godot 4 projects from Claude Code: it edits
`.tscn` scenes and `.gd` scripts on disk (Phase 1), and can optionally
control a *running* Godot editor over a local WebSocket bridge (Phase 2).

```
godot-mcp/
├── src/                  # the MCP server (TypeScript)
│   ├── index.ts          # tool definitions
│   ├── tscn.ts           # .tscn parser/serializer (no Godot needed to use it)
│   └── bridge.ts         # WebSocket client for the live editor bridge
├── sample-project/       # a working Godot 4 project to try the tools on
│   ├── scenes/Main.tscn
│   ├── scripts/player.gd
│   └── addons/godot_mcp_bridge/   # the Phase 2 EditorPlugin
└── package.json
```

## How it works

Godot doesn't expose an API for external processes to control it, so this
splits into two independent halves:

- **Phase 1 — file-based tools.** `.tscn` and `.gd` files are plain text.
  The server parses/writes them directly, so these tools work with *zero*
  Godot-side setup — you don't even need Godot installed, except for
  `run_headless`, which shells out to the `godot4` binary to catch script
  errors.
- **Phase 2 — live editor bridge.** A small `EditorPlugin`
  (`sample-project/addons/godot_mcp_bridge/`) runs inside the Godot editor
  and opens `ws://127.0.0.1:9080`. The MCP server's `editor_*` tools connect
  to it to play/stop scenes and read the current selection. This only works
  while the Godot editor is open with the plugin enabled — file tools don't
  need it at all.

## Setup

### 1. Build the server

```bash
cd godot-mcp
npm install
npm run build
```

### 2. Register it with Claude Code

```bash
claude mcp add godot -- node /absolute/path/to/godot-mcp/dist/index.js
```

Or add it by hand to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"]
    }
  }
}
```

Every file tool takes a `project_path` argument — point it at
`sample-project/` to try things out, or at your own Godot project folder.

### 3. (Optional) Enable the live bridge

Copy `sample-project/addons/godot_mcp_bridge/` into your own project's
`addons/` folder (or just open `sample-project/` in Godot), then:

**Project > Project Settings > Plugins** → enable **Godot MCP Bridge**.

You should see `godot_mcp_bridge: listening on ws://127.0.0.1:9080` in the
Godot output panel. Requires Godot **4.1+** (uses
`WebSocketPeer.accept_stream`).

### 4. (Optional) `run_headless`

Set `GODOT_BIN` to your Godot 4 executable if it's not on PATH as `godot4`:

```bash
export GODOT_BIN=/path/to/Godot_v4.3-stable_linux.x86_64
```

## Tools

**File-based (always available):**

| Tool | Purpose |
|---|---|
| `list_project` | Lists scenes/scripts/resources under `project_path` |
| `read_scene` | Parses a `.tscn` into a JSON node tree |
| `create_scene` | Creates a new `.tscn` with one root node |
| `add_node` | Adds a child node (optionally attaching a script) |
| `remove_node` | Removes a node and its descendants |
| `set_node_properties` | Sets raw properties on a node (e.g. `position`) |
| `write_script` / `read_script` | Create/read a `.gd` file |
| `edit_script` | Find-and-replace patch on a `.gd` file |
| `run_headless` | Runs the project (or one scene) headlessly to surface errors |

**Live editor bridge (needs the plugin enabled in a running editor):**

| Tool | Purpose |
|---|---|
| `editor_ping` | Checks the bridge is reachable |
| `editor_run_scene` | Presses "Play Scene" on a given `.tscn` |
| `editor_stop` | Stops the running scene |
| `editor_get_selection` | Returns the currently selected node(s) |

## Try it

With the server registered in Claude Code and pointed at `sample-project/`:

- "List everything in the sample Godot project."
- "Read Main.tscn and show me the node tree."
- "Add an Area2D called Coin under the root, with a CollisionShape2D child."
- "Open scripts/player.gd and add a double-jump."

## Known limitations

- The `.tscn` parser handles the common cases (nodes, ext/sub resources,
  flat property assignments) but doesn't understand every resource type
  Godot can embed — extremely exotic scenes (custom `PackedScene` binary
  blobs, multi-line array/dictionary properties) may round-trip oddly.
  It's tested against real Godot 4 output for typical scenes.
- `run_headless` and the live bridge both require a local Godot install;
  file tools alone do not.
- The live bridge has no auth — it only binds to `127.0.0.1`, so it's local
  to your own machine, but don't run it on a shared or exposed host.

## Roadmap ideas

- `instance_scene` — instance one `.tscn` inside another
- `editor_call_method` — call a method on a live node and return its result
- Signal connection editing (`connect_signal` / `disconnect_signal`)
- Import/export preset management for one-command builds
