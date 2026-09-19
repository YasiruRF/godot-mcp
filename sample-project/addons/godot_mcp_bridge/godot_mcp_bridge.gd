@tool
extends EditorPlugin

## Godot MCP Bridge — Phase 2 companion plugin.
##
## While the editor is open with this plugin enabled, it listens on
## ws://127.0.0.1:9080 for JSON messages from the godot-mcp Node.js MCP
## server and executes a small set of editor commands. Requires Godot 4.1+
## (WebSocketPeer.accept_stream).
##
## Protocol: each message is a JSON object {"id": <int>, "command": <string>,
## "args": {...}}. Each reply is {"id": <int>, "ok": <bool>, "result": <any>,
## "error": <string|null>}.

const PORT := 9080

var _tcp_server := TCPServer.new()
var _peers: Array = []

func _enter_tree() -> void:
	var err := _tcp_server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_warning("godot_mcp_bridge: failed to listen on 127.0.0.1:%d (error %d). Is another instance already running?" % [PORT, err])
	else:
		print("godot_mcp_bridge: listening on ws://127.0.0.1:%d" % PORT)

func _exit_tree() -> void:
	for p in _peers:
		(p["ws"] as WebSocketPeer).close()
	_peers.clear()
	_tcp_server.stop()

func _process(_delta: float) -> void:
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
		_reply(ws, null, false, null, "invalid JSON message")
		return

	var id = data.get("id")
	var command: String = data.get("command", "")
	var args: Dictionary = data.get("args", {})

	var ok := true
	var err_msg := ""
	var result = null

	match command:
		"ping":
			result = {"status": "alive", "editor": "godot-mcp-bridge", "godot_version": Engine.get_version_info()}
		"run_scene":
			var scene_path: String = args.get("scene_path", "")
			if scene_path == "":
				ok = false
				err_msg = "scene_path is required"
			else:
				EditorInterface.play_custom_scene(scene_path)
				result = {"playing": scene_path}
		"stop":
			EditorInterface.stop_playing_scene()
			result = {"stopped": true}
		"get_selection":
			var selected := EditorInterface.get_selection().get_selected_nodes()
			var names := []
			for n in selected:
				names.append(str(n.get_path()))
			result = {"selected": names}
		_:
			ok = false
			err_msg = "unknown command: %s" % command

	_reply(ws, id, ok, result, err_msg if not ok else null)

func _reply(ws: WebSocketPeer, id, ok: bool, result, error) -> void:
	var payload := {"id": id, "ok": ok, "result": result, "error": error}
	ws.send_text(JSON.stringify(payload))
