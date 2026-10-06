import bpy, numpy as np, sys, os, math
from mathutils import Vector
fbx, out = sys.argv[sys.argv.index('--')+1:]; out = os.path.abspath(out)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
arm = next(o for o in bpy.data.objects if o.type=='ARMATURE')
arm.data.pose_position = 'REST'
mesh = next(o for o in bpy.data.objects if o.type=='MESH')
tex = os.path.join(os.path.dirname(os.path.dirname(fbx)), 'Textures')
for im in bpy.data.images:
    p = os.path.join(tex, os.path.basename(im.filepath.replace('\\','/')))
    if os.path.exists(p): im.filepath = p; im.reload()
print('materials', [m.name for m in mesh.data.materials])
for m in mesh.data.materials:
    ims=[n.image.filepath for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]
    print(m.name, ims)
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg); me = ev.to_mesh()
M = np.array(mesh.matrix_world)
co = np.array([M @ np.append(v.co,1) for v in me.vertices])[:,:3]
no = np.array([(mesh.matrix_world.to_3x3() @ v.normal).normalized() for v in me.vertices])
me.calc_loop_triangles()
uv = me.uv_layers.active.data
tris = np.array([t.vertices[:] for t in me.loop_triangles])
tloops = np.array([t.loops[:] for t in me.loop_triangles])
tmat = np.array([t.material_index for t in me.loop_triangles])
uvs = np.array([uv[i].uv[:] for i in range(len(uv))])
# head bounds: material containing 'head'
head_idx = [i for i,m in enumerate(mesh.data.materials) if any('head' in n.image.filepath for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image)]
print('head mats', head_idx)
hv = np.unique(tris[np.isin(tmat, head_idx)])
lo, hi = co[hv].min(0), co[hv].max(0)
print('head bounds', lo, hi)
# ortho camera looking along +Y (model faces -Y)
cx, cz = (lo[0]+hi[0])/2, (lo[2]+hi[2])/2
size = max(hi[0]-lo[0], hi[2]-lo[2]) * 1.15
cam_data = bpy.data.cameras.new('cam'); cam_data.type='ORTHO'; cam_data.ortho_scale=size
cam = bpy.data.objects.new('cam', cam_data); bpy.context.scene.collection.objects.link(cam)
cam.location = (cx, lo[1]-1.0, cz); cam.rotation_euler = (math.pi/2, 0, 0)
sc = bpy.context.scene; sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = 1024
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'TEXTURE'
sc.render.film_transparent = True
sc.render.filepath = out + '_render.png'
bpy.ops.render.render(write_still=True)
np.savez(out + '.npz', co=co, no=no, tris=tris, tloops=tloops, tmat=tmat, uvs=uvs, head_idx=np.array(head_idx), cam=np.array([cx, cz, size, lo[1]-1.0]))
