@tool
extends EditorPlugin

## Godot MCP Bridge — companion plugin for the godot-mcp MCP server.
##
## While the editor is open with this plugin enabled, it listens on
## ws://127.0.0.1:9080 for JSON messages from the godot-mcp Node.js MCP
## server and executes editor commands. Scene edits (add_node, set_properties,
## remove_node) are applied to the scene open in the editor through the
## editor's undo/redo system, so they appear live and Ctrl+Z reverts them.
##
## Protocol: each message is a JSON object {"id": <int>, "command": <string>,
## "args": {...}}. Each reply is {"id": <int>, "ok": <bool>, "result": <any>,
## "error": <string|null>}.

const PORT := 9080
const BAD_NAME_CHARS := ".:@/\"%"
## A batch with no edits for this long is closed (committed as one undo step) on its own, so a
## client that crashes mid-task can never leave the undo history open.
const BATCH_IDLE_MSEC := 120000

## Every request must carry the token written to ~/.godot-mcp/bridge-token when the plugin
## starts. A web page or another user's process can open the socket but cannot read that file.
var _token := ""
var _token_file := ""

var _tcp_server := TCPServer.new()
var _peers: Array = []

# Batch state (see begin_batch / end_batch). While a batch is open, edits are applied to the
# scene immediately, as usual, but recorded instead of each becoming its own undo entry; closing
# the batch registers them all as ONE undo action.
var _batch_open := false
var _batch_label := ""
var _batch_ops: Array = []
var _batch_root_id := 0
var _batch_last_msec := 0

func _enter_tree() -> void:
	_write_token()
	var err := _tcp_server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_warning("godot_mcp_bridge: failed to listen on 127.0.0.1:%d (error %d). Is another instance already running?" % [PORT, err])
	else:
		print("godot_mcp_bridge: listening on ws://127.0.0.1:%d" % PORT)

func _exit_tree() -> void:
	_close_batch()
	for p in _peers:
		(p["ws"] as WebSocketPeer).close()
	_peers.clear()
	_tcp_server.stop()
	if _token_file != "" and FileAccess.file_exists(_token_file):
		DirAccess.remove_absolute(_token_file)

func _process(_delta: float) -> void:
	if _batch_open and Time.get_ticks_msec() - _batch_last_msec > BATCH_IDLE_MSEC:
		_close_batch()

	while _tcp_server.is_connection_available():
		var tcp := _tcp_server.take_connection()
		var ws := WebSocketPeer.new()
		ws.accept_stream(tcp)
		_peers.append({"ws": ws})

	for i in range(_peers.size() - 1, -1, -1):
		var ws: WebSocketPeer = _peers[i]["ws"]
		ws.poll()
		var state := ws.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			while ws.get_available_packet_count() > 0:
				var packet := ws.get_packet()
				_handle_message(ws, packet.get_string_from_utf8())
		elif state == WebSocketPeer.STATE_CLOSED:
			_peers.remove_at(i)

func _handle_message(ws: WebSocketPeer, raw: String) -> void:
	var data = JSON.parse_string(raw)
	if typeof(data) != TYPE_DICTIONARY:
		_reply(ws, null, _fail("invalid JSON message"))
		return

	if _token == "" or str(data.get("token", "")) != _token:
		_reply(ws, data.get("id"), _fail("unauthorized: missing or wrong token (the godot-mcp server reads it from %s; restart the MCP server if you just restarted Godot)" % _token_file))
		return

	var args = data.get("args", {})
	if typeof(args) != TYPE_DICTIONARY:
		args = {}
	_reply(ws, data.get("id"), _dispatch(str(data.get("command", "")), args))

func _dispatch(command: String, args: Dictionary) -> Dictionary:
	match command:
		"ping":
			return _ok({"status": "alive", "editor": "godot-mcp-bridge", "godot_version": Engine.get_version_info()})
		"run_scene":
			var scene_path := _to_res_path(str(args.get("scene_path", "")))
			if scene_path == "":
				return _fail("scene_path is required")
			EditorInterface.play_custom_scene(scene_path)
			return _ok({"playing": scene_path})
		"stop":
			EditorInterface.stop_playing_scene()
			return _ok({"stopped": true})
		"get_selection":
			var names := []
			for n in EditorInterface.get_selection().get_selected_nodes():
				names.append(str(n.get_path()))
			return _ok({"selected": names})
		"get_open_scenes":
			return _ok({
				"project_path": ProjectSettings.globalize_path("res://"),
				"open": _open_scenes(),
				"current": _current_scene_path(),
			})
		"get_scene_tree":
			return _cmd_get_scene_tree()
		"open_scene":
			return _cmd_open_scene(args)
		"add_node":
			return _cmd_add_node(args)
		"set_properties":
			return _cmd_set_properties(args)
		"remove_node":
			return _cmd_remove_node(args)
		"save_scene":
			return _cmd_save_scene()
		_:
			return _fail("unknown command: %s" % command)

