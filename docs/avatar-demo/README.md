# Me Mode demo screenshots

Captured by `QA_SCREENSHOTS=1 node scripts/qa-me-mode.mjs` in a headless,
keyless sandbox whose network policy blocked Google 3D Tiles, Esri imagery and
Re:Earth terrain. The globe is therefore untextured blue at ellipsoid height;
the avatar, camera, clips and placement are the real app. Re-run the script
with `GOOGLE_MAPS_API_KEY` set to capture the photoreal versions.

- `kings-cross-start.png`: Me Mode turned on at Kings Cross, London (idle).
- `kings-cross-walked.png`: after W then Shift+W (walk clip mid-stride).
- `under-canopy.png`: after placing and walking under a 6–7 m canopy slab
  over a ground slab (globe hidden): the avatar stays on the ground.
- `times-square.png`: after voice `place_avatar` to Times Square and a short
  `move_avatar_to` walk north.
- `pegman-drop.png`: after dragging the Pegman onto the map.
- `flying-cape.png` / `flying-surf.png`: fly mode with the cape, and surfing (B).
