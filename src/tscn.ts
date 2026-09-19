/**
 * Minimal parser/serializer for Godot's .tscn (text scene) format.
 *
 * .tscn files look like:
 *
 *   [gd_scene load_steps=2 format=3 uid="uid://abc"]
 *
 *   [ext_resource type="Script" path="res://scripts/Player.gd" id="1_abcde"]
 *
 *   [node name="Main" type="Node2D"]
 *
 *   [node name="Player" type="CharacterBody2D" parent="."]
 *   script = ExtResource("1_abcde")
 *
 * This module treats the file as an ordered list of "blocks" (each starting
 * with a `[tag key="val" ...]` header line, followed by zero or more raw
 * property lines) and provides helpers to read/modify the node tree without
 * needing to understand every possible resource type.
 */

export interface TscnBlock {
  tag: string; // "gd_scene" | "ext_resource" | "sub_resource" | "node" | "connection" | ...
  attrs: Record<string, string>; // raw string values, quotes stripped where present
  attrOrder: string[]; // preserve attribute order for stable output
  body: string[]; // raw property lines, kept verbatim
}

export interface TscnFile {
  blocks: TscnBlock[];
}

export interface SceneNode {
  name: string;
  type: string;
  parent: string | null; // null only for the root node
  path: string; // "." for root, "A/B" for nested
  instance?: string; // ext_resource id if this node is an instanced scene
  properties: Record<string, string>; // raw rhs strings, e.g. `Vector2(0, 0)`
}

const HEADER_RE = /^\[(\w+)(.*)\]\s*$/;
const ATTR_RE = /(\w+)=("(?:[^"\\]|\\.)*"|-?[\w./:]+)/g;

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

function quoteIfNeeded(v: string): string {
  // Already-quoted values pass through; bare tokens (numbers, res:// paths
  // without spaces) are still quoted because Godot expects string attrs
  // quoted except for numeric ones like load_steps=2 / format=3.
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (v.startsWith('"')) return v;
  return `"${v}"`;
}

export function parseTscn(text: string): TscnFile {
  const lines = text.split(/\r?\n/);
  const blocks: TscnBlock[] = [];
  let current: TscnBlock | null = null;

  for (const line of lines) {
    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch) {
      if (current) blocks.push(current);
      const tag = headerMatch[1];
      const attrs: Record<string, string> = {};
      const attrOrder: string[] = [];
      let m: RegExpExecArray | null;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(headerMatch[2]))) {
        attrs[m[1]] = unquote(m[2]);
        attrOrder.push(m[1]);
      }
      current = { tag, attrs, attrOrder, body: [] };
    } else if (current) {
      current.body.push(line);
    }
    // Lines before the first header (rare) are dropped; .tscn files always
    // start with [gd_scene ...].
  }
  if (current) blocks.push(current);
  return { blocks };
}

export function serializeTscn(file: TscnFile): string {
  const out: string[] = [];
  for (const block of file.blocks) {
    const attrStr = block.attrOrder
      .map((k) => `${k}=${quoteIfNeeded(block.attrs[k])}`)
      .join(" ");
    out.push(attrStr ? `[${block.tag} ${attrStr}]` : `[${block.tag}]`);
    // trim trailing blank lines within a block's body, we re-add one blank
    // separator line between blocks below
    let body = block.body;
    while (body.length && body[body.length - 1].trim() === "") {
      body = body.slice(0, -1);
    }
    out.push(...body);
    out.push("");
  }
  // collapse the trailing blank line duplication and ensure single newline EOF
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function nodePath(name: string, parent: string | null | undefined): string {
  if (parent === undefined || parent === null) return "."; // root
  if (parent === ".") return name;
  return `${parent}/${name}`;
}

export function getSceneTree(file: TscnFile): SceneNode[] {
  const nodes: SceneNode[] = [];
  for (const block of file.blocks) {
    if (block.tag !== "node") continue;
    const name = block.attrs.name ?? "(unnamed)";
    const parent = block.attrs.parent ?? null;
    const properties: Record<string, string> = {};
    for (const line of block.body) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) properties[key] = val;
    }
    nodes.push({
      name,
      type: block.attrs.type ?? "(instance)",
      parent,
      path: nodePath(name, parent),
      instance: block.attrs.instance,
      properties,
    });
  }
  return nodes;
}

export interface NewNodeSpec {
  name: string;
  type: string;
  parentPath: string; // "." for a child of the root
  properties?: Record<string, string>; // rhs values, e.g. { "position": "Vector2(10, 20)" }
  scriptExtResourceId?: string; // if set, adds `script = ExtResource("<id>")`
}

