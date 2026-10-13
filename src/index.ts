#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  parseTscn,
  serializeTscn,
  getSceneTree,
  addNode,
  removeNode,
  setNodeProperties,
  addExtResource,
  createEmptyScene,
} from "./tscn.js";
import { callBridge, type BridgeRequest } from "./bridge.js";
import { TaskTracker } from "./task.js";
import { describeAdd, describeSet, describeRemove } from "./describe.js";

const server = new McpServer({
  name: "godot-mcp",
  version: "0.2.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

/** Fails unless `projectPath` is a Godot project folder (contains project.godot). */
async function assertProject(projectPath: string): Promise<void> {
  const isProject = await fs
    .stat(path.join(projectPath, "project.godot"))
    .then((s) => s.isFile())
    .catch(() => false);
  if (!isProject) {
    throw new Error(`No project.godot found in "${projectPath}" — project_path must be the Godot project folder`);
  }
}

/** Resolves a project-relative, absolute, or res:// path, refusing anything outside the project. */
async function resolveInProject(projectPath: string, relOrAbs: string): Promise<string> {
  await assertProject(projectPath);
  const root = path.resolve(projectPath);
  const full = path.resolve(root, relOrAbs.startsWith("res://") ? relOrAbs.slice("res://".length) : relOrAbs);
  const rel = path.relative(root, full);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to access a path outside the project folder: ${relOrAbs}`);
  }
  return full;
}

/** res:// path for a file inside the project (always forward slashes, even on Windows). */
function toResPath(projectPath: string, fullPath: string): string {
  return `res://${path.relative(path.resolve(projectPath), fullPath).split(path.sep).join("/")}`;
}

async function findGodotBinary(): Promise<string> {
  return process.env.GODOT_BIN ?? "godot4";
}

/** GDScript-only syntax such as `RectangleShape2D.new()` would corrupt a .tscn file. */
function assertSceneFileValues(properties: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (/\.new\s*\(/.test(value)) {
      throw new Error(
        `Property "${key}": \`${value}\` is GDScript, not scene-file syntax, and would corrupt the .tscn. ` +
          `Resources in a scene file must be SubResource(...) entries. To create one (e.g. a collision shape), ` +
          `open the scene in the Godot editor and use editor_add_node / editor_set_properties, which accept "RectangleShape2D.new()".`
      );
    }
  }
}

const tracker = new TaskTracker();

/** Project-relative path with forward slashes, for scope checks and reports. */
function toRel(projectPath: string, fullPath: string): string {
  return toResPath(projectPath, fullPath).slice("res://".length);
}

/** Only .gd (and shader) sources may be written through the script tools. */
const SCRIPT_EXTENSIONS = new Set([".gd", ".gdshader", ".gdshaderinc"]);

function assertScriptFile(scriptPath: string): void {
  if (!SCRIPT_EXTENSIONS.has(path.extname(scriptPath).toLowerCase())) {
    throw new Error(
      `${scriptPath} is not a GDScript or shader file (.gd, .gdshader, .gdshaderinc); the script tools only write those. ` +
        `Scenes go through add_node / set_node_properties.`
    );
  }
}

type Route = { via: "disk" } | { via: "editor"; resPath: string; active: boolean };

/**
 * Decides who owns a scene right now: the running Godot editor (if it has this project's scene
 * open) or the file on disk. Without a reachable bridge — or with a plugin that predates
 * get_open_scenes, or a different project open — the answer is always the disk.
 */
async function routeScene(projectPath: string, scenePath: string): Promise<Route> {
  let info: { project_path?: string; open?: string[]; current?: string } | undefined;
  try {
    const res = await callBridge({ command: "get_open_scenes" }, 1500);
    if (!res.ok) return { via: "disk" }; // bridge plugin predates get_open_scenes
    info = res.result as typeof info;
  } catch {
    return { via: "disk" }; // editor not running
  }
  if (!info?.project_path || !Array.isArray(info.open)) return { via: "disk" };

  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (norm(info.project_path) !== norm(projectPath)) return { via: "disk" }; // the editor has a different project open

  const resPath = toResPath(projectPath, await resolveInProject(projectPath, scenePath));
  if (!info.open.includes(resPath)) return { via: "disk" };
  return { via: "editor", resPath, active: info.current === resPath };
}

/** Sends a live scene edit to the editor, first switching to the scene's tab if another is showing. */
async function liveEdit(route: Extract<Route, { via: "editor" }>, command: string, args: Record<string, unknown>) {
  if (!route.active) {
    const opened = await callBridge({ command: "open_scene", args: { scene_path: route.resPath } });
    if (!opened.ok) throw new Error(opened.error ?? `could not switch the editor to ${route.resPath}`);
  }
  const res = await callBridge({ command, args: { ...args, scene_path: route.resPath } });
  if (!res.ok) throw new Error(res.error ?? "the Godot editor bridge reported an error");
  return res.result;
}

/** What to tell the user about where an edit landed. */
function viaNote(route: Route): string {
  return route.via === "editor"
    ? `(live in the Godot editor${route.active ? "" : ", after switching to that scene's tab"}; Ctrl+Z undoes it, and it is saved when you save the scene)`
    : "(edited the .tscn on disk; the scene isn't open in the editor)";
}

/**
 * Refuses an on-disk edit of a scene that the running Godot editor has open. Used where there is
 * no live equivalent (replacing a whole scene file).
 */
async function assertSceneNotOpenInEditor(projectPath: string, scenePath: string): Promise<void> {
  const route = await routeScene(projectPath, scenePath);
  if (route.via === "editor") {
    throw new Error(
      `${route.resPath} is open in the Godot editor, so replacing the file on disk would desync it from the editor ` +
        `(and one of the two saves would overwrite the other). Close the scene's tab in Godot first, ` +
        `or change it with add_node / set_node_properties / remove_node, which edit it live.`
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — file-based tools
// ---------------------------------------------------------------------------

server.tool(
  "list_project",
  "Lists scenes (.tscn), scripts (.gd), and resources (.tres/.res) in a Godot project folder, relative to project_path.",
  { project_path: z.string().describe("Absolute path to the Godot project folder (containing project.godot)") },
  async ({ project_path }) => {
    try {
      await assertProject(project_path);
      const results: Record<string, string[]> = { scenes: [], scripts: [], resources: [] };
      const skipDirs = new Set([".godot", ".git", "node_modules"]);

      async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) await walk(full);
          } else {
            const rel = path.relative(project_path, full).split(path.sep).join("/");
            const ext = path.extname(entry.name);
            if (ext === ".tscn") results.scenes.push(rel);
            else if (ext === ".gd") results.scripts.push(rel);
            else if (ext === ".tres" || ext === ".res") results.resources.push(rel);
          }
        }
      }
      await walk(project_path);
      for (const list of Object.values(results)) list.sort();
      return text(JSON.stringify(results, null, 2));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "read_scene",
  "Parses a .tscn file and returns its node tree as JSON (name, type, parent path, properties).",
  {
    project_path: z.string(),
    scene_path: z.string().describe("Path to the .tscn file, relative to project_path or absolute"),
  },
  async ({ project_path, scene_path }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      const raw = await fs.readFile(full, "utf-8");
      const file = parseTscn(raw);
      const tree = getSceneTree(file);
      return text(JSON.stringify(tree, null, 2));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "create_scene",
  "Creates a new .tscn file with a single root node. Use add_node afterward to build out the tree.",
  {
    project_path: z.string(),
    scene_path: z.string().describe("Where to write the new scene, e.g. scenes/Player.tscn"),
    root_name: z.string(),
    root_type: z.string().describe('Godot node class, e.g. "Node2D", "CharacterBody2D", "Control"'),
    overwrite: z.boolean().optional().default(false),
  },
  async ({ project_path, scene_path, root_name, root_type, overwrite }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      tracker.check(toRel(project_path, full));
      if (!overwrite) {
        const exists = await fs.stat(full).then(() => true).catch(() => false);
        if (exists) throw new Error(`${scene_path} already exists (pass overwrite: true to replace it)`);
      } else {
        await assertSceneNotOpenInEditor(project_path, scene_path);
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      const file = createEmptyScene(root_name, root_type);
      await fs.writeFile(full, serializeTscn(file), "utf-8");
      tracker.touch(toRel(project_path, full));
      tracker.record(`Created the scene ${scene_path} with a ${root_type} root named ${root_name}.`);
      return text(`Created ${scene_path} with root node "${root_name}" (${root_type}).`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "add_node",
  "Adds a child node to a scene at the given parent path (use \".\" for the scene root). Routes itself: if the scene is open in the running Godot editor the node is added live there (selected, undoable with Ctrl+Z); otherwise the .tscn on disk is edited. The result says which happened. Property values are Godot syntax, e.g. Vector3(1, 2, 3); for a resource such as a collision shape, \"BoxShape3D.new()\" only works when the scene is open in the editor.",
  {
    project_path: z.string(),
    scene_path: z.string(),
    parent_path: z.string().describe('Path of the parent node, e.g. "." or "Player" or "Player/Sprite2D"'),
    name: z.string(),
    type: z.string().describe('Godot node class, e.g. "Sprite2D", "CollisionShape2D"'),
    properties: z
      .record(z.string())
      .optional()
      .describe('Property assignments in Godot syntax, e.g. { "position": "Vector2(10, 20)" }'),
    script_path: z
      .string()
      .optional()
      .describe("If set, attaches this .gd script to the new node (path relative to project_path)"),
  },
  async ({ project_path, scene_path, parent_path, name, type, properties, script_path }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      tracker.check(toRel(project_path, full));
      const route = await routeScene(project_path, scene_path);
      const scriptRes = script_path ? toResPath(project_path, await resolveInProject(project_path, script_path)) : undefined;

      if (route.via === "editor") {
        await liveEdit(route, "add_node", { parent_path, name, type, properties, script_path: scriptRes });
      } else {
        assertSceneFileValues(properties);
        const file = parseTscn(await fs.readFile(full, "utf-8"));
        let scriptExtResourceId: string | undefined;
        if (scriptRes) scriptExtResourceId = addExtResource(file, "Script", scriptRes);
        addNode(file, { name, type, parentPath: parent_path, properties, scriptExtResourceId });
        await fs.writeFile(full, serializeTscn(file), "utf-8");
      }
      tracker.touch(toRel(project_path, full));
      const what = describeAdd({ name, type, parentPath: parent_path, properties, scriptPath: scriptRes });
      tracker.record(what);
      return text(`${what} ${viaNote(route)}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "remove_node",
  "Removes a node (and its descendants) from a scene. Routes itself like add_node: live in the Godot editor (undoable with Ctrl+Z) if the scene is open there, otherwise on disk.",
  {
    project_path: z.string(),
    scene_path: z.string(),
    node_path: z.string(),
  },
  async ({ project_path, scene_path, node_path }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      tracker.check(toRel(project_path, full));
      const route = await routeScene(project_path, scene_path);
      if (route.via === "editor") {
        await liveEdit(route, "remove_node", { node_path });
      } else {
        const file = parseTscn(await fs.readFile(full, "utf-8"));
        removeNode(file, node_path);
        await fs.writeFile(full, serializeTscn(file), "utf-8");
      }
      tracker.touch(toRel(project_path, full));
      const what = describeRemove(node_path, route.via === "disk");
      tracker.record(what);
      return text(`${what} ${viaNote(route)}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "set_node_properties",
  "Sets or overwrites one or more properties on an existing node in a scene. Routes itself like add_node: live in the Godot editor (undoable with Ctrl+Z) if the scene is open there, otherwise on disk. Values are Godot syntax.",
  {
    project_path: z.string(),
    scene_path: z.string(),
    node_path: z.string(),
    properties: z.record(z.string()).describe('e.g. { "position": "Vector2(100, 50)", "visible": "false" }'),
  },
  async ({ project_path, scene_path, node_path, properties }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      tracker.check(toRel(project_path, full));
      const route = await routeScene(project_path, scene_path);
      if (route.via === "editor") {
        await liveEdit(route, "set_properties", { node_path, properties });
      } else {
        assertSceneFileValues(properties);
        const file = parseTscn(await fs.readFile(full, "utf-8"));
        setNodeProperties(file, node_path, properties);
        await fs.writeFile(full, serializeTscn(file), "utf-8");
      }
      tracker.touch(toRel(project_path, full));
      const what = describeSet(node_path, properties);
      tracker.record(what);
      return text(`${what} ${viaNote(route)}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "write_script",
  "Creates or fully overwrites a GDScript (.gd) file.",
  {
    project_path: z.string(),
    script_path: z.string().describe("e.g. scripts/Player.gd"),
    content: z.string(),
  },
  async ({ project_path, script_path, content }) => {
    try {
      assertScriptFile(script_path);
      const full = await resolveInProject(project_path, script_path);
      tracker.check(toRel(project_path, full));
      const existed = await fs.stat(full).then(() => true).catch(() => false);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      tracker.touch(toRel(project_path, full));
      tracker.record(`${existed ? "Rewrote" : "Created"} the script ${script_path}.`);
      return text(`Wrote ${script_path} (${content.split("\n").length} lines).`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "read_script",
  "Reads a GDScript (.gd) file's contents.",
  { project_path: z.string(), script_path: z.string() },
  async ({ project_path, script_path }) => {
    try {
      const full = await resolveInProject(project_path, script_path);
      const content = await fs.readFile(full, "utf-8");
      return text(content);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "edit_script",
  "Replaces one exact occurrence of old_text with new_text in a GDScript file (like a find-and-replace patch).",
  {
    project_path: z.string(),
    script_path: z.string(),
    old_text: z.string(),
    new_text: z.string(),
  },
  async ({ project_path, script_path, old_text, new_text }) => {
    try {
      assertScriptFile(script_path);
      const full = await resolveInProject(project_path, script_path);
      tracker.check(toRel(project_path, full));
      const content = await fs.readFile(full, "utf-8");
      const count = content.split(old_text).length - 1;
      if (count === 0) throw new Error("old_text not found in file");
      if (count > 1) throw new Error(`old_text matched ${count} times; make it unique`);
      // replacer function: a string would have `$&`, `$1`, ... interpreted
      const updated = content.replace(old_text, () => new_text);
      await fs.writeFile(full, updated, "utf-8");
      tracker.touch(toRel(project_path, full));
      tracker.record(`Changed part of the script ${script_path}.`);
      return text(`Edited ${script_path}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "run_headless",
  "Runs the Godot project headlessly (no window) for a fixed duration to catch parse/runtime errors, or runs a specific scene headlessly. Requires the `godot4` binary (or GODOT_BIN env var) to be installed.",
  {
    project_path: z.string(),
    scene_path: z.string().optional().describe("Specific scene to run instead of the project's main scene"),
    timeout_ms: z.number().optional().default(5000),
  },
  async ({ project_path, scene_path, timeout_ms }) => {
    try {
      await assertProject(project_path);
      const godot = await findGodotBinary();
      const args = ["--headless", "--path", project_path];
      if (scene_path) args.push(scene_path);

      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(godot, args, { timeout: timeout_ms });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (out += d.toString()));
        child.on("error", (err) =>
          reject(new Error(`Could not launch "${godot}": ${err.message}. Set GODOT_BIN to the Godot 4 executable path.`))
        );
        child.on("close", (code, signal) => {
          const status = signal ? `stopped by ${signal} after the ${timeout_ms}ms timeout` : `exit code ${code}`;
          resolve(`${out}${out && !out.endsWith("\n") ? "\n" : ""}[${status}]`);
        });
      });
      return text(output);
    } catch (e) {
      return errText(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Phase 2 — live editor bridge tools (require the companion EditorPlugin)
// ---------------------------------------------------------------------------

/** Sends one command to the editor bridge; a bridge-reported failure becomes an isError result. */
async function bridgeTool(req: BridgeRequest): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const res = await callBridge(req);
    if (!res.ok) throw new Error(res.error ?? "the Godot editor bridge reported an error");
    return text(JSON.stringify(res.result ?? null, null, 2));
  } catch (e) {
    return errText(e);
  }
}

const sceneGuard = z
  .string()
  .optional()
  .describe("Optional safety check: fail unless this is the scene currently open in the editor");

server.tool(
  "editor_ping",
  "Checks whether the Godot editor is running with the godot_mcp_bridge plugin enabled.",
  {},
  () => bridgeTool({ command: "ping" })
);

server.tool(
  "editor_run_scene",
  "Tells the running Godot editor to play a specific scene (like pressing the Play Scene button).",
  { scene_path: z.string().describe('e.g. "res://scenes/Main.tscn"') },
  ({ scene_path }) => bridgeTool({ command: "run_scene", args: { scene_path } })
);

server.tool(
  "editor_stop",
  "Tells the running Godot editor to stop the currently playing scene.",
  {},
  () => bridgeTool({ command: "stop" })
);

server.tool(
  "editor_get_selection",
  "Returns the currently selected node(s) in the Godot editor.",
  {},
  () => bridgeTool({ command: "get_selection" })
);

// --- Live editing: these change the scene open in the editor itself, so the user watches each
// --- edit appear and can undo it with Ctrl+Z. Nothing is written to disk until the scene is saved.

server.tool(
  "editor_get_scene_tree",
  "Returns the scene currently open in the Godot editor as a node tree, plus the list of open scenes.",
  {},
  () => bridgeTool({ command: "get_scene_tree" })
);

server.tool(
  "editor_open_scene",
  "Opens a scene in the Godot editor (switching to its tab) so it can be edited live with editor_add_node, editor_set_properties and editor_remove_node.",
  { scene_path: z.string().describe('e.g. "res://scenes/Main.tscn" or "scenes/Main.tscn"') },
  ({ scene_path }) => bridgeTool({ command: "open_scene", args: { scene_path } })
);

/**
 * Scope check for the editor_* write tools, which act on the scene in the active tab. When a
 * working set was declared the active scene's file is checked against it; otherwise only an
 * explicitly named scene is, so the default path costs no extra bridge call.
 */
async function guardEditorWrite(sceneArg: string | undefined): Promise<void> {
  let target = sceneArg;
  if (!target && tracker.hasScope()) {
    try {
      const res = await callBridge({ command: "get_open_scenes" }, 1500);
      target = (res.result as { current?: string } | undefined)?.current;
    } catch {
      return; // the bridge call that follows reports the real problem
    }
  }
  if (target) tracker.check(target);
}

const TWIN_NOTE = " Prefer add_node / set_node_properties / remove_node, which pick the editor or the disk for you.";

server.tool(
  "editor_add_node",
  "Adds a node to the scene open in the Godot editor. It appears live and is selected; undo with Ctrl+Z. The scene is not saved until editor_save_scene (or the user saves)." + TWIN_NOTE,
  {
    parent_path: z.string().describe('Path of the parent node in the open scene, e.g. "." or "Player"'),
    name: z.string(),
    type: z.string().describe('Godot Node class, e.g. "Sprite2D"'),
    properties: z
      .record(z.string())
      .optional()
      .describe(
        'Godot-syntax values, e.g. { "position": "Vector2(10, 20)", "shape": "RectangleShape2D.new()", "shape:size": "Vector2(32, 48)" }. ' +
          'Strings need quotes ("\\"hi\\""); ClassName.new() creates a Resource; "prop:subprop" reaches into a resource. Applied in order.'
      ),
    script_path: z.string().optional().describe("Attach this script, e.g. res://scripts/coin.gd"),
    scene_path: sceneGuard,
  },
  async ({ parent_path, name, type, properties, script_path, scene_path }) => {
    try {
      await guardEditorWrite(scene_path);
    } catch (e) {
      return errText(e);
    }
    const res = await bridgeTool({ command: "add_node", args: { parent_path, name, type, properties, script_path, scene_path } });
    if (!res.isError) tracker.record(describeAdd({ name, type, parentPath: parent_path, properties, scriptPath: script_path }));
    return res;
  }
);

server.tool(
  "editor_set_properties",
  "Sets properties on a node in the scene open in the Godot editor (live, undoable with Ctrl+Z, not saved until editor_save_scene)." + TWIN_NOTE,
  {
    node_path: z.string().describe('Path in the open scene, "." for the root'),
    properties: z.record(z.string()).describe('Godot-syntax values, e.g. { "position": "Vector2(100, 50)", "visible": "false" }'),
    scene_path: sceneGuard,
  },
  async ({ node_path, properties, scene_path }) => {
    try {
      await guardEditorWrite(scene_path);
    } catch (e) {
      return errText(e);
    }
    const res = await bridgeTool({ command: "set_properties", args: { node_path, properties, scene_path } });
    if (!res.isError) tracker.record(describeSet(node_path, properties));
    return res;
  }
);

server.tool(
  "editor_remove_node",
  "Removes a node (and its descendants) from the scene open in the Godot editor (live, undoable with Ctrl+Z)." + TWIN_NOTE,
  { node_path: z.string(), scene_path: sceneGuard },
  async ({ node_path, scene_path }) => {
    try {
      await guardEditorWrite(scene_path);
    } catch (e) {
      return errText(e);
    }
    const res = await bridgeTool({ command: "remove_node", args: { node_path, scene_path } });
    if (!res.isError) tracker.record(describeRemove(node_path, false));
    return res;
  }
);

server.tool(
  "editor_save_scene",
  "Saves the scene currently open in the Godot editor to disk (like Ctrl+S).",
  {},
  () => bridgeTool({ command: "save_scene" })
);

// ---------------------------------------------------------------------------
// Tasks — one undo step, a plain-language change summary, and a declared scope
// ---------------------------------------------------------------------------

/** Best-effort call to the bridge; returns undefined when the editor isn't there. */
async function tryBridge(req: BridgeRequest): Promise<{ ok: boolean; result?: any; error?: string } | undefined> {
  try {
    return await callBridge(req, 3000);
  } catch {
    return undefined;
  }
}

server.tool(
  "begin_task",
  "Start a task. Call this before a multi-step change (e.g. building an obstacle course). It does three things: (1) in the live editor, every edit until end_task becomes ONE undo step named after `label`, so a single Ctrl+Z reverts the whole task; (2) it starts a plain-language log of what changed, returned by end_task; (3) optionally it declares the working set: files outside `paths` are refused until the user approves widening it. Protected files (project.godot, export_presets.cfg, .godot/, addons/) are always refused unless named in `paths`.",
  {
    label: z.string().min(1).describe('Short name of the change, shown in Godot\'s undo history, e.g. "add obstacle course"'),
    paths: z
      .array(z.string())
      .optional()
      .describe('Project-relative files, folders ("scenes/") or globs ("scripts/*.gd") this task may change. Omit for no limit.'),
  },
  async ({ label, paths }) => {
    if (tracker.active) {
      return errText(`A task is already open ("${tracker.label}"). Call end_task first.`);
    }
    tracker.begin(label, paths);
    const bridge = await tryBridge({ command: "begin_batch", args: { label } });
    let undo: string;
    if (!bridge) undo = "Godot editor not reachable: edits to files on disk are not part of an undo stack.";
    else if (bridge.ok) undo = `Live editor edits are now one undo step: "Claude: ${label}".`;
    else if (/unknown command/.test(bridge.error ?? ""))
      undo = "The editor plugin is older than this server, so each live edit is still its own undo step. Re-copy addons/godot_mcp_bridge/ and toggle the plugin off and on.";
    else undo = `Could not group live edits into one undo step: ${bridge.error}`;
    const scope = paths && paths.length > 0 ? `Working set: ${paths.join(", ")}.` : "No working set declared.";
    return text(`Started task "${label}". ${scope} ${undo}`);
  }
);

server.tool(
  "end_task",
  "Ends the task started with begin_task and returns a short summary of what changed, in Godot terms, plus the files touched and anything that was refused. Show this to the user.",
  {},
  async () => {
    if (!tracker.active) return errText("No task is open. Call begin_task first.");
    const bridge = await tryBridge({ command: "end_batch" });
    const report = tracker.end();
    const lines = [`Finished "${report.label}".`, report.summary];
    if (bridge?.ok && bridge.result?.operations > 0) {
      lines.push(`One Ctrl+Z in the editor undoes all ${bridge.result.operations} live edits.`);
    }
    if (report.touched.length > 0) lines.push(`Files touched: ${report.touched.join(", ")}.`);
    if (report.declined.length > 0) lines.push(`Refused as out of scope: ${report.declined.join(", ")}.`);
    return text(lines.join("\n"));
  }
);

server.tool(
  "allow_paths",
  "Widens the current task's working set (or approves a protected file) AFTER the user has said yes. Never call this on your own: when an edit is refused as out of scope, tell the user what you want to change and why, and only call this once they agree.",
  { paths: z.array(z.string()).min(1).describe("Project-relative files, folders or globs the user approved") },
  async ({ paths }) => {
    tracker.allow(paths);
    return text(`Allowed for this task: ${paths.join(", ")}.`);
  }
);

server.tool(
  "get_change_summary",
  "Returns the plain-language summary of changes made so far in the current task, without ending it.",
  {},
  async () => text(tracker.summary())
);

server.resource("changes", "godot://changes", { mimeType: "text/plain", description: "What changed in the current task, in Godot terms" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: tracker.summary() }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
