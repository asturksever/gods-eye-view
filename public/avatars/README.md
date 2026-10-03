# Avatars (local only)

Everything in this folder except this README is git-ignored. Put avatar
models here; they are served at `/avatars/<file>` and selected with
`?avatar=/avatars/<file>.glb`. See [docs/avatar.md](../../docs/avatar.md).

`default.glb` is optional. Without it, Me Mode fetches the placeholder
soldier from a pinned CDN copy at runtime. To keep a local copy (offline
demos):

```sh
curl -L -o public/avatars/default.glb \
  https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Soldier.glb
```

| File | Original work | Source | License |
| --- | --- | --- | --- |
| `default.glb` (not committed) | "Soldier", three.js example model; character and animations from Adobe Mixamo | [three.js r170 examples](https://github.com/mrdoob/three.js/blob/r170/examples/models/gltf/Soldier.glb) | three.js repository: MIT; Mixamo asset: [Adobe terms](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), not for raw redistribution |
