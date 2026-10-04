# Me Mode: walk your own avatar on the globe

Me Mode puts a rigged, animated glTF character on the ground where the camera
is looking and hands you a third-person game camera. It is a demo (Phase 0 of
the human-avatar PRD): one local avatar, no accounts, no upload flow.

## Using it

Me Mode works like Street View's Pegman. The yellow figure sits on the right
of the map, above the HUD readouts:

- **Drag the Pegman** onto any spot on the globe and let go: the avatar is
  dropped there.
- **Click it** (or press Enter on it): the avatar is dropped at the centre of
  the view.
- **Voice:** "put me at Kings Cross".

A drop never lands inside a building. It is moved onto the nearest road
through GEV's routing proxy (`/api/route`, the same OSRM service as
Directions), and only to a road within 150 m. If routing is unavailable, a
drop on a roof moves to the nearest street-level point around it on the
loaded 3D surface. That street-level check (up to 85 m around) also runs
after a road snap, so a spot that is still up on a structure is corrected.
Each drop logs what it did in the browser console, e.g.
`[Me Mode] Drop: moved 23 m to road` or the reason the road lookup failed. The Pegman hides while Me Mode is on. Leave with
**✕ Exit** on the bar at the bottom, or `Esc`.

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrow keys | Walk relative to the camera (2.8 m/s) |
| `Shift` + move | Run (16 m/s) |
| `F`, or **🕊 Fly** on the bar | Take off / land (falls to the surface below) |
| `E` / `Q` while flying | Climb / descend (6 m/s; Shift ×4) |
| `W` `A` `S` `D` while flying | Fly (15 m/s; Shift ×4, 60 m/s), leaning into the direction of travel |
| `B` while flying, or **🦸 Cape / 🏄 Surf** on the bar | Fly style: a red cape that streams out behind as you fly, or standing on a silver surfboard |
| `V`, or **First / Third person** on the bar | Toggle first person (eye height 1.6 m, model hidden) |
| Drag on the globe | Orbit the camera around the avatar / look around |
| Mouse wheel | Follow distance, 2–30 m |
| `Esc` (on the globe), or **✕ Exit** | Leave Me Mode |

Flying never goes below the ground or the roof beneath you, or more than
3 km above it. Landing drops you where you are, which can be a roof; drag the
Pegman again to return to the street.

While Me Mode is on it owns the camera and these keys. The HUD shortcuts under
`W`, `D`, `V`, `F`, `Q` and `E` are suspended. Keys typed into text fields are ignored, and
arrow keys on a focused panel control keep their normal behaviour, and
leaving Me Mode restores the normal GEV camera. If anything else moves
the camera (a search, a POI key, a voice camera tool, Director playback or
Cockpit), Me Mode ends and leaves the camera where that move put it, rather
than pulling it back. A one-frame correction does not count; a jump over 50 m or a move
repeated on consecutive frames (a flight) does. Cesium's own camera collision
is switched off while Me Mode runs, because it would push the follow camera
off the pavement, and it is restored afterwards. Me Mode will not start while Cockpit is active.

Voice:

- "Put me at Kings Cross" / "Take me to the Shibuya crossing" → `place_avatar`
  (teleport, then ground on the most detailed tiles).
- "Walk me to the station entrance" → `move_avatar_to`: a straight-line walk
  when the place is under 300 m away, otherwise a teleport. Walking ignores
  buildings.
- While Me Mode is on, ordinary "go to X" navigation (`fly_to_location`) moves
  the avatar instead of the camera.
- "What is in front of me?" works from `get_current_view_state`, whose
  `avatar` field carries position, height and compass facing.

Ground following casts a ray straight down from 1.2 m above the feet
(`scene.pickFromRay`, excluding the avatar). Steps and kerbs below that are
climbed, and anything above it, such as tree canopy, bridges and awnings, is
walked under rather than stood on. If the ray starts inside geometry and finds
nothing, the highest surface (`sampleHeight`) is used instead. Samples are
taken at most every 90 ms while moving and every 600 ms at rest, and the last
five are averaged so tile level-of-detail swaps do not make the avatar bob.
Each sample is a synchronous pick render, so it is never done per frame. Jumps
over 4 m restart the average.

A placement (toggle on, voice, `setPosition`) starts from the highest surface
on the most detailed tiles, then probes downward just below each hit until
nothing is below. A street under a tree lands on the street, and a roof with
nothing under it stays the answer.

## Swapping the model

