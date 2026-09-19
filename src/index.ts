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
import { callBridge } from "./bridge.js";

const server = new McpServer({
  name: "godot-mcp",
  version: "0.1.0",
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

async function resolveInProject(projectPath: string, relOrAbs: string): Promise<string> {
  const full = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(projectPath, relOrAbs);
  const normalizedProject = path.resolve(projectPath);
  const normalizedFull = path.resolve(full);
  if (!normalizedFull.startsWith(normalizedProject)) {
    throw new Error(`Refusing to write outside the project folder: ${relOrAbs}`);
  }
  return normalizedFull;
}

async function findGodotBinary(): Promise<string> {
  return process.env.GODOT_BIN ?? "godot4";
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
      const exts = new Set([".tscn", ".gd", ".tres", ".res", ".import"]);
      const results: Record<string, string[]> = { scenes: [], scripts: [], resources: [], other: [] };

      async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "." || entry.name === ".." || entry.name === ".godot") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            const rel = path.relative(project_path, full);
            const ext = path.extname(entry.name);
            if (ext === ".tscn") results.scenes.push(rel);
            else if (ext === ".gd") results.scripts.push(rel);
            else if (ext === ".tres" || ext === ".res") results.resources.push(rel);
            else if (exts.has(ext)) continue;
          }
        }
      }
      await walk(project_path);
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
      if (!overwrite) {
        const exists = await fs.stat(full).then(() => true).catch(() => false);
        if (exists) throw new Error(`${scene_path} already exists (pass overwrite: true to replace it)`);
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      const file = createEmptyScene(root_name, root_type);
      await fs.writeFile(full, serializeTscn(file), "utf-8");
      return text(`Created ${scene_path} with root node "${root_name}" (${root_type}).`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "add_node",
  "Adds a child node to an existing scene at the given parent path (use \".\" for the scene root).",
  {
    project_path: z.string(),
    scene_path: z.string(),
    parent_path: z.string().describe('Path of the parent node, e.g. "." or "Player" or "Player/Sprite2D"'),
    name: z.string(),
    type: z.string().describe('Godot node class, e.g. "Sprite2D", "CollisionShape2D"'),
    properties: z
      .record(z.string())
      .optional()
      .describe('Raw property assignments, e.g. { "position": "Vector2(10, 20)" }'),
    script_path: z
      .string()
      .optional()
      .describe("If set, attaches this .gd script to the new node (path relative to project_path)"),
  },
  async ({ project_path, scene_path, parent_path, name, type, properties, script_path }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      const raw = await fs.readFile(full, "utf-8");
      const file = parseTscn(raw);

      let scriptExtResourceId: string | undefined;
      if (script_path) {
        const resPath = script_path.startsWith("res://")
          ? script_path
          : `res://${path.relative(project_path, await resolveInProject(project_path, script_path))}`;
        scriptExtResourceId = addExtResource(file, "Script", resPath);
      }

      addNode(file, { name, type, parentPath: parent_path, properties, scriptExtResourceId });
      await fs.writeFile(full, serializeTscn(file), "utf-8");
      return text(`Added node "${name}" (${type}) under "${parent_path}" in ${scene_path}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "remove_node",
  "Removes a node (and its descendants) from a scene.",
  {
    project_path: z.string(),
    scene_path: z.string(),
    node_path: z.string(),
  },
  async ({ project_path, scene_path, node_path }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      const raw = await fs.readFile(full, "utf-8");
      const file = parseTscn(raw);
      removeNode(file, node_path);
      await fs.writeFile(full, serializeTscn(file), "utf-8");
      return text(`Removed "${node_path}" from ${scene_path}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "set_node_properties",
  "Sets or overwrites one or more properties on an existing node in a scene.",
  {
    project_path: z.string(),
    scene_path: z.string(),
    node_path: z.string(),
    properties: z.record(z.string()).describe('e.g. { "position": "Vector2(100, 50)", "visible": "false" }'),
  },
  async ({ project_path, scene_path, node_path, properties }) => {
    try {
      const full = await resolveInProject(project_path, scene_path);
      const raw = await fs.readFile(full, "utf-8");
      const file = parseTscn(raw);
      setNodeProperties(file, node_path, properties);
      await fs.writeFile(full, serializeTscn(file), "utf-8");
      return text(`Updated properties on "${node_path}" in ${scene_path}.`);
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
      const full = await resolveInProject(project_path, script_path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
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
      const full = await resolveInProject(project_path, script_path);
      const content = await fs.readFile(full, "utf-8");
      const count = content.split(old_text).length - 1;
      if (count === 0) throw new Error("old_text not found in file");
      if (count > 1) throw new Error(`old_text matched ${count} times; make it unique`);
      const updated = content.replace(old_text, new_text);
      await fs.writeFile(full, updated, "utf-8");
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
        child.on("close", () => resolve(out));
      });
      return text(output || "(no output — process ran and exited cleanly)");
    } catch (e) {
      return errText(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Phase 2 — live editor bridge tools (require the companion EditorPlugin)
// ---------------------------------------------------------------------------

server.tool(
  "editor_ping",
  "Checks whether the Godot editor is running with the godot_mcp_bridge plugin enabled.",
  {},
  async () => {
    try {
      const res = await callBridge({ command: "ping" });
      return text(JSON.stringify(res));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "editor_run_scene",
  "Tells the running Godot editor to play a specific scene (like pressing the Play Scene button).",
  { scene_path: z.string().describe('e.g. "res://scenes/Main.tscn"') },
  async ({ scene_path }) => {
    try {
      const res = await callBridge({ command: "run_scene", args: { scene_path } });
      return text(JSON.stringify(res));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "editor_stop",
  "Tells the running Godot editor to stop the currently playing scene.",
  {},
  async () => {
    try {
      const res = await callBridge({ command: "stop" });
      return text(JSON.stringify(res));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "editor_get_selection",
  "Returns the currently selected node(s) in the Godot editor.",
  {},
  async () => {
    try {
      const res = await callBridge({ command: "get_selection" });
      return text(JSON.stringify(res));
    } catch (e) {
      return errText(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
