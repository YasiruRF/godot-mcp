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
 * needing to understand every possible resource type. Anything it does not
 * understand (property bodies, header values like `groups=[...]`) is kept
 * verbatim, so parse -> serialize of an untouched file is lossless.
 */

export interface TscnBlock {
  tag: string; // "gd_scene" | "ext_resource" | "sub_resource" | "node" | "connection" | ...
  /**
   * Header attributes. Quoted values are stored without their quotes (escape
   * sequences left as written); bare values (`format=3`,
   * `instance=ExtResource("2_x")`, `groups=["a"]`) are stored as written.
   */
  attrs: Record<string, string>;
  attrOrder: string[]; // preserve attribute order for stable output
  /**
   * Keys of `attrs` that are written without surrounding quotes. When
   * undefined (blocks built in code) plain numbers are bare and everything
   * else is quoted.
   */
  bare?: string[];
  /**
   * Raw lines after the header, kept verbatim. Trailing blank lines are the
   * separator to the next block and belong to this block.
   */
  body: string[];
}

export interface TscnFile {
  blocks: TscnBlock[];
  eol?: string; // "\n" or "\r\n" as found in the source; defaults to "\n"
}

export interface SceneNode {
  name: string;
  type: string;
  parent: string | null; // null only for the root node
  path: string; // "." for root, "A/B" for nested
  instance?: string; // raw `ExtResource("id")` if this node is an instanced scene
  properties: Record<string, string>; // raw rhs strings, e.g. `Vector2(0, 0)`
}

const HEADER_RE = /^\[([a-z_]+)(\s.*)?\]\s*$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
// Godot forbids these in node names; "/" and "." would also corrupt our path model.
const BAD_NAME_RE = /[./:@"%\\]/;
const CLASS_NAME_RE = /^[A-Za-z_]\w*$/;

/** Splits the text after a tag into attributes, honouring quotes and brackets. */
function parseAttrs(s: string): { attrs: Record<string, string>; attrOrder: string[]; bare: string[] } {
  const attrs: Record<string, string> = {};
  const attrOrder: string[] = [];
  const bare: string[] = [];
  let i = 0;

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const key = /^[A-Za-z_]\w*/.exec(s.slice(i))?.[0];
    if (!key || s[i + key.length] !== "=") {
      i++;
      continue;
    }
    i += key.length + 1;

    let value: string;
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      value = s.slice(i + 1, j);
      i = j + 1;
    } else {
      let j = i;
      let depth = 0;
      let inStr = false;
      while (j < s.length) {
        const c = s[j];
        if (inStr) {
          if (c === "\\") j++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (/\s/.test(c) && depth <= 0) break;
        j++;
      }
      value = s.slice(i, j);
      i = j;
      bare.push(key);
    }
    attrs[key] = value;
    attrOrder.push(key);
  }
  return { attrs, attrOrder, bare };
}

function formatAttr(block: TscnBlock, key: string): string {
  const v = block.attrs[key];
  const isBare = block.bare ? block.bare.includes(key) : NUMBER_RE.test(v);
  return `${key}=${isBare ? v : `"${v}"`}`;
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

export function parseTscn(text: string): TscnFile {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop(); // the newline that ends the file
  const blocks: TscnBlock[] = [];
  let current: TscnBlock | null = null;

  for (const line of lines) {
    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch) {
      if (current) blocks.push(current);
      current = { tag: headerMatch[1], ...parseAttrs(headerMatch[2] ?? ""), body: [] };
    } else if (current) {
      current.body.push(line);
    }
    // Lines before the first header (rare) are dropped; .tscn files always
    // start with [gd_scene ...].
  }
  if (current) blocks.push(current);
  return { blocks, eol };
}

export function serializeTscn(file: TscnFile): string {
  const eol = file.eol ?? "\n";
  const out: string[] = [];
  for (const block of file.blocks) {
    const attrStr = block.attrOrder.map((k) => formatAttr(block, k)).join(" ");
    out.push(attrStr ? `[${block.tag} ${attrStr}]` : `[${block.tag}]`);
    out.push(...block.body);
  }
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out.join(eol) + eol;
}

function nodePath(name: string, parent: string | null | undefined): string {
  if (parent === undefined || parent === null) return "."; // root
  if (parent === ".") return name;
  return `${parent}/${name}`;
}

function blockNodePath(b: TscnBlock): string {
  return nodePath(b.attrs.name ?? "", b.attrs.parent ?? null);
}

function assertNodeName(name: string): void {
  if (!name || BAD_NAME_RE.test(name)) {
    throw new Error(`Invalid node name "${name}": must be non-empty and not contain any of . / : @ " % \\`);
  }
}

function assertClassName(type: string): void {
  if (!CLASS_NAME_RE.test(type)) {
    throw new Error(`Invalid node type "${type}": expected a Godot class name such as "Node2D"`);
  }
}

