import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTscn,
  serializeTscn,
  getSceneTree,
  addNode,
  removeNode,
  setNodeProperties,
  addExtResource,
  createEmptyScene,
} from "../dist/tscn.js";

// Formatted the way Godot 4 writes it: contiguous ext_resources, instanced
// node, a groups array in a header, and [connection] blocks at the end.
const GODOT_SCENE = `[gd_scene load_steps=3 format=3 uid="uid://c8j2k3l4m5n6p"]

[ext_resource type="PackedScene" uid="uid://bq1x" path="res://scenes/Coin.tscn" id="2_coin"]
[ext_resource type="Script" path="res://scripts/player.gd" id="1_abcde"]

[node name="World" type="Node2D"]

[node name="Coin1" parent="." instance=ExtResource("2_coin")]
position = Vector2(5, 5)

[node name="Hud" type="Control" parent="." groups=["ui", "hud"]]
layout_mode = 3

[node name="Label" type="Label" parent="Hud"]
text = "Score: 0"

[connection signal="body_entered" from="Coin1" to="." method="_on_coin"]
[connection signal="ready" from="Hud/Label" to="." method="_on_label"]
`;

const roundTrip = (text) => serializeTscn(parseTscn(text));

test("an untouched Godot scene round-trips byte for byte", () => {
  assert.equal(roundTrip(GODOT_SCENE), GODOT_SCENE);
});

test("CRLF line endings are preserved", () => {
  const crlf = GODOT_SCENE.replace(/\n/g, "\r\n");
  assert.equal(roundTrip(crlf), crlf);
});

test("numeric-looking quoted values stay quoted", () => {
  const scene = `[gd_scene format=3]\n\n[node name="123" type="Node"]\n`;
  assert.equal(roundTrip(scene), scene);
});

test("instanced nodes and header groups survive parsing", () => {
  const nodes = getSceneTree(parseTscn(GODOT_SCENE));
  const coin = nodes.find((n) => n.name === "Coin1");
  assert.equal(coin.instance, 'ExtResource("2_coin")');
  assert.equal(coin.type, "(instance)");
  assert.deepEqual(
    nodes.map((n) => n.path),
    [".", "Coin1", "Hud", "Hud/Label"]
  );
});

test("editing one property leaves the rest of the file untouched", () => {
  const file = parseTscn(GODOT_SCENE);
  setNodeProperties(file, "Hud", { visible: "false" });
  assert.equal(
    serializeTscn(file),
    GODOT_SCENE.replace("layout_mode = 3\n", "layout_mode = 3\nvisible = false\n")
  );
});

test("setNodeProperties replaces an existing property in place", () => {
  const file = parseTscn(GODOT_SCENE);
  setNodeProperties(file, "Coin1", { position: "Vector2(9, 9)" });
  const out = serializeTscn(file);
  assert.match(out, /position = Vector2\(9, 9\)/);
  assert.doesNotMatch(out, /Vector2\(5, 5\)/);
});

test("addNode inserts before [connection] blocks and keeps existing nodes intact", () => {
  const file = parseTscn(GODOT_SCENE);
  addNode(file, { name: "Coin2", type: "Area2D", parentPath: ".", properties: { position: "Vector2(1, 2)" } });
  const out = serializeTscn(file);
  assert.ok(out.indexOf('[node name="Coin2"') < out.indexOf("[connection"));
  assert.ok(out.includes('instance=ExtResource("2_coin")'));
  assert.ok(out.includes('groups=["ui", "hud"]'));
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
});

test("addNode appends cleanly to a freshly created scene", () => {
  const file = createEmptyScene("Root", "Node2D");
  addNode(file, { name: "Child", type: "Sprite2D", parentPath: "." });
  addNode(file, { name: "Grandchild", type: "Node", parentPath: "Child" });
  assert.equal(
    serializeTscn(file),
    `[gd_scene load_steps=1 format=3]\n\n[node name="Root" type="Node2D"]\n\n` +
      `[node name="Child" type="Sprite2D" parent="."]\n\n[node name="Grandchild" type="Node" parent="Child"]\n`
  );
});

test("addNode rejects bad names, bad types, missing parents and duplicates", () => {
  const file = parseTscn(GODOT_SCENE);
  assert.throws(() => addNode(file, { name: "a/b", type: "Node", parentPath: "." }), /Invalid node name/);
  assert.throws(() => addNode(file, { name: "", type: "Node", parentPath: "." }), /Invalid node name/);
  assert.throws(() => addNode(file, { name: "X", type: 'Node"', parentPath: "." }), /Invalid node type/);
  assert.throws(() => addNode(file, { name: "X", type: "Node", parentPath: "Nope" }), /not found/);
  assert.throws(() => addNode(file, { name: "Hud", type: "Node", parentPath: "." }), /already exists/);
});

test("addExtResource keeps ext_resources contiguous, reuses duplicates and bumps load_steps once", () => {
  const file = parseTscn(GODOT_SCENE);
  const id = addExtResource(file, "Script", "res://scripts/enemy.gd");
  assert.equal(addExtResource(file, "Script", "res://scripts/enemy.gd"), id);
  assert.equal(addExtResource(file, "Script", "res://scripts/player.gd"), "1_abcde");

  const out = serializeTscn(file);
  assert.match(out, /load_steps=4 /);
  assert.ok(
    out.includes(
      `path="res://scripts/player.gd" id="1_abcde"]\n[ext_resource type="Script" path="res://scripts/enemy.gd" id="${id}"]\n\n[node`
    )
  );
});

test("removeNode removes descendants and the connections that pointed at them", () => {
  const file = parseTscn(GODOT_SCENE);
  removeNode(file, "Hud");
  const out = serializeTscn(file);
  assert.doesNotMatch(out, /Hud|Label/);
  assert.match(out, /from="Coin1"/);
});

test("removeNode refuses the root and unknown paths", () => {
  const file = parseTscn(GODOT_SCENE);
  assert.throws(() => removeNode(file, "."), /root/);
  assert.throws(() => removeNode(file, "Nope"), /No node found/);
});
