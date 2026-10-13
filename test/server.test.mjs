import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "dist", "index.js");

let tmp;
let proj;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-test-"));
  proj = path.join(tmp, "proj");
  fs.cpSync(path.join(root, "sample-project"), proj, { recursive: true });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Starts the built server over stdio, runs `fn(call)`, and shuts it down. */
async function withServer(env, fn) {
  const client = new Client({ name: "test", version: "0.0.0" });
  // default to a dead bridge port so a real Godot editor on this machine can't affect the tests
  const fullEnv = { GODOT_MCP_BRIDGE_URL: "ws://127.0.0.1:9", ...env };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], env: fullEnv }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content[0].text };
  };
  try {
    return await fn(call, client);
  } finally {
    await client.close();
  }
}

test("exposes all 24 tools", async () => {
  await withServer({}, async (_call, client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "add_node", "allow_paths", "begin_task", "create_scene", "edit_script",
        "editor_add_node", "editor_get_scene_tree", "editor_get_selection", "editor_open_scene",
        "editor_ping", "editor_remove_node", "editor_run_scene", "editor_save_scene",
        "editor_set_properties", "editor_stop", "end_task", "get_change_summary",
        "list_project", "read_scene", "read_script", "remove_node", "run_headless",
        "set_node_properties", "write_script",
      ]
    );
  });
});

test("file tools: list, read, create, add, edit, remove", async () => {
  await withServer({}, async (call) => {
    const listing = JSON.parse((await call("list_project", { project_path: proj })).text);
    assert.deepEqual(listing.scenes, ["scenes/Main.tscn"]);
    assert.ok(listing.scripts.includes("scripts/player.gd"));

    const tree = JSON.parse((await call("read_scene", { project_path: proj, scene_path: "scenes/Main.tscn" })).text);
    const paths = tree.map((n) => n.path);
    for (const expected of [".", "Player", "Player/CollisionShape3D", "Floor", "Goal", "CameraRig/Pivot/SpringArm3D/Camera3D", "HUD/Label"]) {
      assert.ok(paths.includes(expected), `sample scene should contain ${expected}`);
    }
    assert.equal(tree.find((n) => n.path === "Player").type, "RigidBody3D");

    assert.equal((await call("create_scene", { project_path: proj, scene_path: "scenes/Coin.tscn", root_name: "Coin", root_type: "Area2D" })).isError, false);
    assert.equal((await call("create_scene", { project_path: proj, scene_path: "scenes/Coin.tscn", root_name: "Coin", root_type: "Area2D" })).isError, true);

    const add = { project_path: proj, scene_path: "scenes/Main.tscn", parent_path: ".", type: "Node2D", script_path: "scripts/player.gd" };
    assert.equal((await call("add_node", { ...add, name: "EnemyA" })).isError, false);
    assert.equal((await call("add_node", { ...add, name: "EnemyB" })).isError, false);
    assert.equal((await call("set_node_properties", { project_path: proj, scene_path: "scenes/Main.tscn", node_path: "EnemyA", properties: { position: "Vector2(3, 4)" } })).isError, false);

    const main = fs.readFileSync(path.join(proj, "scenes/Main.tscn"), "utf8");
    // script_path always becomes a forward-slash res:// path and is registered once
    assert.equal(main.match(/path="res:\/\/scripts\/player\.gd"/g).length, 1);
    assert.doesNotMatch(main, /\\/);
    assert.match(main, /\[node name="EnemyA" type="Node2D" parent="\."\]\nscript = ExtResource\("1_abcde"\)\nposition = Vector2\(3, 4\)/);

    assert.equal((await call("remove_node", { project_path: proj, scene_path: "scenes/Main.tscn", node_path: "EnemyA" })).isError, false);
    assert.doesNotMatch(fs.readFileSync(path.join(proj, "scenes/Main.tscn"), "utf8"), /EnemyA/);
  });
});

