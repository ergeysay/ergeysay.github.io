"""
blender_bones.py - rig a cylinder as an audio waveform from data.json.

One bone per frequency band along the cylinder's X axis; each vertex is weighted
to its band by X position; bone scales are keyframed from data.json so the
cylinder ripples with the audio.

Setup: a cylinder lying along X (length LENGTH, radius RADIUS) with transforms
applied, and an armature at the origin. Select the cylinder, then the armature
(active), and run.
"""
import bpy
import json

DATA_PATH = r"d:\audio-viz\data.json"
LENGTH = 34.0   # cylinder length along X
RADIUS = 2.0    # cylinder radius
SCALE = 5.0     # bone scale per unit band value
BLEND = 1.0     # band blend width, in bones (lower = crisper, higher = smoother)

with open(DATA_PATH) as f:
    data = json.load(f)
frames = sorted(data, key=int)
bands = len(data[frames[0]])
step = LENGTH / (bands - 1)

armature = bpy.context.object
mesh = next(o for o in bpy.context.selected_objects if o.type == "MESH")

# --- bones: one per band, spaced along X, pointing +Y toward the surface ---
bpy.ops.object.mode_set(mode="EDIT")
edit_bones = armature.data.edit_bones
for bone in list(edit_bones):
    edit_bones.remove(bone)
for i in range(bands):
    x = -LENGTH / 2 + i * step
    bone = edit_bones.new(str(i))
    bone.head = (x, 0, 0)
    bone.tail = (x, RADIUS, 0)
bpy.ops.object.mode_set(mode="OBJECT")

# --- weights: each vertex to its band(s) by its world X position ---
# (world, not v.co, so an unapplied object rotation doesn't pick the wrong axis)
for group in list(mesh.vertex_groups):
    mesh.vertex_groups.remove(group)
groups = [mesh.vertex_groups.new(name=str(i)) for i in range(bands)]
to_world = mesh.matrix_world
for v in mesh.data.vertices:
    x = (to_world @ v.co).x
    t = (x + LENGTH / 2) / step  # band index this vertex sits at
    for i in range(max(0, int(t - BLEND)), min(bands, int(t + BLEND) + 1)):
        weight = 1 - abs(t - i) / BLEND
        if weight > 0:
            groups[i].add([v.index], weight, "REPLACE")
mesh.modifiers.new("Armature", "ARMATURE").object = armature

# --- animation: scale each bone from data.json ---
for f, key in enumerate(frames):
    for i, value in enumerate(data[key]):
        bone = armature.pose.bones[str(i)]
        bone.scale = (value * SCALE,) * 3
        bone.keyframe_insert("scale", frame=f)

# linear interpolation (Blender's default can be Bezier/Constant -> choppy export)
for fcurve in armature.animation_data.action.fcurves:
    for kp in fcurve.keyframe_points:
        kp.interpolation = "LINEAR"

bpy.context.scene.frame_end = len(frames) - 1
print(f"rigged {bands} bands, {len(frames)} frames")
