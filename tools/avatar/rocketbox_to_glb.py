"""Convert a Microsoft Rocketbox avatar (MIT) plus idle/walk/run clips to a
web-ready GLB for Me Mode.

Needs Blender as a Python module (`pip install bpy`, Python 3.11) or run it
inside Blender. Usage:

    python tools/avatar/rocketbox_to_glb.py \\
      --avatar  .../Assets/Avatars/Adults/Male_Adult_06/Export/Male_Adult_06.fbx \\
      --idle    .../Animations/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx \\
      --walk    .../Animations/all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx \\
      --run     .../Animations/all_animations_max_motextr_xy/m_run_neutral_01.max.fbx \\
      --out     public/avatars/rocketbox-male-06.glb

Each clip is retargeted onto the avatar's skeleton by baking world-space
bone rotations (see add_clip). Me Mode moves the avatar itself, so the clips
must play in place: the walk/run clips still carry 1-2 m of forward travel
per cycle on the armature, which is flattened, and every clip is turned to
face glTF -Z, the convention of Me Mode's default heading offset. Textures
are relinked from the avatar's Textures folder, downscaled (default 1024 px)
and written as JPEG, except the hair/eyelash opacity atlas (PNG,
alpha-masked).
"""

import argparse
import math
import os
import sys
import tempfile