```
http://localhost:4173/?avatar=/avatars/said.glb
http://localhost:4173/?avatar=/avatars/spiderman.glb&clips=idle:Breathing,walk:Walking,run:Running
http://localhost:4173/?avatar=/avatars/said.glb&avatarHeading=0
```

- `avatar`: a root-relative `.glb`/`.gltf` path on the same server. Other
  hosts are refused, so a shared link cannot make a viewer download from an
  arbitrary site; code can still load one through `setModel`. Files in
  `public/avatars/` are served at `/avatars/…` and are **git-ignored**, so a
  personal scan never ends up in a commit. A model that has not loaded after
  30 s fails the toggle, and turning Me Mode off cancels a download.
- `clips`: maps the three roles to your file's animation names. Unmapped roles
  fall back by name (`*idle*`, `*walk*`, `*run*`, case-insensitive), then
  run → walk → idle. A model with a single clip uses it for everything, and a
  model with none just slides. The loaded names are logged in the console:
  `[Me Mode] Avatar loaded { clips, available }`.
- `avatarHeading`: degrees to rotate the model so that it walks forwards. The
  default is 180, for models that face glTF −Z like the placeholder. Models
  exported from Blender with "+Y Up" usually face +Z: use `avatarHeading=0`.

From code, the layer also exposes
`setModel(url, { idle, walk, run }, { headingOffsetDeg })`,
`setPosition(lon, lat)`, `walkTo(lon, lat)` and `getPose()`.

Models are normalized at load time. CesiumJS applies a skinned mesh's parent
transforms, which the glTF spec says to ignore. The common Mixamo/Blender
layout, a mesh under an armature scaled 0.01 and rotated −90°, would otherwise
render 1.8 cm tall. Me Mode moves such meshes to the scene root before Cesium
parses them, which changes nothing for spec-correct viewers.

## Making a GLB of yourself

Target: one GLB, metres, feet at the origin, Y-up, under 15 MB, with idle,
walk and run clips.

1. **Body mesh from photos.** Use a single-image or multi-view human
   reconstruction such as SAM 3D Body (Meta) or LHM (Large Animatable Human
   Model). Export a textured mesh (OBJ/GLB) in an A- or T-pose. Run phone-scan
   apps through the same steps.
2. **Rig it.** The quickest route is to upload the mesh to Mixamo
   (auto-rigger), then download *Idle*, *Walking* and *Running* "in place"
   with skin. Alternatives are UniRig (automatic skeleton and skinning) or
   Blender's Rigify. In-place clips matter: Me Mode moves the root itself.
3. **Assemble in Blender.** Import the rigged FBX files and put all three
   actions on one armature (NLA → push down, with each action named `Idle`,
   `Walk` and `Run`). Apply scale so that 1 unit = 1 m, with the feet at the
   origin.
4. **Export.** Use File → Export → glTF 2.0 (.glb), with +Y Up, Animation:
   Actions, Skinning on, and Compression (Draco) on. Keep textures at 2K or
   below; the result should be under 15 MB.
5. **Try it.** Copy the file to `public/avatars/me.glb` and open
   `/?avatar=/avatars/me.glb`. Fix walking direction with `avatarHeading` and
   clip names with `clips`.

Third-party characters (a superhero download, for example) work the same way,
but their licence is yours to check. Keep them in the ignored folder.

## Limits (demo scope)

The avatar does not collide with buildings; walking through walls is possible.
The follow camera does: a ray from the avatar's eye pulls it in front of walls
and uphill slopes behind the avatar, and it eases back out when they clear.
No cross-fades between clips. Turning Me Mode on flies down from the current
view over about 1.6 s; anything else moving the camera during that flight
(for example GEV's own start-up camera move) ends Me Mode. The avatar is local and is not shared through
share links. Ground following needs loaded surface geometry: with the keyless
globe the avatar stands on terrain, not on buildings.

## Checking it

```sh
npm run dev
node scripts/qa-me-mode.mjs                       # toggle, keys, clips, voice, restore
QA_SCREENSHOTS=1 node scripts/qa-me-mode.mjs --second-avatar=/avatars/me.glb
```

With `GOOGLE_MAPS_API_KEY` set, the ground-contact checks measure against the
photoreal tiles; without it they measure against the keyless globe. To watch
the frame rate, press `` ` `` for GEV's FPS monitor, or run
`__godsEyeView.viewer.scene.debugShowFramesPerSecond = true` in the console.
