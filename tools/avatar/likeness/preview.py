import bpy, sys, os, math
fbx, prefix, out = sys.argv[sys.argv.index('--')+1:]
prefix, out = os.path.abspath(prefix), os.path.abspath(out)
texdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(fbx))), 'Textures')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE'); arm.data.pose_position = 'REST'
swap = {'head_color': '_head.png', 'body_color': '_body.png', 'opacity_color': '_opacity.png'}
for im in bpy.data.images:
    name = os.path.basename(im.filepath.replace('\\', '/'))
    path = os.path.join(texdir, name)
    for k, v in swap.items():
        if k in name and os.path.exists(prefix + v): path = prefix + v
    im.filepath = path; im.reload()
    if 'normal' in name: im.colorspace_settings.name = 'Non-Color'
for m in bpy.data.materials:
    t = m.node_tree; b = next((n for n in t.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b: continue
    imgs = [n for n in t.nodes if n.type == 'TEX_IMAGE' and n.image]
    for n in [n for n in imgs if 'specular' in n.image.filepath]: t.nodes.remove(n)
    imgs = [n for n in t.nodes if n.type == 'TEX_IMAGE' and n.image]
    col = next((n for n in imgs if 'normal' not in n.image.filepath), None)
    nor = next((n for n in imgs if 'normal' in n.image.filepath), None)
    if col:
        t.links.new(col.outputs['Color'], b.inputs['Base Color'])
        if 'opacity' in m.name: t.links.new(col.outputs['Alpha'], b.inputs['Alpha'])
    if nor:
        nm = next((n for n in t.nodes if n.type == 'NORMAL_MAP'), None) or t.nodes.new('ShaderNodeNormalMap')
        t.links.new(nor.outputs['Color'], nm.inputs['Color']); t.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Roughness'].default_value = 0.6
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.samples = 32; sc.cycles.device = 'CPU'
sc.render.resolution_x = sc.render.resolution_y = 600
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.5, 0.52, 0.55, 1)
w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
L = bpy.data.lights.new('key', 'SUN'); L.energy = 3.5; o = bpy.data.objects.new('key', L)
o.rotation_euler = (math.radians(55), 0, math.radians(-25)); sc.collection.objects.link(o)
cam_d = bpy.data.cameras.new('c'); cam_d.type = 'ORTHO'; cam_d.ortho_scale = 0.55
cam = bpy.data.objects.new('c', cam_d); sc.collection.objects.link(cam); sc.camera = cam
cam.location = (0, -2, 1.6); cam.rotation_euler = (math.radians(90), 0, 0)
for i, ang in enumerate([0, 35, 75]):
    a = math.radians(ang)
    cam.location = (2 * math.sin(a), -0.03 - 2 * math.cos(a), 1.6)
    cam.rotation_euler = (math.radians(90), 0, a)
    sc.render.filepath = f'{out}_{i}.png'
    bpy.ops.render.render(write_still=True)
