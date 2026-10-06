#!/bin/bash
# Make a Me Mode avatar that looks like the person in a frontal photo.
# See README.md. Usage:
#   tools/avatar/likeness/make_likeness.sh PHOTO ROCKETBOX_AVATAR_DIR OUT.glb
# e.g. make_likeness.sh me.jpg Microsoft-Rocketbox/Assets/Avatars/Adults/Male_Adult_11 public/avatars/me.glb
# Needs BPY_PYTHON (Python with `bpy`, numpy<2) and CV_PYTHON (Python with
# mediapipe, opencv-python-headless, pillow, scipy).
set -euo pipefail
PHOTO=$(realpath "$1"); AVATAR=$(realpath "$2"); OUT=$(realpath -m "$3")
HERE=$(cd "$(dirname "$0")" && pwd)
BPY_PYTHON=${BPY_PYTHON:-python3}; CV_PYTHON=${CV_PYTHON:-python3}
NAME=$(basename "$AVATAR"); TEX="$AVATAR/Textures"
PREFIX=$(basename "$(ls "$TEX"/*_head_color.tga)" _head_color.tga)
ANIM=$(realpath "$AVATAR/../../../Animations")
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
"$BPY_PYTHON" "$HERE/export_head.py" -- "$AVATAR/Export/$NAME.fbx" "$WORK/mesh" > "$WORK/log" 2>&1
"$CV_PYTHON" "$HERE/project.py" "$PHOTO" "$WORK/mesh.npz" "$WORK/mesh_render.png" "$WORK/face" 2>> "$WORK/log"
"$CV_PYTHON" "$HERE/bake.py" "$WORK/mesh.npz" "$WORK/face" "$TEX/${PREFIX}_head_color.tga" "$WORK/me" "$PHOTO" 2>> "$WORK/log"
OPACITY="$TEX/${PREFIX}_opacity_color.tga"; [ -f "$OPACITY" ] || OPACITY=-
"$CV_PYTHON" "$HERE/recolor.py" "$TEX/${PREFIX}_body_color.tga" "$OPACITY" "$PHOTO" "$WORK/me_stats.npz" "$WORK/me" 2>> "$WORK/log"
TEXTURES=(--texture "${PREFIX}_head_color.tga=$WORK/me_head.png" --texture "${PREFIX}_body_color.tga=$WORK/me_body.png")
[ "$OPACITY" = - ] || TEXTURES+=(--texture "${PREFIX}_opacity_color.tga=$WORK/me_opacity.png")
"$BPY_PYTHON" "$HERE/../rocketbox_to_glb.py" --avatar "$AVATAR/Export/$NAME.fbx" \
  --idle "$ANIM/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx" \
  --walk "$ANIM/all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx" \
  --run "$ANIM/all_animations_max_motextr_xy/m_run_neutral_01.max.fbx" \
  "${TEXTURES[@]}" --texture-size 2048 --out "$OUT" 2>> "$WORK/log" | grep '^wrote'
if [ -n "${PREVIEW:-}" ]; then
  "$BPY_PYTHON" "$HERE/preview.py" -- "$AVATAR/Export/$NAME.fbx" "$WORK/me" "$PREVIEW" >> "$WORK/log" 2>&1
  echo "previews: ${PREVIEW}_0.png .. ${PREVIEW}_2.png"
fi