# ---------------------------------------------------------------------------
# Live scene editing (all changes go through the editor's undo/redo)
# ---------------------------------------------------------------------------

func _cmd_get_scene_tree() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return _fail("no scene is open in the editor — use editor_open_scene first")
	return _ok({
		"scene": root.scene_file_path,
		"open_scenes": _open_scenes(),
		"tree": _describe(root, root),
	})

func _cmd_open_scene(args: Dictionary) -> Dictionary:
	var path := _to_res_path(str(args.get("scene_path", "")))
	if path == "":
		return _fail("scene_path is required")
	if not ResourceLoader.exists(path):
		return _fail("scene not found: %s" % path)
	EditorInterface.open_scene_from_path(path)
	return _ok({"opened": path})

func _cmd_add_node(args: Dictionary) -> Dictionary:
	var scene_err := _scene_error(args)
	if scene_err != "":
		return _fail(scene_err)
	var root := EditorInterface.get_edited_scene_root()

	var parent_path := str(args.get("parent_path", "."))
	var node_name := str(args.get("name", ""))
	var node_type := str(args.get("type", ""))

	var parent := _find_node(root, parent_path)
	if parent == null:
		return _fail("parent node '%s' not found in the open scene" % parent_path)
	if node_name == "" or _has_bad_chars(node_name):
		return _fail("invalid node name '%s' (must be non-empty and not contain any of %s)" % [node_name, BAD_NAME_CHARS])
	if parent.has_node(NodePath(node_name)):
		return _fail("a node named '%s' already exists under '%s'" % [node_name, parent_path])
	if not (ClassDB.class_exists(node_type) and ClassDB.is_parent_class(node_type, "Node") and ClassDB.can_instantiate(node_type)):
		return _fail("'%s' is not an instantiable Node class" % node_type)

	var node := ClassDB.instantiate(node_type) as Node
	node.name = node_name

	var script_path := str(args.get("script_path", ""))
	if script_path != "":
		var script = load(_to_res_path(script_path))
		if not (script is Script):
			node.free()
			return _fail("script not found or not a script: %s" % script_path)
		node.set_script(script)

	var props = args.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		var prop_err := _apply_properties(node, props)
		if prop_err != "":
			node.free()
			return _fail(prop_err)

	_run_op("MCP: add %s" % node_name, root, {
		"do": [[parent, "add_child", node, true], [node, "set_owner", root]],
		"undo": [[parent, "remove_child", node]],
		"do_refs": [node],
		"undo_refs": [],
	})

	_select_only(node)  # so the edit is visible in the Scene and Inspector docks
	return _ok({"added": str(root.get_path_to(node)), "type": node_type})

func _cmd_set_properties(args: Dictionary) -> Dictionary:
	var scene_err := _scene_error(args)
	if scene_err != "":
		return _fail(scene_err)
	var root := EditorInterface.get_edited_scene_root()

	var node_path := str(args.get("node_path", "."))
	var node := _find_node(root, node_path)
	if node == null:
		return _fail("node '%s' not found in the open scene" % node_path)
	var props = args.get("properties", {})
	if typeof(props) != TYPE_DICTIONARY or props.is_empty():
		return _fail("properties is required")

	# validate and parse everything first so nothing is half-applied
	var keys: Array = []
	var new_values: Array = []
	for key in props:
		var prop_key := str(key)
		if not _has_property(node, prop_key):
			return _fail("node '%s' (%s) has no property '%s'" % [node_path, node.get_class(), prop_key])
		var parsed := _parse_value(str(props[key]))
		if parsed["error"] != "":
			return _fail("property '%s': %s" % [prop_key, parsed["error"]])
		keys.append(prop_key)
		new_values.append(parsed["value"])

	var do_calls: Array = []
	var undo_calls: Array = []
	for i in keys.size():
		var path := NodePath(keys[i])
		do_calls.append([node, "set_indexed", path, new_values[i]])
		undo_calls.append([node, "set_indexed", path, node.get_indexed(path)])
	_run_op("MCP: set properties on %s" % node.name, root, {
		"do": do_calls, "undo": undo_calls, "do_refs": [], "undo_refs": [],
	})

	_select_only(node)
	return _ok({"updated": node_path, "properties": keys})