export function getSceneTree(file: TscnFile): SceneNode[] {
  const nodes: SceneNode[] = [];
  for (const block of file.blocks) {
    if (block.tag !== "node") continue;
    const name = block.attrs.name ?? "(unnamed)";
    const parent = block.attrs.parent ?? null;
    const properties: Record<string, string> = {};
    for (const line of block.body) {
      if (line.trimStart().startsWith(";")) continue;
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

/** Adds a new [node] block after the last existing one. Mutates and returns the same TscnFile. */
export function addNode(file: TscnFile, spec: NewNodeSpec): TscnFile {
  assertNodeName(spec.name);
  assertClassName(spec.type);
  const existing = getSceneTree(file);
  if (spec.parentPath !== "." && !existing.some((n) => n.path === spec.parentPath)) {
    throw new Error(
      `Parent path "${spec.parentPath}" not found in scene. Known node paths: ${existing
        .map((n) => n.path)
        .join(", ")}`
    );
  }
  const newPath = nodePath(spec.name, spec.parentPath);
  if (existing.some((n) => n.path === newPath)) {
    throw new Error(`A node already exists at path "${newPath}"`);
  }

  const body: string[] = [];
  if (spec.scriptExtResourceId) {
    body.push(`script = ExtResource("${spec.scriptExtResourceId}")`);
  }
  for (const [k, v] of Object.entries(spec.properties ?? {})) {
    body.push(`${k} = ${v}`);
  }
  body.push("");

  const block: TscnBlock = {
    tag: "node",
    attrs: { name: spec.name, type: spec.type, parent: spec.parentPath },
    attrOrder: ["name", "type", "parent"],
    bare: [],
    body,
  };

  // Godot writes every [node] before any [connection]/[editable] block.
  let insertAt = file.blocks.length;
  for (let i = file.blocks.length - 1; i >= 0; i--) {
    if (file.blocks[i].tag === "node") {
      insertAt = i + 1;
      break;
    }
  }
  const prev = file.blocks[insertAt - 1];
  if (prev && !isBlank(prev.body[prev.body.length - 1])) prev.body.push("");
  file.blocks.splice(insertAt, 0, block);
  return file;
}

/** Removes a node (and, since Godot scenes are flat lists keyed by parent
 * path, any blocks whose parent path is at or under the removed node), plus
 * any [connection] / [editable] blocks that pointed at the removed nodes. */
export function removeNode(file: TscnFile, path: string): TscnFile {
  if (path === ".") {
    throw new Error("Cannot remove the scene root; delete the .tscn file instead");
  }
  const tree = getSceneTree(file);
  const toRemove = new Set(
    tree.filter((n) => n.path === path || n.path.startsWith(path + "/")).map((n) => n.path)
  );
  if (toRemove.size === 0) {
    throw new Error(`No node found at path "${path}"`);
  }
  file.blocks = file.blocks.filter((b) => {
    if (b.tag === "node") return !toRemove.has(blockNodePath(b));
    if (b.tag === "connection") return !toRemove.has(b.attrs.from) && !toRemove.has(b.attrs.to);
    if (b.tag === "editable") return !toRemove.has(b.attrs.path);
    return true;
  });
  return file;
}

/** Sets/overwrites properties on an existing node, given its path. */
export function setNodeProperties(
  file: TscnFile,
  path: string,
  properties: Record<string, string>
): TscnFile {
  const block = file.blocks.find((b) => b.tag === "node" && blockNodePath(b) === path);
  if (!block) throw new Error(`No node found at path "${path}"`);

  for (const [key, value] of Object.entries(properties)) {
    const idx = block.body.findIndex((line) => line.trim().startsWith(`${key} =`) || line.trim().startsWith(`${key}=`));
    const line = `${key} = ${value}`;
    if (idx >= 0) {
      block.body[idx] = line;
    } else {
      // keep the trailing blank separator line last
      let end = block.body.length;
      while (end > 0 && isBlank(block.body[end - 1])) end--;
      block.body.splice(end, 0, line);
    }
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

/** Registers an [ext_resource], reusing an existing one for the same type+path. Returns its id. */
export function addExtResource(
  file: TscnFile,
  type: string,
  path: string,
  id?: string
): string {
  if (/["\\]/.test(path) || /["\\]/.test(type)) {
    throw new Error(`Invalid resource path "${path}"`);
  }
  const existing = file.blocks.find(
    (b) => b.tag === "ext_resource" && b.attrs.type === type && b.attrs.path === path
  );
  if (existing && existing.attrs.id) return existing.attrs.id;

  const resId = id ?? nextExtResourceId(file);
  // ext_resource blocks come after [gd_scene] and before everything else;
  // insert right after the last existing ext_resource / gd_scene block.
  let insertAt = 1;
  for (let i = 0; i < file.blocks.length; i++) {
    if (file.blocks[i].tag === "ext_resource" || file.blocks[i].tag === "gd_scene") {
      insertAt = i + 1;
    }
  }
  // Godot keeps ext_resource lines contiguous, so hand the blank separator
  // over to the new block instead of leaving one between them.
  const prev = file.blocks[insertAt - 1];
  const body: string[] = [];
  if (prev && prev.tag === "ext_resource") {
    while (isBlank(prev.body[prev.body.length - 1])) body.unshift(prev.body.pop()!);
  }
  if (!body.length) body.push("");

  file.blocks.splice(insertAt, 0, {
    tag: "ext_resource",
    attrs: { type, path, id: resId },
    attrOrder: ["type", "path", "id"],
    bare: [],
    body,
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
  assertNodeName(rootName);
  assertClassName(rootType);
  return {
    blocks: [
      {
        tag: "gd_scene",
        attrs: { load_steps: "1", format: "3" },
        attrOrder: ["load_steps", "format"],
        bare: ["load_steps", "format"],
        body: [""],
      },
      {
        tag: "node",
        attrs: { name: rootName, type: rootType },
        attrOrder: ["name", "type"],
        bare: [],
        body: [],
      },
    ],
  };
}
