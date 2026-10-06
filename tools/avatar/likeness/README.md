# Likeness: a Me Mode avatar that looks like you

Turns one frontal photo into an animated, photoreal Me Mode avatar. The body,
skeleton and idle/walk/run clips come from a Microsoft Rocketbox character
(MIT); the face, beard, hair colour, skin tone and top come from the photo.

```sh
# once: Blender as a module, and the vision libraries in a separate venv
python3.11 -m venv .bpy && .bpy/bin/pip install bpy "numpy<2"
python3.11 -m venv .cv && .cv/bin/pip install mediapipe opencv-python-headless pillow scipy
curl -L -o tools/avatar/likeness/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
git clone --filter=blob:none --sparse https://github.com/microsoft/Microsoft-Rocketbox
(cd Microsoft-Rocketbox && git sparse-checkout add \
  Assets/Avatars/Adults/Male_Adult_11 \
  Assets/Animations/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx \
  Assets/Animations/all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx \
  Assets/Animations/all_animations_max_motextr_xy/m_run_neutral_01.max.fbx)

# each photo (about 50 s on a laptop CPU)
BPY_PYTHON=.bpy/bin/python CV_PYTHON=.cv/bin/python PREVIEW=/tmp/me \
  tools/avatar/likeness/make_likeness.sh me.jpg \
  Microsoft-Rocketbox/Assets/Avatars/Adults/Male_Adult_11 public/avatars/me.glb
```

Me Mode loads `public/avatars/me.glb` automatically when it exists; the folder
is git-ignored, so the result stays on your machine. Pick the Rocketbox
character closest in build, hair length and clothing; `Male_Adult_11` (short
hair, collared short-sleeve shirt) suits most men. `PREVIEW` writes three
Blender renders (front, three-quarter, side).

## What it does

1. `export_head.py` (Blender): the avatar's rest-pose mesh, UVs and an
   orthographic front render of the head.
2. `project.py`: MediaPipe face landmarks on the photo and on the render, then a
   piecewise-affine warp of the photo onto the model's face. The open mouth is
   inpainted first, so a laugh closes onto the model's mouth; the plain studio
   background is masked out.
3. `bake.py`: rasterizes the head in UV space and bakes the warped photo into
   the head texture from the front (weighted by how squarely each texel faces
   the camera, with a depth test), then:
   - matches the remaining head skin to the photo (Lab mean/std transfer),
   - repaints scalp hair near-black,
   - continues the beard round the jaw to the sideburns as procedural stubble
     in the photo's beard colour (heights from the 3D landmarks),
   - turns the irises dark brown.
4. `recolor.py`: the top in the photo's colour with a vertical knit rib, arms
   and hands in the photo's skin tone, hair cards darkened.
5. `../rocketbox_to_glb.py --texture NAME=PATH`: the animated GLB with the new
   textures.

Limits: one photo gives the face's look from the front, not its 3D shape (the
head geometry is the Rocketbox character's). Expect the best match from the
front and three-quarter views. The colour choices for hair, beard and eyes
(near-black, dark brown) are fixed in `bake.py`; change them there for other
people. A photo with a strongly coloured background may need the background
mask in `project.py` adjusted. Only process photos of people who agreed to it.