func _cmd_remove_node(args: Dictionary) -> Dictionary:
	var scene_err := _scene_error(args)
	if scene_err != "":
		return _fail(scene_err)
	var root := EditorInterface.get_edited_scene_root()

	var node_path := str(args.get("node_path", ""))
	if node_path == "" or node_path == ".":
		return _fail("cannot remove the scene root")
	var node := _find_node(root, node_path)
	if node == null:
		return _fail("node '%s' not found in the open scene" % node_path)

	var parent := node.get_parent()
	var index := node.get_index()
	var undo_calls: Array = [[parent, "add_child", node, true], [parent, "move_child", node, index]]
	for owned in _owned_nodes(node, root):
		undo_calls.append([owned, "set_owner", root])
	_run_op("MCP: remove %s" % node.name, root, {
		"do": [[parent, "remove_child", node]],
		"undo": undo_calls,
		"do_refs": [],
		"undo_refs": [node],
	})
	return _ok({"removed": node_path})

func _cmd_save_scene() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return _fail("no scene is open in the editor")
	if root.scene_file_path == "":
		return _fail("this scene has never been saved — save it once in the editor (Scene > Save Scene As...)")
	var err := EditorInterface.save_scene()
	if err != OK:
		return _fail("save failed (error %d)" % err)
	return _ok({"saved": root.scene_file_path})

# ---------------------------------------------------------------------------
# Undo batching: one agent task = one undo step
# ---------------------------------------------------------------------------

func _cmd_begin_batch(args: Dictionary) -> Dictionary:
	if _batch_open:
		return _fail("a batch is already open (\"%s\") — close it with end_batch first" % _batch_label)
	var label := str(args.get("label", "")).strip_edges()
	_batch_label = label if label != "" else "agent task"
	_batch_open = true
	_batch_ops = []
	_batch_root_id = 0
	_batch_last_msec = Time.get_ticks_msec()
	return _ok({"batch": _batch_label})

func _cmd_end_batch() -> Dictionary:
	if not _batch_open:
		return _ok({"batch": null, "operations": 0})
	var label := _batch_label
	var count := _batch_ops.size()
	_close_batch()
	return _ok({"batch": label, "operations": count})

## Registers every recorded edit as a single undo action and closes the batch. The edits are
## already applied, so the action is committed without executing them again.
func _close_batch() -> void:
	if not _batch_open:
		return
	_batch_open = false
	var ops := _batch_ops
	_batch_ops = []
	if ops.is_empty():
		return
	var root = instance_from_id(_batch_root_id)
	var ur := get_undo_redo()
	ur.create_action("Claude: %s" % _batch_label, UndoRedo.MERGE_DISABLE, root)
	for op in ops:
		_add_calls(ur, op["do"], true)
		for ref in op["do_refs"]:
			ur.add_do_reference(ref)
	# undo runs in the order the calls were added, so add the newest edit's undo first
	for i in range(ops.size() - 1, -1, -1):
		_add_calls(ur, ops[i]["undo"], false)
		for ref in ops[i]["undo_refs"]:
			ur.add_undo_reference(ref)
	ur.commit_action(false)

## An op is {"do": [[object, method, args...]], "undo": [...], "do_refs": [objects], "undo_refs": [objects]}.
## Outside a batch it becomes its own undo action; inside one it is applied now and recorded.
func _run_op(action_name: String, root: Node, op: Dictionary) -> void:
	if _batch_open:
		_batch_root_id = root.get_instance_id()
		_batch_last_msec = Time.get_ticks_msec()
		for c in op["do"]:
			(c[0] as Object).callv(c[1], (c as Array).slice(2))
		_batch_ops.append(op)
		return
	var ur := get_undo_redo()
	ur.create_action(action_name, UndoRedo.MERGE_DISABLE, root)
	_add_calls(ur, op["do"], true)
	for ref in op["do_refs"]:
		ur.add_do_reference(ref)
	_add_calls(ur, op["undo"], false)
	for ref in op["undo_refs"]:
		ur.add_undo_reference(ref)
	ur.commit_action()

func _add_calls(ur: EditorUndoRedoManager, calls: Array, is_do: bool) -> void:
	for c in calls:
		var head: Array = [c[0], c[1]]
		var rest: Array = (c as Array).slice(2)
		if is_do:
			ur.callv("add_do_method", head + rest)
		else:
			ur.callv("add_undo_method", head + rest)

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

func _write_token() -> void:
	_token = Crypto.new().generate_random_bytes(24).hex_encode()
	var home := OS.get_environment("USERPROFILE") if OS.get_name() == "Windows" else OS.get_environment("HOME")
	if home == "":
		push_warning("godot_mcp_bridge: no home folder found, so no token can be shared; the bridge will refuse all requests")
		_token = ""
		return
	var dir := home.path_join(".godot-mcp")
	DirAccess.make_dir_recursive_absolute(dir)
	_token_file = dir.path_join("bridge-token")
	var f := FileAccess.open(_token_file, FileAccess.WRITE)
	if f == null:
		push_warning("godot_mcp_bridge: could not write %s (error %d); the bridge will refuse all requests" % [_token_file, FileAccess.get_open_error()])
		_token = ""
		return
	f.store_string(_token)
	f.close()
	FileAccess.set_unix_permissions(_token_file, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

func _select_only(node: Node) -> void:
	var selection := EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)

