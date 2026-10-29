# Night Riders vehicle assets

Original, locally authored low-poly geometry for GCH. No third-party models,
textures, fonts, logos, paid services, or generative model weights are embedded.
The ivory wedge-shaped lead car draws on 1980s supercar proportions. The scout
motorcycle includes an original geometric helmeted rider.

Regenerate from the repository root with Blender 4.3.2:

```sh
blender --background --python scripts/create-night-riders-assets.py
```

Optional local verification renders:

```sh
blender --background --python scripts/create-night-riders-assets.py -- \
  --preview /tmp/night-riders-car.png --preview-bike /tmp/night-riders-bike.png
```

Both GLBs use meters, Y up, ground Y=0 and nose +Z. The car is approximately
4.8 m long; the bike approximately 2.2 m. No animations are baked into the files:
GCH's scene owns motion and uses observed execution state.

Wheel root nodes have identity rotation. Rotate their local X axis; their rim,
hub, and spoke meshes are children. Match the exact root names, never every node
with a `wheel-` prefix:

- Car: `wheel-front-left`, `wheel-front-right`, `wheel-rear-left`, `wheel-rear-right`.
- Motorcycle: `wheel-front`, `wheel-rear`.

Clone materials for each vehicle before recoloring `vehicle-accent` and
`vehicle-glow`. The former covers bike fairings and wheel hubs; the latter covers
underglow and rider/trim lights. `rear-lights` and `headlights` are separately
addressable emissive materials. Runtime lighting must not imply agent activity
unless the event state supports it.

Static parts are merged by material and wheel children by parent/material to
limit draw calls. `asset-provenance.json` records file sizes and SHA-256 hashes.