test("script tools: write, read, edit (literally), res:// paths", async () => {
  await withServer({}, async (call) => {
    await call("write_script", { project_path: proj, script_path: "scripts/new.gd", content: 'extends Node\nvar n = "a"\n' });
    assert.equal((await call("read_script", { project_path: proj, script_path: "res://scripts/new.gd" })).text, 'extends Node\nvar n = "a"\n');

    // `$&` and `$'` are String.replace patterns; GDScript uses `$Node` syntax, so they must stay literal
    await call("edit_script", { project_path: proj, script_path: "scripts/new.gd", old_text: '"a"', new_text: "$Player.position $& $'" });
    assert.equal(fs.readFileSync(path.join(proj, "scripts/new.gd"), "utf8"), "extends Node\nvar n = $Player.position $& $'\n");

    assert.equal((await call("edit_script", { project_path: proj, script_path: "scripts/new.gd", old_text: "nope", new_text: "x" })).isError, true);
    assert.equal((await call("edit_script", { project_path: proj, script_path: "scripts/new.gd", old_text: "e", new_text: "x" })).isError, true); // ambiguous
  });
});

test("refuses paths outside the project, including sibling folders with a shared prefix", async () => {
  const sibling = proj + "-evil";
  fs.mkdirSync(sibling, { recursive: true });
  await withServer({}, async (call) => {
    for (const script_path of ["../evil.gd", path.join(sibling, "x.gd"), path.join(tmp, "evil.gd")]) {
      const res = await call("write_script", { project_path: proj, script_path, content: "x" });
      assert.equal(res.isError, true, script_path);
      assert.match(res.text, /outside the project/);
    }
    assert.equal(fs.existsSync(path.join(sibling, "x.gd")), false);
    assert.equal(fs.existsSync(path.join(tmp, "evil.gd")), false);
  });
});

test("rejects a project_path that is not a Godot project", async () => {
  await withServer({}, async (call) => {
    const res = await call("write_script", { project_path: tmp, script_path: "x.gd", content: "x" });
    assert.equal(res.isError, true);
    assert.match(res.text, /project\.godot/);
    assert.equal(fs.existsSync(path.join(tmp, "x.gd")), false);
  });
});

test("run_headless reports a missing Godot binary clearly", async () => {
  await withServer({ GODOT_BIN: path.join(tmp, "no-such-godot") }, async (call) => {
    const res = await call("run_headless", { project_path: proj });
    assert.equal(res.isError, true);
    assert.match(res.text, /Could not launch/);
    assert.match(res.text, /GODOT_BIN/);
  });
});

test("run_headless returns output and exit status (node stands in for Godot)", async () => {
  await withServer({ GODOT_BIN: process.execPath }, async (call) => {
    // node rejects the --headless flag and exits non-zero, like a Godot that failed to start
    const res = await call("run_headless", { project_path: proj });
    assert.equal(res.isError, false);
    assert.match(res.text, /\[exit code [1-9]\d*\]$/);
  });
});

test("editor_* tools fail fast with a helpful message when Godot isn't running", async () => {
  // port 9 (discard) is never listening
  await withServer({ GODOT_MCP_BRIDGE_URL: "ws://127.0.0.1:9" }, async (call) => {
    const res = await call("editor_ping");
    assert.equal(res.isError, true);
    assert.match(res.text, /Could not reach the Godot editor bridge/);
  });
});

/**
 * Runs `fn(call, seen)` against a server whose editor bridge is a mock WebSocket server.
 * `handler(msg)` returns the `result` (or `{ error }` to fail); `seen` collects the received messages.
 */
async function withMockBridge(handler, fn) {
  const seen = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.on("listening", resolve));
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      const out = handler(msg) ?? {};
      const reply = out.error
        ? { id: msg.id, ok: false, result: null, error: out.error }
        : { id: msg.id, ok: true, result: out, error: null };
      ws.send(JSON.stringify(reply));
    });
  });
  try {
    const url = `ws://127.0.0.1:${wss.address().port}`;
    await withServer({ GODOT_MCP_BRIDGE_URL: url }, (call) => fn(call, seen));
  } finally {
    wss.close();
  }
}

test("editor_* tools speak the bridge protocol", async () => {
  const handler = (msg) =>
    ({
      ping: { status: "alive" },
      run_scene: { playing: msg.args?.scene_path },
      stop: { stopped: true },
      get_selection: { selected: ["/root/Main/Player"] },
    })[msg.command];

  await withMockBridge(handler, async (call, seen) => {
    assert.match((await call("editor_ping")).text, /alive/);
    assert.match((await call("editor_run_scene", { scene_path: "res://scenes/Main.tscn" })).text, /res:\/\/scenes\/Main\.tscn/);
    assert.match((await call("editor_stop")).text, /stopped/);
    assert.match((await call("editor_get_selection")).text, /Player/);
    assert.deepEqual(seen.map((m) => m.command), ["ping", "run_scene", "stop", "get_selection"]);
    assert.deepEqual(seen[1].args, { scene_path: "res://scenes/Main.tscn" });
  });
});