/** Adds a new [node] block. Mutates and returns the same TscnFile. */
export function addNode(file: TscnFile, spec: NewNodeSpec): TscnFile {
  const existing = getSceneTree(file);
  if (spec.parentPath !== "." && !existing.some((n) => n.path === spec.parentPath)) {
    throw new Error(
      `Parent path "${spec.parentPath}" not found in scene. Known node paths: ${existing
        .map((n) => n.path)
        .join(", ")}`
    );
  }
  if (existing.some((n) => n.path === nodePath(spec.name, spec.parentPath))) {
    throw new Error(`A node already exists at path "${nodePath(spec.name, spec.parentPath)}"`);
  }

  const attrs: Record<string, string> = { name: spec.name, type: spec.type };
  const attrOrder = ["name", "type"];
  if (spec.parentPath !== undefined) {
    attrs.parent = spec.parentPath;
    attrOrder.push("parent");
  }

  const body: string[] = [];
  if (spec.scriptExtResourceId) {
    body.push(`script = ExtResource("${spec.scriptExtResourceId}")`);
  }
  for (const [k, v] of Object.entries(spec.properties ?? {})) {
    body.push(`${k} = ${v}`);
  }

  file.blocks.push({ tag: "node", attrs, attrOrder, body });
  return file;
}

/** Removes a node (and, since Godot scenes are flat lists keyed by parent
 * path, any blocks whose parent path is at or under the removed node). */
export function removeNode(file: TscnFile, path: string): TscnFile {
  const tree = getSceneTree(file);
  const toRemove = new Set(
    tree.filter((n) => n.path === path || n.path.startsWith(path + "/")).map((n) => n.path)
  );
  if (toRemove.size === 0) {
    throw new Error(`No node found at path "${path}"`);
  }
  file.blocks = file.blocks.filter((b) => {
    if (b.tag !== "node") return true;
    const name = b.attrs.name ?? "";
    const parent = b.attrs.parent ?? null;
    const p = nodePath(name, parent);
    return !toRemove.has(p);
  });
  return file;
}

/** Sets/overwrites properties on an existing node, given its path. */
export function setNodeProperties(
  file: TscnFile,
  path: string,
  properties: Record<string, string>
): TscnFile {
  const block = file.blocks.find((b) => {
    if (b.tag !== "node") return false;
    const name = b.attrs.name ?? "";
    const parent = b.attrs.parent ?? null;
    return nodePath(name, parent) === path;
  });
  if (!block) throw new Error(`No node found at path "${path}"`);

  for (const [key, value] of Object.entries(properties)) {
    const idx = block.body.findIndex((line) => line.trim().startsWith(`${key} =`) || line.trim().startsWith(`${key}=`));
    const line = `${key} = ${value}`;
    if (idx >= 0) block.body[idx] = line;
    else block.body.push(line);
  }
  return file;
}

/** Finds the next free ext_resource id numeric prefix, mirroring Godot's
 * own "N_hash" id convention closely enough to avoid collisions. */
export function nextExtResourceId(file: TscnFile): string {
  let max = 0;
  for (const b of file.blocks) {
    if (b.tag !== "ext_resource" && b.tag !== "sub_resource") continue;
    const id = b.attrs.id ?? "";
    const m = /^(\d+)_/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const n = max + 1;
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${n}_${suffix}`;
}

export function addExtResource(
  file: TscnFile,
  type: string,
  path: string,
  id?: string
): string {
  const resId = id ?? nextExtResourceId(file);
  // ext_resource blocks must come after [gd_scene] and before [node] blocks
  // by convention; we insert right after the last existing ext_resource /
  // gd_scene block to keep things tidy.
  let insertAt = 1;
  for (let i = 0; i < file.blocks.length; i++) {
    if (file.blocks[i].tag === "ext_resource" || file.blocks[i].tag === "gd_scene") {
      insertAt = i + 1;
    }
  }
  file.blocks.splice(insertAt, 0, {
    tag: "ext_resource",
    attrs: { type, path, id: resId },
    attrOrder: ["type", "path", "id"],
    body: [],
  });
  // bump load_steps on the gd_scene header if present
  const gdScene = file.blocks.find((b) => b.tag === "gd_scene");
  if (gdScene && gdScene.attrs.load_steps) {
    const n = parseInt(gdScene.attrs.load_steps, 10);
    if (!Number.isNaN(n)) gdScene.attrs.load_steps = String(n + 1);
  }
  return resId;
}

export function createEmptyScene(rootName: string, rootType: string): TscnFile {
  return {
    blocks: [
      {
        tag: "gd_scene",
        attrs: { load_steps: "1", format: "3" },
        attrOrder: ["load_steps", "format"],
        body: [],
      },
      {
        tag: "node",
        attrs: { name: rootName, type: rootType },
        attrOrder: ["name", "type"],
        body: [],
      },
    ],
  };
}
