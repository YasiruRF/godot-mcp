extends RigidBody3D
## The rolling ball. WASD / arrow keys roll it relative to the camera, Space jumps.
## Needs contact_monitor on (with max_contacts_reported > 0) for the ground check.

@export var roll_torque := 8.0
@export var max_speed := 10.0
@export var jump_impulse := 6.0
@export var fall_limit := -15.0
@export var camera_rig_path: NodePath = ^"../CameraRig"

var _grounded := false
var _respawn_pending := false
var _spawn_transform := Transform3D.IDENTITY

@onready var _camera_rig: Node3D = get_node_or_null(camera_rig_path)


func _ready() -> void:
	_spawn_transform = global_transform


func _physics_process(_delta: float) -> void:
	if global_position.y < fall_limit:
		respawn()

	var move := _read_input()
	var flat_speed := Vector2(linear_velocity.x, linear_velocity.z).length()
	if move == Vector2.ZERO or flat_speed > max_speed:
		return

	var yaw := _camera_rig.rotation.y if _camera_rig else 0.0
	var direction := Vector3(move.x, 0.0, move.y).rotated(Vector3.UP, yaw)
	# rolling toward `direction` means spinning about up x direction
	apply_torque(Vector3(direction.z, 0.0, -direction.x) * roll_torque)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_accept") and _grounded:
		apply_central_impulse(Vector3.UP * jump_impulse)


func respawn() -> void:
	_respawn_pending = true


func _integrate_forces(state: PhysicsDirectBodyState3D) -> void:
	if _respawn_pending:
		_respawn_pending = false
		state.transform = _spawn_transform
		state.linear_velocity = Vector3.ZERO
		state.angular_velocity = Vector3.ZERO

	_grounded = false
	for i in state.get_contact_count():
		if state.get_contact_local_normal(i).y > 0.6:
			_grounded = true
			break


func _read_input() -> Vector2:
	var move := Vector2.ZERO
	if Input.is_physical_key_pressed(KEY_W) or Input.is_action_pressed("ui_up"):
		move.y -= 1.0
	if Input.is_physical_key_pressed(KEY_S) or Input.is_action_pressed("ui_down"):
		move.y += 1.0
	if Input.is_physical_key_pressed(KEY_A) or Input.is_action_pressed("ui_left"):
		move.x -= 1.0
	if Input.is_physical_key_pressed(KEY_D) or Input.is_action_pressed("ui_right"):
		move.x += 1.0
	return move.normalized()