import bpy


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--avatar", required=True)
    parser.add_argument("--idle", required=True)
    parser.add_argument("--walk", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--texture-size", type=int, default=1024)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    return parser.parse_args(argv)


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
    return [obj for obj in bpy.data.objects if obj not in before]


def relink_and_compress_textures(avatar_fbx, size, workdir):
    """Point images at <avatar>/Textures and re-save them small for the web."""
    textures = os.path.join(os.path.dirname(os.path.dirname(avatar_fbx)), "Textures")
    for image in list(bpy.data.images):
        name = os.path.basename(image.filepath.replace("\\", "/"))
        source = os.path.join(textures, name)
        if not os.path.exists(source):
            continue
        image.filepath = source
        image.reload()
        if image.size[0] > size:
            image.scale(size, size)
        keep_alpha = "opacity" in name
        image.file_format = "PNG" if keep_alpha else "JPEG"
        out = os.path.join(
            workdir, os.path.splitext(name)[0] + (".png" if keep_alpha else ".jpg")
        )
        scene = bpy.context.scene
        scene.render.image_settings.file_format = image.file_format
        scene.render.image_settings.quality = 85
        scene.render.image_settings.color_mode = "RGBA" if keep_alpha else "RGB"
        image.save_render(out, scene=scene)
        image.filepath = out
        image.reload()


def fix_materials():
    """Base colour + normal map per material; the opacity atlas (hair,
    eyelashes) also drives an alpha mask."""
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        tree = material.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        images = [n for n in tree.nodes if n.type == "TEX_IMAGE" and n.image]
        # Specular maps are not used by glTF's metal/rough model.
        for node in images:
            if "specular" in node.image.filepath:
                tree.nodes.remove(node)
        images = [n for n in tree.nodes if n.type == "TEX_IMAGE" and n.image]
        colour = next(
            (n for n in images if "color" in os.path.basename(n.image.filepath)), None
        )
        normal = next((n for n in images if "normal" in n.image.filepath), None)
        if colour:
            tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
        if normal:
            normal.image.colorspace_settings.name = "Non-Color"
            normal_map = next((n for n in tree.nodes if n.type == "NORMAL_MAP"), None)
            if not normal_map:
                normal_map = tree.nodes.new("ShaderNodeNormalMap")
            tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
        bsdf.inputs["Roughness"].default_value = 0.75
        bsdf.inputs["Metallic"].default_value = 0.0
        if colour and "opacity" in colour.image.filepath:
            # glTF exporter writes alphaMode MASK for alpha through "Greater Than".
            mask = tree.nodes.new("ShaderNodeMath")
            mask.operation = "GREATER_THAN"
            mask.inputs[1].default_value = 0.5
            tree.links.new(colour.outputs["Alpha"], mask.inputs[0])
            tree.links.new(mask.outputs["Value"], bsdf.inputs["Alpha"])
            material.surface_render_method = "DITHERED"


def action_fcurves(action):
    """F-curves of an action, for both legacy and layered (Blender 4.4+)
    actions."""
    if getattr(action, "layers", None):
        return [
            curve
            for layer in action.layers
            for strip in layer.strips
            for bag in strip.channelbags
            for curve in bag.fcurves
        ]
    return list(action.fcurves)


def make_in_place(action):
    """Pin the armature object's horizontal travel to 0 and turn it 180 deg
    about up, so the clip plays in place facing glTF -Z (Blender +Y)."""
    for curve in action_fcurves(action):
        if curve.data_path == "location" and curve.array_index in (0, 1):
            for key in curve.keyframe_points:
                key.co[1] = key.handle_left[1] = key.handle_right[1] = 0.0
        elif curve.data_path == "rotation_euler" and curve.array_index == 2:
            for key in curve.keyframe_points:
                for point in (key.co, key.handle_left, key.handle_right):
                    point[1] += math.pi
        elif curve.data_path == "rotation_quaternion":
            raise SystemExit("Quaternion armature rotation is not handled")


def add_clip(armature, path, name):
    """Import a clip and bake it onto the avatar's armature as an NLA track
    named `name`, then drop the imported objects.

    The clip files' skeletons share the avatar's bone names but not its rest
    pose, and Blender stores pose channels relative to rest, so assigning a
    clip's action directly leaves the avatar near its T-pose. Instead each
    avatar bone copies the clip bone's world rotation (the pelvis also its
    location, the armature object its transform) and the result is baked."""
    objects = import_fbx(path)
    source = next(
        (
            obj
            for obj in objects
            if obj.type == "ARMATURE" and obj.animation_data and obj.animation_data.action
        ),
        None,
    )
    if source is None:
        raise SystemExit(f"No animation found in {path}")
    first, last = (int(round(f)) for f in source.animation_data.action.frame_range)

    constraints = [armature.constraints.new("COPY_TRANSFORMS")]
    constraints[0].target = source
    for bone in armature.pose.bones:
        if bone.name not in source.pose.bones:
            continue
        kinds = ["COPY_ROTATION"]
        if bone.parent is None:
            kinds.append("COPY_LOCATION")
        for kind in kinds:
            constraint = bone.constraints.new(kind)
            constraint.target = source
            constraint.subtarget = bone.name
            constraint.owner_space = constraint.target_space = "WORLD"

    armature.animation_data.action = None
    bpy.context.view_layer.objects.active = armature
    for obj in bpy.context.view_layer.objects:
        obj.select_set(obj == armature)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(
        frame_start=first,
        frame_end=last,
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=False,
        bake_types={"POSE", "OBJECT"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    action = armature.animation_data.action
    action.name = name
    action.use_fake_user = True
    make_in_place(action)
    armature.animation_data.action = None

    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    track = armature.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, first, action)
    if hasattr(strip, "action_slot") and getattr(action, "slots", None):
        strip.action_slot = action.slots[0]
    return action


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    avatar_objects = import_fbx(args.avatar)
    armature = next(obj for obj in avatar_objects if obj.type == "ARMATURE")
    for obj in avatar_objects:
        if obj.type == "EMPTY":
            bpy.data.objects.remove(obj, do_unlink=True)
    # Rocketbox faces -Y in Blender (glTF +Z); turn the rest pose to face
    # glTF -Z like the clips (see make_in_place).
    armature.rotation_euler[2] += math.pi
    armature.animation_data_create()
    armature.animation_data.action = None

    with tempfile.TemporaryDirectory() as workdir:
        relink_and_compress_textures(args.avatar, args.texture_size, workdir)
        fix_materials()
        for name, path in (("Idle", args.idle), ("Walk", args.walk), ("Run", args.run)):
            action = add_clip(armature, path, name)
            print(f"clip {name}: frames {tuple(action.frame_range)}")
        armature.animation_data.action = None
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=args.out,
            export_format="GLB",
            export_yup=True,
            export_skins=True,
            export_animations=True,
            export_animation_mode="NLA_TRACKS",
            export_image_format="AUTO",
            export_morph=False,
        )
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