test("live-edit tools send the right commands and arguments", async () => {
  await withMockBridge(() => ({ ok: "fine" }), async (call, seen) => {
    await call("editor_get_scene_tree");
    await call("editor_open_scene", { scene_path: "scenes/Main.tscn" });
    await call("editor_add_node", {
      parent_path: ".", name: "Coin", type: "Area2D",
      properties: { position: "Vector2(10, 20)", shape: "RectangleShape2D.new()" },
    });
    await call("editor_set_properties", { node_path: "Coin", properties: { visible: "false" }, scene_path: "res://scenes/Main.tscn" });
    await call("editor_remove_node", { node_path: "Coin" });
    await call("editor_save_scene");

    assert.deepEqual(seen.map((m) => m.command), [
      "get_scene_tree", "open_scene", "add_node", "set_properties", "remove_node", "save_scene",
    ]);
    assert.deepEqual(seen[2].args, {
      parent_path: ".", name: "Coin", type: "Area2D",
      properties: { position: "Vector2(10, 20)", shape: "RectangleShape2D.new()" },
    });
    assert.deepEqual(seen[3].args, {
      node_path: "Coin", properties: { visible: "false" }, scene_path: "res://scenes/Main.tscn",
    });
  });
});

test("an error reported by the editor bridge becomes an isError result", async () => {
  await withMockBridge(() => ({ error: "parent node 'Nope' not found in the open scene" }), async (call) => {
    const res = await call("editor_add_node", { parent_path: "Nope", name: "X", type: "Node2D" });
    assert.equal(res.isError, true);
    assert.match(res.text, /parent node 'Nope' not found/);
  });
});

test("create_scene overwrite refuses a scene that is open in the editor", async () => {
  const scene = path.join(proj, "scenes/Guarded.tscn");
  fs.writeFileSync(scene, '[gd_scene format=3]\n\n[node name="G" type="Node2D"]\n');
  const before = fs.readFileSync(scene, "utf8");
  const state = { project_path: proj.replace(/\\/g, "/") + "/", open: ["res://scenes/Guarded.tscn"], current: "res://scenes/Guarded.tscn" };
  await withMockBridge((msg) => msg.command === "get_open_scenes" && state, async (call) => {
    const res = await call("create_scene", { project_path: proj, scene_path: "scenes/Guarded.tscn", root_name: "G", root_type: "Node2D", overwrite: true });
    assert.equal(res.isError, true);
    assert.match(res.text, /open in the Godot editor/);
    assert.equal(fs.readFileSync(scene, "utf8"), before);
  });
});

