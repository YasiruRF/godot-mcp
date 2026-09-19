extends Node3D
## Third-person tracking camera. It follows the target smoothly and never rotates with it,
## so "forward" stays put while the ball spins. Mouse (or Q / E) orbits, Esc frees the mouse.
##
## Expected children: Pivot (Node3D, pitch) > SpringArm3D > Camera3D.

@export var target_path: NodePath = ^"../Player"
@export var follow_speed := 8.0
@export var mouse_sensitivity := 0.003
@export var key_orbit_speed := 2.0
@export var min_pitch := -1.4
@export var max_pitch := -0.08

@onready var _target: Node3D = get_node_or_null(target_path)
@onready var _pivot: Node3D = $Pivot
@onready var _arm: SpringArm3D = $Pivot/SpringArm3D


func _ready() -> void:
	if _target == null:
		push_warning("CameraRig: no target at %s" % target_path)
		return
	global_position = _target.global_position
	# otherwise the arm shortens whenever the ball itself is in the way
	if _target is CollisionObject3D:
		_arm.add_excluded_object(_target.get_rid())
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _process(delta: float) -> void:
	if _target == null:
		return
	global_position = global_position.lerp(_target.global_position, 1.0 - exp(-follow_speed * delta))

	var orbit := 0.0
	if Input.is_physical_key_pressed(KEY_Q):
		orbit += 1.0
	if Input.is_physical_key_pressed(KEY_E):
		orbit -= 1.0
	rotation.y += orbit * key_orbit_speed * delta


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		rotation.y -= event.relative.x * mouse_sensitivity
		_pivot.rotation.x = clampf(_pivot.rotation.x - event.relative.y * mouse_sensitivity, min_pitch, max_pitch)
	elif event.is_action_pressed("ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	elif event is InputEventMouseButton and event.pressed:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
