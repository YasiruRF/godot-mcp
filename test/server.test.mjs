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

test("exposes all 20 tools", async () => {
  await withServer({}, async (_call, client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "add_node", "create_scene", "edit_script",
        "editor_add_node", "editor_get_scene_tree", "editor_get_selection", "editor_open_scene",
        "editor_ping", "editor_remove_node", "editor_run_scene", "editor_save_scene",
        "editor_set_properties", "editor_stop",
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

test("file tools refuse to edit a scene that is open in the editor, but only that scene and project", async () => {
  const scene = path.join(proj, "scenes/Guarded.tscn");
  const other = path.join(proj, "scenes/Free.tscn");
  fs.writeFileSync(scene, '[gd_scene format=3]\n\n[node name="G" type="Node2D"]\n');
  fs.writeFileSync(other, '[gd_scene format=3]\n\n[node name="F" type="Node2D"]\n');
  const before = fs.readFileSync(scene, "utf8");
  const editorState = (project_path) => ({ project_path, open: ["res://scenes/Guarded.tscn"], current: "res://scenes/Guarded.tscn" });
  const add = (scene_path) => ({ project_path: proj, scene_path, parent_path: ".", name: "Child", type: "Node2D" });

  // same project (the editor reports it with forward slashes and a trailing slash)
  const editorPath = proj.replace(/\\/g, "/") + "/";
  await withMockBridge((msg) => msg.command === "get_open_scenes" && editorState(editorPath), async (call) => {
    for (const [tool, args] of [
      ["add_node", add("scenes/Guarded.tscn")],
      ["remove_node", { project_path: proj, scene_path: "scenes/Guarded.tscn", node_path: "G" }],
      ["set_node_properties", { project_path: proj, scene_path: "res://scenes/Guarded.tscn", node_path: ".", properties: { visible: "false" } }],
      ["create_scene", { project_path: proj, scene_path: "scenes/Guarded.tscn", root_name: "G", root_type: "Node2D", overwrite: true }],
    ]) {
      const res = await call(tool, args);
      assert.equal(res.isError, true, tool);
      assert.match(res.text, /open in the Godot editor/, tool);
      assert.match(res.text, /editor_add_node/, tool);
    }
    assert.equal(fs.readFileSync(scene, "utf8"), before, "guarded scene must be untouched");

    // a scene the editor does not have open is still editable on disk
    assert.equal((await call("add_node", add("scenes/Free.tscn"))).isError, false);
  });

  // the editor has a different project open: no guard
  await withMockBridge((msg) => msg.command === "get_open_scenes" && editorState(path.join(tmp, "another-project")), async (call) => {
    assert.equal((await call("add_node", add("scenes/Guarded.tscn"))).isError, false);
  });

  // an older plugin that doesn't know get_open_scenes: no guard
  await withMockBridge((msg) => msg.command === "get_open_scenes" && { error: "unknown command: get_open_scenes" }, async (call) => {
    assert.equal((await call("add_node", { ...add("scenes/Guarded.tscn"), name: "Child2" })).isError, false);
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