## Returns "" if the edit may proceed, otherwise why not. `scene_path` (optional)
## must match the scene currently being edited.
func _scene_error(args: Dictionary) -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return "no scene is open in the editor — use editor_open_scene first"
	if _batch_open and _batch_root_id != 0 and root.get_instance_id() != _batch_root_id:
		return "a batch (\"%s\") is open on another scene — call end_batch before switching scenes, so each undo step stays within one scene" % _batch_label
	var wanted := _to_res_path(str(args.get("scene_path", "")))
	if wanted != "" and wanted != root.scene_file_path:
		return "'%s' is not the scene currently being edited (that is '%s') — use editor_open_scene first" % [wanted, root.scene_file_path]
	return ""

func _to_res_path(path: String) -> String:
	if path == "":
		return path
	var res := path if path.begins_with("res://") else "res://" + path.trim_prefix("/")
	if res.contains(".."):
		return "res://__invalid_path__"  # never resolves to anything; keeps ".." out of load()
	return res

func _find_node(root: Node, path: String) -> Node:
	if path == "." or path == "":
		return root
	return root.get_node_or_null(NodePath(path))

func _has_bad_chars(s: String) -> bool:
	for c in BAD_NAME_CHARS:
		if s.contains(c):
			return true
	return false

## Properties that can't be set through the bridge: `script` would let a caller assign arbitrary
## code, so scripts are attached only through `script_path`, which loads an existing res:// file.
const FORBIDDEN_PROPERTIES := ["script"]

func _has_property(node: Object, key: String) -> bool:
	var head := key.split(":")[0]
	return (head in node) and not (head in FORBIDDEN_PROPERTIES)

func _open_scenes() -> Array:
	var scenes: Array = []
	for s in EditorInterface.get_open_scenes():
		scenes.append(s)
	return scenes

func _current_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root != null else ""

## Nodes in the subtree that are owned by the scene root (i.e. saved with it).
func _owned_nodes(node: Node, root: Node) -> Array:
	var out: Array = []
	if node.owner == root:
		out.append(node)
	for child in node.get_children():
		out.append_array(_owned_nodes(child, root))
	return out

func _describe(node: Node, root: Node) -> Dictionary:
	var children: Array = []
	for child in node.get_children():
		if child.owner == root:  # skip the internals of instanced scenes
			children.append(_describe(child, root))
	return {
		"name": str(node.name),
		"type": node.get_class(),
		"path": "." if node == root else str(root.get_path_to(node)),
		"children": children,
	}

func _apply_properties(node: Object, props: Dictionary) -> String:
	for key in props:
		var prop_key := str(key)
		if not _has_property(node, prop_key):
			return "%s has no property '%s'" % [node.get_class(), prop_key]
		var parsed := _parse_value(str(props[key]))
		if parsed["error"] != "":
			return "property '%s': %s" % [prop_key, parsed["error"]]
		node.set_indexed(NodePath(prop_key), parsed["value"])
	return ""

## Parses a property value written in Godot syntax: Vector2(1, 2), Color(1, 0, 0, 1),
## "text", true, 42 ... plus `ClassName.new()` for Resource properties such as a
## collision `shape`.
func _parse_value(text: String) -> Dictionary:
	var s := text.strip_edges()
	if s.contains("Object("):
		return {"value": null, "error": "Object(...) values are not allowed"}
	if s.ends_with(".new()"):
		var cls := s.trim_suffix(".new()")
		if ClassDB.class_exists(cls) and ClassDB.is_parent_class(cls, "Script"):
			return {"value": null, "error": "'%s' is a script class; attach scripts with script_path" % cls}
		if ClassDB.class_exists(cls) and ClassDB.is_parent_class(cls, "Resource") and ClassDB.can_instantiate(cls):
			return {"value": ClassDB.instantiate(cls), "error": ""}
		return {"value": null, "error": "'%s' is not an instantiable Resource class" % cls}
	var value = str_to_var(s)
	if value == null and s != "null":
		return {"value": null, "error": "could not parse '%s' as a Godot value (examples: Vector2(1, 2), Color(1, 0, 0, 1), \"text\", true, 42)" % s}
	return {"value": value, "error": ""}

func _ok(result = null) -> Dictionary:
	return {"ok": true, "result": result, "error": null}

func _fail(message: String) -> Dictionary:
	return {"ok": false, "result": null, "error": message}

func _reply(ws: WebSocketPeer, id, out: Dictionary) -> void:
	var payload := {"id": id, "ok": out["ok"], "result": out["result"], "error": out["error"]}
	ws.send_text(JSON.stringify(payload))
