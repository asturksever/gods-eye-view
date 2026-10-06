# Avatars (local only)

Everything in this folder except this README is git-ignored. Put avatar
models here; they are served at `/avatars/<file>` and selected with
`?avatar=/avatars/<file>.glb`. See [docs/avatar.md](../../docs/avatar.md).

`me.glb`, if present, is loaded by Me Mode instead of the default; make one
from a photo with `tools/avatar/likeness/` (see its README).

The default avatar is not in this folder: it is the committed Rocketbox
human at `public/models/people/rocketbox-male-06.glb`. If that file cannot be
loaded, Me Mode fetches three.js's Soldier from a pinned CDN copy instead.
To try the Soldier locally:

```sh
curl -L -o public/avatars/soldier.glb \
  https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Soldier.glb
# then open /?avatar=/avatars/soldier.glb
```

| File | Original work | Source | License |
| --- | --- | --- | --- |
| `soldier.glb` (not committed) | "Soldier", three.js example model; character and animations from Adobe Mixamo | [three.js r170 examples](https://github.com/mrdoob/three.js/blob/r170/examples/models/gltf/Soldier.glb) | three.js repository: MIT; Mixamo asset: [Adobe terms](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), not for raw redistribution |
