# godot-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP
client) work on **Godot 4** projects: it edits `.tscn` scenes and `.gd` scripts
directly on disk, runs the project headlessly to catch errors, and can
optionally drive a *running* Godot editor over a local WebSocket bridge.

- **File tools** need no Godot install and no setup beyond building the server.
- **Live-editor tools** (play/stop a scene, read the selection) need the small
  companion plugin enabled in an open editor.

```
godot-mcp/
├── src/                  # the MCP server (TypeScript)
│   ├── index.ts          # tool definitions
│   ├── tscn.ts           # .tscn parser/serializer (no Godot needed to use it)
│   └── bridge.ts         # WebSocket client for the live editor bridge
├── sample-project/       # a working Godot 4 project to try the tools on
│   ├── scenes/Main.tscn
│   ├── scripts/player.gd
│   └── addons/godot_mcp_bridge/   # the live-bridge EditorPlugin
└── test/                 # `npm test`
```

## Contents

- [Quick start](#quick-start)
- [Usage guide](#usage-guide)
- [Tool reference](#tool-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Development](#development)

## Quick start

Requires **Node.js 18+**.

```bash
git clone https://github.com/YasiruRF/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Register the built server with your MCP client. Use the **absolute path** to
`dist/index.js`.

**Claude Code**

```bash
claude mcp add godot -- node /absolute/path/to/godot-mcp/dist/index.js
```

On Windows use a Windows path, e.g. `node C:\dev\godot-mcp\dist\index.js`.

Or add it by hand to a project's `.mcp.json`:

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

**Claude Desktop** — add the same `mcpServers` entry to
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`), then restart the app. In JSON on Windows,
escape backslashes: `"C:\\dev\\godot-mcp\\dist\\index.js"`.

Then ask Claude something like *"List everything in the Godot project at
`/path/to/my-game`"*. If it returns your scenes and scripts, you're set.

## Usage guide

### 1. Point the tools at a project

Every file tool takes a `project_path`: the **absolute path to the folder that
contains `project.godot`**. Tools refuse to run if that file isn't there, and
they refuse to read or write anything outside the folder.

Other paths (`scene_path`, `script_path`, ...) can be given relative to the
project (`scenes/Main.tscn`), as `res://` paths (`res://scenes/Main.tscn`), or
as absolute paths inside the project. Tip for your prompts: tell Claude the
project path once ("my project is at `D:\games\platformer`") and it will reuse it.

To try things out without risking your own work, use the bundled
`sample-project/` (or a copy of it).

### 2. Build and edit scenes

Scenes are addressed by **node path**: `.` is the scene root, `Player` is a
child of the root, `Player/Sprite2D` is a child of `Player`.

Example conversation:

> **You:** In `scenes/Main.tscn`, add an `Area2D` called `Coin` under the root
> with a `CollisionShape2D` child, and put the coin at (400, 260).

Claude will call, in order:

| Call | Arguments |
|---|---|
| `add_node` | `scene_path: "scenes/Main.tscn"`, `parent_path: "."`, `name: "Coin"`, `type: "Area2D"` |
| `add_node` | `parent_path: "Coin"`, `name: "CollisionShape2D"`, `type: "CollisionShape2D"` |
| `set_node_properties` | `node_path: "Coin"`, `properties: { "position": "Vector2(400, 260)" }` |

Property values are **raw Godot text**, exactly as they appear in a `.tscn`
file: `Vector2(10, 20)`, `Color(1, 0, 0, 1)`, `false`, `"a string"` (with the
quotes), `ExtResource("1_abcde")`. They are not validated, so a wrong value is
only caught when Godot loads the scene — use `run_headless` (below) after edits.

To attach a script when adding a node, pass `script_path`
(`"script_path": "scripts/coin.gd"`). The server registers the script in the
scene for you.

To start a scene from scratch, use `create_scene` first (it won't overwrite an
existing file unless you pass `overwrite: true`), then `add_node`.

> Godot's editor keeps scenes in memory. If a scene is open in the editor while
> Claude edits it on disk, Godot will offer to reload it — accept, and don't
> save the stale version over the top.

### 3. Read and edit scripts

- `read_script` returns a `.gd` file.
- `write_script` creates or **fully overwrites** a file.
- `edit_script` is a targeted find-and-replace: `old_text` must match **exactly
  once**, otherwise the call fails and nothing is changed (so include enough
  surrounding lines to make it unique).

> **You:** Open `scripts/player.gd` and add a double-jump.

### 4. Check that it actually works: `run_headless`

`run_headless` launches Godot with `--headless` on your project (or one scene),
lets it run for `timeout_ms` (default 5000), and returns everything it printed,
followed by an exit status line such as `[exit code 0]` or
`[stopped by SIGTERM after the 5000ms timeout]`. Parse errors, missing
resources and runtime errors show up in the output, which makes it a good
follow-up to any edit: *"Make that change, then run the project headlessly and
tell me if there are errors."*

It needs a Godot 4 executable. If it isn't on your `PATH` as `godot4`, set
`GODOT_BIN` (see [Configuration](#configuration)).

### 5. (Optional) Drive the live editor

The `editor_*` tools talk to a running Godot editor through a tiny plugin.

1. Copy `sample-project/addons/godot_mcp_bridge/` into your project's `addons/`
   folder (or just open `sample-project/` in Godot).
2. In Godot: **Project → Project Settings → Plugins → enable "Godot MCP Bridge"**.
3. The Output panel should print
   `godot_mcp_bridge: listening on ws://127.0.0.1:9080`.
4. Ask Claude to `editor_ping`. A reply of `{"ok":true,"result":{"status":"alive",...}}`
   means the bridge is up.

From then on Claude can start and stop scenes (`editor_run_scene` with a
`res://` path, `editor_stop`) and see what you have selected in the editor
(`editor_get_selection`) — e.g. *"Run Main.tscn, and tell me which node I have
selected."*

The bridge needs a recent Godot 4 (it uses the `EditorInterface` singleton and
`WebSocketPeer.accept_stream`; **Godot 4.2 or newer** is recommended). The
sample project targets 4.3.

## Tool reference

### File tools (always available)

| Tool | Arguments | Purpose |
|---|---|---|
| `list_project` | `project_path` | Lists scenes (`.tscn`), scripts (`.gd`) and resources (`.tres`/`.res`), as project-relative paths |
| `read_scene` | `project_path`, `scene_path` | Parses a `.tscn` into a JSON list of nodes (`name`, `type`, `parent`, `path`, `instance`, `properties`) |
| `create_scene` | `project_path`, `scene_path`, `root_name`, `root_type`, `overwrite?` | Creates a new scene with one root node |
| `add_node` | `project_path`, `scene_path`, `parent_path`, `name`, `type`, `properties?`, `script_path?` | Adds a child node (use `"."` as the parent for the root) |
| `remove_node` | `project_path`, `scene_path`, `node_path` | Removes a node, its descendants, and any signal connections pointing at them. The root can't be removed |
| `set_node_properties` | `project_path`, `scene_path`, `node_path`, `properties` | Sets or overwrites raw properties on a node |
| `write_script` | `project_path`, `script_path`, `content` | Creates or overwrites a script |
| `read_script` | `project_path`, `script_path` | Reads a script |
| `edit_script` | `project_path`, `script_path`, `old_text`, `new_text` | Replaces exactly one occurrence of `old_text` |
| `run_headless` | `project_path`, `scene_path?`, `timeout_ms?` | Runs the project headlessly and returns its output and exit status |

Node names may not contain `. / : @ " %` or backslashes, and node types must be
plain class names such as `Sprite2D` (both are Godot rules).

### Live editor bridge (needs the plugin enabled in a running editor)

| Tool | Arguments | Purpose |
|---|---|---|
| `editor_ping` | — | Checks the bridge is reachable |
| `editor_run_scene` | `scene_path` (`res://...`) | Presses "Play Scene" on that scene |
| `editor_stop` | — | Stops the running scene |
| `editor_get_selection` | — | Returns the node path(s) currently selected in the editor |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GODOT_BIN` | `godot4` | Godot 4 executable used by `run_headless` |
| `GODOT_MCP_BRIDGE_URL` | `ws://127.0.0.1:9080` | Where the `editor_*` tools look for the bridge |

Set them in your MCP client config, for example:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"],
      "env": { "GODOT_BIN": "C:\\Godot\\Godot_v4.3-stable_win64_console.exe" }
    }
  }
}
```

On Windows, prefer the `_console.exe` build of Godot for `run_headless` — it
attaches stdout/stderr so errors show up in the output.

The bridge's port is fixed at `9080` in
`sample-project/addons/godot_mcp_bridge/godot_mcp_bridge.gd` (`PORT`); if you
change it there, change `GODOT_MCP_BRIDGE_URL` to match.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No project.godot found in "..."` | `project_path` must be the folder that *contains* `project.godot`, as an absolute path |
| `Refusing to access a path outside the project folder` | A `scene_path`/`script_path` resolved outside `project_path` (for example via `..`). Use a path inside the project |
| `Could not launch "godot4": spawn godot4 ENOENT` | Godot isn't on `PATH` under that name. Set `GODOT_BIN` to the executable |
| `run_headless` output is empty on Windows | Use the `_console.exe` Godot build |
| `Could not reach the Godot editor bridge ... ECONNREFUSED` | Godot isn't open, or the plugin isn't enabled (Project Settings → Plugins). File tools still work without it |
| Plugin logs `failed to listen on 127.0.0.1:9080` | Another Godot editor (or program) already holds the port — close it |
| `old_text matched N times; make it unique` | Add more surrounding lines to `old_text` in `edit_script` |
| Edits don't show in the open editor | Godot caches open scenes; accept its "reload from disk" prompt |
| Claude can't see the tools | Check the path in your MCP config is absolute and points at `dist/index.js`, that you ran `npm run build`, and restart the client |

## How it works

Godot doesn't expose an API for external processes to control it, so the
project splits into two independent halves:

- **File-based tools.** `.tscn` and `.gd` files are plain text. The server
  parses and writes them directly, so these tools work with *zero* Godot-side
  setup — you don't even need Godot installed, except for `run_headless`. The
  `.tscn` handling is conservative: it edits the blocks it needs and keeps
  everything else in the file verbatim, so an edit produces a small diff and an
  untouched scene round-trips byte for byte.
- **Live editor bridge.** A small `EditorPlugin`
  (`sample-project/addons/godot_mcp_bridge/`) runs inside the Godot editor and
  opens `ws://127.0.0.1:9080`. The `editor_*` tools connect to it, send one JSON
  command (`{"id", "command", "args"}`) and read one JSON reply
  (`{"id", "ok", "result", "error"}`).

## Known limitations

- The `.tscn` parser handles nodes, ext/sub resources and single-line
  properties. Properties whose values span several lines (some dictionaries and
  arrays) are preserved when untouched, but `read_scene` only shows their first
  line and `set_node_properties` can't replace them reliably. Do those edits in
  the Godot editor.
- Property values and node types are not validated against Godot's class
  database — run `run_headless` after edits.
- `run_headless` and the live bridge need a local Godot install; the other
  tools don't.
- The live bridge has no authentication. It binds to `127.0.0.1` only, so it's
  local to your machine — don't expose that port on a shared or public host.
- The live bridge (the GDScript plugin) and `run_headless` are exercised in
  the test suite only against stand-ins (a mock WebSocket server and a fake
  binary), not against a real Godot editor.

## Development

```bash
npm install
npm test        # builds, then runs the test suite (no Godot required)
npm run dev     # tsc in watch mode
```

The tests cover the `.tscn` round-trip and edit operations, drive the built
server over the real MCP stdio protocol against a scratch copy of
`sample-project/`, and check the bridge client against a mock of the plugin's
WebSocket protocol.

Ideas for later: `instance_scene` (instance one `.tscn` in another),
`editor_call_method`, signal connection editing, export-preset management.