test("add/set/remove route themselves: live when the editor has the scene open, disk otherwise", async () => {
  const scene = path.join(proj, "scenes/Guarded.tscn");
  const other = path.join(proj, "scenes/Free.tscn");
  fs.writeFileSync(scene, '[gd_scene format=3]\n\n[node name="G" type="Node2D"]\n');
  fs.writeFileSync(other, '[gd_scene format=3]\n\n[node name="F" type="Node2D"]\n');
  const before = fs.readFileSync(scene, "utf8");
  const editorPath = proj.replace(/\\/g, "/") + "/";
  const state = (project_path, current = "res://scenes/Guarded.tscn") => ({ project_path, open: ["res://scenes/Guarded.tscn"], current });
  const add = (scene_path, extra = {}) => ({ project_path: proj, scene_path, parent_path: ".", name: "Child", type: "Node2D", ...extra });

  // scene open and active: live edits, file untouched, result says so
  await withMockBridge((msg) => msg.command === "get_open_scenes" && state(editorPath), async (call, seen) => {
    const a = await call("add_node", add("scenes/Guarded.tscn", { properties: { shape: "RectangleShape2D.new()" } }));
    assert.equal(a.isError, false);
    assert.match(a.text, /live in the Godot editor/);
    assert.match(a.text, /Ctrl\+Z/);
    assert.match((await call("set_node_properties", { project_path: proj, scene_path: "res://scenes/Guarded.tscn", node_path: ".", properties: { visible: "false" } })).text, /live in the Godot editor/);
    assert.match((await call("remove_node", { project_path: proj, scene_path: "scenes/Guarded.tscn", node_path: "Child" })).text, /live in the Godot editor/);
    assert.equal(fs.readFileSync(scene, "utf8"), before, "the file on disk must be untouched");

    const live = seen.filter((m) => m.command !== "get_open_scenes");
    assert.deepEqual(live.map((m) => m.command), ["add_node", "set_properties", "remove_node"]);
    assert.equal(live[0].args.scene_path, "res://scenes/Guarded.tscn");
    assert.equal(live[0].args.properties.shape, "RectangleShape2D.new()"); // GDScript syntax is fine live
    assert.deepEqual(live[1].args.properties, { visible: "false" });

    // a scene the editor does not have open is still edited on disk, and says so
    const d = await call("add_node", add("scenes/Free.tscn"));
    assert.equal(d.isError, false);
    assert.match(d.text, /on disk/);
    assert.match(fs.readFileSync(other, "utf8"), /name="Child"/);
  });

  // open in the editor but another tab is showing: it switches to the scene's tab first
  await withMockBridge((msg) => msg.command === "get_open_scenes" && state(editorPath, "res://scenes/Other.tscn"), async (call, seen) => {
    const res = await call("add_node", add("scenes/Guarded.tscn", { name: "Switched" }));
    assert.equal(res.isError, false);
    assert.match(res.text, /switching to that scene's tab/);
    assert.deepEqual(seen.map((m) => m.command), ["get_open_scenes", "open_scene", "add_node"]);
  });

  // the editor has a different project open: disk
  await withMockBridge((msg) => msg.command === "get_open_scenes" && state(path.join(tmp, "another-project")), async (call) => {
    assert.match((await call("add_node", add("scenes/Guarded.tscn", { name: "OnDisk" }))).text, /on disk/);
  });

  // an older plugin that doesn't know get_open_scenes: disk, no error
  await withMockBridge((msg) => msg.command === "get_open_scenes" && { error: "unknown command: get_open_scenes" }, async (call) => {
    assert.equal((await call("add_node", add("scenes/Guarded.tscn", { name: "OnDisk2" }))).isError, false);
  });

  // a failure from the live edit is reported, never retried on disk
  await withMockBridge((msg) => (msg.command === "get_open_scenes" ? state(editorPath) : { error: "parent node 'Nope' not found in the open scene" }), async (call) => {
    const res = await call("add_node", add("scenes/Guarded.tscn", { parent_path: "Nope", name: "Never" }));
    assert.equal(res.isError, true);
    assert.match(res.text, /parent node 'Nope' not found/);
    assert.doesNotMatch(fs.readFileSync(scene, "utf8"), /Never/);
  });
});

test("begin_task/end_task: one undo batch, a plain-language summary, files touched", async () => {
  const editorPath = proj.replace(/\\/g, "/") + "/";
  const handler = (msg) => {
    if (msg.command === "get_open_scenes") return { project_path: editorPath, open: ["res://scenes/Main.tscn"], current: "res://scenes/Main.tscn" };
    if (msg.command === "end_batch") return { batch: "add crate", operations: 2 };
    return {};
  };
  await withMockBridge(handler, async (call, seen) => {
    const begin = await call("begin_task", { label: "add crate" });
    assert.equal(begin.isError, false);
    assert.match(begin.text, /one undo step/);
    assert.equal((await call("begin_task", { label: "again" })).isError, true); // no nesting

    await call("add_node", { project_path: proj, scene_path: "scenes/Main.tscn", parent_path: ".", name: "Crate", type: "StaticBody3D", properties: { position: "Vector3(3, 1, -20)" } });
    await call("set_node_properties", { project_path: proj, scene_path: "scenes/Main.tscn", node_path: "Crate", properties: { visible: "true" } });

    const mid = await call("get_change_summary");
    assert.match(mid.text, /Added a `StaticBody3D` named `Crate` under the scene root \(position = Vector3\(3, 1, -20\)\)/);
    assert.match(mid.text, /a body that never moves/);

    const end = await call("end_task");
    assert.equal(end.isError, false);
    assert.match(end.text, /Finished "add crate"/);
    assert.match(end.text, /One Ctrl\+Z in the editor undoes all 2 live edits/);
    assert.match(end.text, /Files touched: scenes\/Main\.tscn/);
    assert.doesNotMatch(end.text, /\+\d+ −\d+/); // not a diff stat
    assert.equal(seen.filter((m) => m.command === "begin_batch")[0].args.label, "add crate");
    assert.equal(seen.filter((m) => m.command === "end_batch").length, 1);

    assert.equal((await call("end_task")).isError, true); // nothing open any more
    assert.match((await call("get_change_summary")).text, /Nothing has been changed yet/);
  });
});

test("begin_task works without an editor and explains an older plugin", async () => {
  await withServer({}, async (call) => {
    const begin = await call("begin_task", { label: "disk only" });
    assert.equal(begin.isError, false);
    assert.match(begin.text, /not reachable/);
    await call("end_task");
  });
  await withMockBridge((msg) => msg.command === "begin_batch" && { error: "unknown command: begin_batch" }, async (call) => {
    const begin = await call("begin_task", { label: "old plugin" });
    assert.equal(begin.isError, false);
    assert.match(begin.text, /older than this server/);
    await call("end_task");
  });
});

test("scope discipline: working set, protected files, widening, and the mass-edit cap", async () => {
  await withServer({}, async (call) => {
    const pj = path.join(proj, "project.godot");
    const pjBefore = fs.readFileSync(pj, "utf8");
    const plugin = path.join(proj, "addons/godot_mcp_bridge/godot_mcp_bridge.gd");
    const pluginBefore = fs.readFileSync(plugin, "utf8");

    // protected files are refused even with no task declared
    for (const script_path of ["project.godot", "addons/godot_mcp_bridge/godot_mcp_bridge.gd"]) {
      const res = await call("write_script", { project_path: proj, script_path, content: "x" });
      assert.equal(res.isError, true, script_path);
    }
    const prot = await call("write_script", { project_path: proj, script_path: "addons/evil.gd", content: "x" });
    assert.match(prot.text, /off limits by default/);
    assert.match(prot.text, /allow_paths/);
    assert.equal(fs.readFileSync(pj, "utf8"), pjBefore);
    assert.equal(fs.readFileSync(plugin, "utf8"), pluginBefore);
    assert.equal(fs.existsSync(path.join(proj, "addons/evil.gd")), false);

    // only script/shader files can be written through the script tools
    const ext = await call("write_script", { project_path: proj, script_path: "notes.cfg", content: "x" });
    assert.equal(ext.isError, true);
    assert.match(ext.text, /not a GDScript or shader file/);

    // a declared working set
    await call("begin_task", { label: "tweak player", paths: ["scripts/player.gd", "scenes/"] });
    assert.equal((await call("edit_script", { project_path: proj, script_path: "scripts/player.gd", old_text: "extends", new_text: "extends" })).isError, false);
    const out = await call("write_script", { project_path: proj, script_path: "scripts/game.gd", content: "extends Node\n" });
    assert.equal(out.isError, true);
    assert.match(out.text, /outside this task's working set/);
    assert.match(out.text, /ask them to confirm/);
    assert.notEqual(fs.readFileSync(path.join(proj, "scripts/game.gd"), "utf8"), "extends Node\n");

    // widening deliberately
    assert.match((await call("allow_paths", { paths: ["scripts/game.gd"] })).text, /Allowed/);
    assert.equal((await call("write_script", { project_path: proj, script_path: "scripts/game.gd", content: fs.readFileSync(path.join(proj, "scripts/game.gd"), "utf8") })).isError, false);

    // naming a protected file in the working set is the explicit opt-in
    await call("allow_paths", { paths: ["addons/evil.gd"] });
    assert.equal((await call("write_script", { project_path: proj, script_path: "addons/evil.gd", content: "extends Node\n" })).isError, false);

    const end = await call("end_task");
    assert.match(end.text, /Refused as out of scope: scripts\/game\.gd/);
    assert.match(end.text, /Files touched: .*scripts\/game\.gd/);
    fs.rmSync(path.join(proj, "addons/evil.gd"), { force: true });
  });

  // mass edits ask first
  await withServer({ GODOT_MCP_MAX_FILES: "3" }, async (call) => {
    for (const n of [1, 2, 3]) {
      assert.equal((await call("write_script", { project_path: proj, script_path: `scripts/mass${n}.gd`, content: "extends Node\n" })).isError, false);
    }
    assert.equal((await call("write_script", { project_path: proj, script_path: "scripts/mass2.gd", content: "extends Node\n# again\n" })).isError, false); // same file again is fine
    const fourth = await call("write_script", { project_path: proj, script_path: "scripts/mass4.gd", content: "extends Node\n" });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /already changed 3 files/);
    assert.equal(fs.existsSync(path.join(proj, "scripts/mass4.gd")), false);
    // a task that explicitly names the file has the go-ahead
    await call("end_task").catch(() => {});
    await call("begin_task", { label: "more", paths: ["scripts/"] });
    assert.equal((await call("write_script", { project_path: proj, script_path: "scripts/mass4.gd", content: "extends Node\n" })).isError, false);
  });
});

test("editor_* write twins respect the working set", async () => {
  const editorPath = proj.replace(/\\/g, "/") + "/";
  const handler = (msg) =>
    msg.command === "get_open_scenes"
      ? { project_path: editorPath, open: ["res://scenes/Main.tscn"], current: "res://scenes/Main.tscn" }
      : {};
  await withMockBridge(handler, async (call, seen) => {
    await call("begin_task", { label: "scripts only", paths: ["scripts/"] });
    const res = await call("editor_add_node", { parent_path: ".", name: "X", type: "Node2D" });
    assert.equal(res.isError, true);
    assert.match(res.text, /outside this task's working set/);
    assert.equal(seen.some((m) => m.command === "add_node"), false, "the edit must not reach the editor");
  });
});

test("file tools reject GDScript-only values like RectangleShape2D.new() instead of corrupting the scene", async () => {
  await withServer({}, async (call) => {
    const scenePath = path.join(proj, "scenes/Main.tscn");
    const before = fs.readFileSync(scenePath, "utf8");
    const add = await call("add_node", {
      project_path: proj, scene_path: "scenes/Main.tscn", parent_path: ".", name: "Shape", type: "CollisionShape3D",
      properties: { shape: "BoxShape3D.new()" },
    });
    assert.equal(add.isError, true);
    assert.match(add.text, /GDScript, not scene-file syntax/);
    assert.match(add.text, /editor_add_node/);

    const set = await call("set_node_properties", {
      project_path: proj, scene_path: "scenes/Main.tscn", node_path: "Player/CollisionShape3D", properties: { shape: "SphereShape3D.new()" },
    });
    assert.equal(set.isError, true);
    assert.equal(fs.readFileSync(scenePath, "utf8"), before);
  });
});

test("run_headless never passes a caller-supplied string to Godot as a flag", async () => {
  const argsFile = path.join(tmp, "args.json");
  // a stand-in "Godot" that records the arguments it was started with
  const fake = path.join(tmp, "fake-godot.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`);
  const launcher = process.platform === "win32" ? null : path.join(tmp, "fake-godot");
  if (!launcher) return; // the stand-in needs a shebang launcher
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });

  await withServer({ GODOT_BIN: launcher }, async (call) => {
    for (const scene_path of ["--script", "--script=evil.gd", "-s", "--path=/etc", "../outside.tscn", "scripts/player.gd", "scenes/Missing.tscn"]) {
      fs.rmSync(argsFile, { force: true });
      const res = await call("run_headless", { project_path: proj, scene_path });
      assert.equal(res.isError, true, scene_path);
      assert.equal(fs.existsSync(argsFile), false, `Godot must not be launched for ${scene_path}`);
    }
    const ok = await call("run_headless", { project_path: proj, scene_path: "scenes/Main.tscn" });
    assert.equal(ok.isError, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["--headless", "--path", proj, "res://scenes/Main.tscn"]);
  });
});

test("every bridge request carries the shared token when the plugin has written one", async () => {
  const tokenFile = path.join(tmp, "bridge-token");
  fs.writeFileSync(tokenFile, "s3cret-token\n");
  const withToken = (fn) => withMockBridgeEnv({ GODOT_MCP_BRIDGE_TOKEN_FILE: tokenFile }, fn);
  await withToken(async (call, seen) => {
    await call("editor_ping");
    assert.equal(seen[0].token, "s3cret-token");
  });
  await withMockBridgeEnv({ GODOT_MCP_BRIDGE_TOKEN_FILE: path.join(tmp, "no-such-token") }, async (call, seen) => {
    await call("editor_ping");
    assert.equal(seen[0].token, undefined);
  });
});

/** Like withMockBridge, with extra environment for the server. */
async function withMockBridgeEnv(env, fn) {
  const seen = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.on("listening", resolve));
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { status: "alive" }, error: null }));
    })
  );
  try {
    await withServer({ GODOT_MCP_BRIDGE_URL: `ws://127.0.0.1:${wss.address().port}`, ...env }, (call) => fn(call, seen));
  } finally {
    wss.close();
  }
}
