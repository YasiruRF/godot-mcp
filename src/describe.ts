/**
 * Plain-language descriptions of edits, in Godot's vocabulary (nodes, properties, shapes), including
 * what the edit is for when that can be said truthfully from the node type alone.
 */

const ROLES: Record<string, string> = {
  CollisionShape2D: "a collision shape; it only takes part in collisions once its shape property is set",
  CollisionShape3D: "a collision shape; it only takes part in collisions once its shape property is set",
  CharacterBody2D: "a body you move from code and that still collides (call move_and_slide() in the script)",
  CharacterBody3D: "a body you move from code and that still collides (call move_and_slide() in the script)",
  RigidBody2D: "a body the physics engine moves",
  RigidBody3D: "a body the physics engine moves",
  StaticBody2D: "a body that never moves but other bodies collide with",
  StaticBody3D: "a body that never moves but other bodies collide with",
  Area2D: "a zone that notices bodies entering it without blocking them (it needs a collision shape)",
  Area3D: "a zone that notices bodies entering it without blocking them (it needs a collision shape)",
  MeshInstance3D: "a visible 3D shape, which needs a mesh to show anything",
  Sprite2D: "a 2D image, which needs a texture to show anything",
  Camera2D: "the view into a 2D scene",
  Camera3D: "the view into a 3D scene",
  Timer: "a countdown that fires its timeout signal",
};

const MAX_PROPS_SHOWN = 3;

function quote(s: string): string {
  return `\`${s}\``;
}

function where(parentPath: string): string {
  return parentPath === "." || parentPath === "" ? "the scene root" : quote(parentPath);
}

function listProps(properties: Record<string, string> | undefined): string {
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) return "";
  const shown = entries.slice(0, MAX_PROPS_SHOWN).map(([k, v]) => `${k} = ${v}`);
  const more = entries.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

export function describeAdd(a: {
  name: string;
  type: string;
  parentPath: string;
  properties?: Record<string, string>;
  scriptPath?: string;
}): string {
  let s = `Added a ${quote(a.type)} named ${quote(a.name)} under ${where(a.parentPath)}`;
  const props = listProps(a.properties);
  if (props) s += ` (${props})`;
  if (a.scriptPath) s += `, running ${quote(a.scriptPath)}`;
  s += ".";
  const role = ROLES[a.type];
  if (role) s += ` ${a.type} is ${role}.`;
  return s;
}

export function describeSet(nodePath: string, properties: Record<string, string>): string {
  const target = nodePath === "." ? "the scene root" : quote(nodePath);
  return `Set ${listProps(properties)} on ${target}.`;
}

export function describeRemove(nodePath: string, alsoConnections: boolean): string {
  return (
    `Removed ${quote(nodePath)} and everything under it` +
    (alsoConnections ? ", along with any signal connections that pointed at them." : ".")
  );
}
