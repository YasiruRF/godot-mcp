extends Node
## Round logic for the rolling-ball course: a timer, the goal pad, and restart on R.

@onready var _player: Node3D = get_node("../Player")
@onready var _goal: Area3D = get_node("../Goal")
@onready var _label: Label = get_node("../HUD/Label")

var _time := 0.0
var _finished := false


func _ready() -> void:
	_label.add_theme_font_size_override("font_size", 24)
	_goal.body_entered.connect(_on_goal_body_entered)


func _process(delta: float) -> void:
	if _finished:
		return
	_time += delta
	_label.text = "Time: %.1f s\nWASD / arrows roll  |  Space jump  |  Mouse or Q/E camera  |  R restart" % _time


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.physical_keycode == KEY_R:
		get_tree().reload_current_scene()


func _on_goal_body_entered(body: Node3D) -> void:
	if body == _player and not _finished:
		_finished = true
		_label.text = "You made it!  Time: %.1f s\nR: play again" % _time
