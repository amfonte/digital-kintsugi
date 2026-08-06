# Digital Kintsugi — Product Spec

## Product goal

An interactive 3D kintsugi (golden repair) visualizer. A single procedural porcelain
bowl rendered in a real three.js WebGL scene with studio lighting, an environment
reflection map, and soft ground shadow. The user shatters the bowl into irregular
Voronoi shards (real mesh geometry split along crack lines, with fracture side
walls), then repairs it: shards pull back together and every seam fills with a
slightly-raised metallic gold ribbon that follows the crack path in 3D and catches
specular highlights. Fidelity bar: photographed real kintsugi ware (dimensional
seams, glaze + metal reflections), not a flat illustration.

## Visible output

- Default state on load: the whole, unbroken bowl — no cracks and no gold. Product
  output exists immediately, no empty canvas; the gold is what the user's first
  strike earns.
- Canvas: `editable-output`, default 16:9 / 1920x1080, `canvas.renderScale: true`
  (WebGL raster preview).
- No media upload: the vessel is fully procedural; `canvas.upload` off, no fileDrop.

## Interaction model

- **Strike the bowl**: clicking the vessel itself breaks it. The click is raycast
  against the shard meshes and converted to a surface (θ, s) impact point, and the
  break originates exactly at the clicked point: a crack runs through it, and on
  untouched glaze three or more cracks **meet** there and radiate outward. The
  mechanism is a ring of Voronoi seeds around the impact with none at its centre
  and all at exactly equal distance from it — a seed would make the click the
  middle of a shard, and equal radii are what make every bisector converge on it.
  Two sizing rules keep that true on a vessel already broken: the ring is pulled in
  to the nearest existing seed's distance (a closer older seed would otherwise own
  the click outright and the new bisectors would never reach it — that old cell then
  joins the star as one more participant), and a strike landing within half a star
  radius of an existing crack spends two seeds instead of three, since its single
  line meets that crack a short run away. Measured: the nearest crack lands within
  ~0.006 world units of the click, at any depth from rim to pole and however
  crowded the surface already is (the fracture grid resolves ~0.031). A click on
  the background, or a pointer drag that orbits the camera, does nothing.
- **Shatter → hold → repair** is one automatic cycle per strike: shards separate
  along the Voronoi pattern with a physics-like settle (damped overshoot tween,
  deterministic, renderer-internal wall-clock transient), hold apart for 1.0s,
  then return to rest pose and the gold seam ribbons draw on along the crack paths
  (drawRange growth ordered along each chained crack path). Gold retracts at the
  start of every strike and redraws across the whole network on every repair.
- **Cumulative damage**: damage is permanent. Ownership is resolved once per
  strike and a face's shard is the whole tuple of per-strike owners, so a crack
  cut by one strike stays cut by every later one; a new break runs into the
  existing seams and terminates against them, giving one continuous network
  rather than two overlaid patterns. (Resolving a single flat Voronoi diagram
  over the accumulated seeds does not do this — a later seed that wins a patch
  of surface takes the older boundaries inside that patch with it, erasing
  roughly a third of the previous strike's crack length.) Because each strike
  splits cells the earlier ones cut, shards outrun seeds — typically 4, 8, 14, 22 —
  and the vessel saturates on the fourth or fifth strike, depending on where the
  clicks landed (measured 3.75 landing strikes on average over 12 random
  eight-click sequences). Accumulation stops at the
  28-shard hard limit: a strike past it still shatters and repairs the pattern
  the vessel already carries, it just adds no new damage.
- Vessel phase (whole / shattered / kintsugi) is simulation-owned renderer state,
  not a control. The one control is the `Reset vessel` action (`vessel.reset`),
  which discards the break history and returns the bowl to whole.
- Orbit: pointer-drag on the product canvas orbits the internal 3D camera
  (view-only state, like runtime zoom); wheel zooms dolly. Pointer events are
  consumed by the product canvas so runtime viewport pan is not hijacked.
- Turntable: timeline-driven full 360° yaw of the vessel group per loop
  (seamless forward-only; first/last frames stitch by construction). Toggled by
  the Auto-rotate switch; easing select shapes rotation-vs-time inside one
  revolution (endpoints preserved, loop stays seamless).

## Control Section Inventory (by product entity / workflow stage)

1. **Glaze** (entity: ceramic surface) — `Color` (color, default porcelain white),
   `Finish` (segmented: Matte | Glossy).
2. **Fracture** (workflow: breaking) — actions row `Vessel`: [Reset vessel], and
   nothing else. The break is authored entirely by clicking the bowl, so the
   quantities behind it are constants in `scene.ts`: warp seed (21), shards per
   strike (4 — more reads as confetti, and since strikes overlay, a smaller
   first batch buys more strikes before the cap), crack branching (35% — it only ever
   redistributed a fixed seed budget, so it changed which cracks appeared but
   never how many), and shatter spread (18% — on screen for one second of an
   automatic beat).
3. **Gold Seam** (entity: repair material) — `Width` (slider), `Relief` (slider,
   how proud the bead sits), `Metal color` (color, default gold).
4. **Turntable** (workflow: motion) — `Auto-rotate` (switch, default on),
   `Easing` (select: Linear | Smooth, default Linear).
5. **Orientation** (entity: object pose) — `X`, `Y`, `Z` rotation sliders
   (−180°..180°, direct-authored orientation offsets).
6. Runtime-owned: Setup (settings transfer, aspect/size, resolution scale,
   Timeline switch), **Background** (Include + `scene.background` color, label
   off), **Image Export** (format PNG/JPG, resolution 2K/4K/8K default 4K),
   **Video Export** (format MP4/WebM, resolution Current/4K), sticky
   `panelActions`: Export Video, Export PNG (icon `upload-simple`).

## Animation Intent Inventory

- Classification: **playback timeline** (top Toolcraft timeline).
- Timeline drives the turntable loop: yaw = easing(loopProgress) × 360°. Seamless
  forward-only; duration edits change revolution period only, not scene design.
- `panels.timeline.defaultDurationSeconds: 8` — the loop period is user
  preference (one revolution per loop by construction); 8s is the starting value,
  duration edits are fully supported and export follows timeline duration.
- The strike cycle (shatter, hold, repair) is a triggered one-shot product
  transition (simulation-owned), not timeline animation; exports render the
  settled state.
- Video export required ⇒ top timeline required.

## Renderer technique

- three.js WebGL (`three` npm dep) in a custom `canvasContent` renderer,
  `renderDefaultCanvasMedia: false` not needed (no media), runtime canvas backing
  preserved; product background drawn only when Include is on
  (`shouldIncludeToolcraftPreviewBackground`).
- Bowl: LatheGeometry-style parametric shell — outer surface, inner surface, rim,
  foot ring — generated on a shared (θ, t) grid.
- Fracture: seeded Voronoi in (θ, t) parameter space with wrap-around θ, per-seed
  distance noise for organic boundaries, branching = satellite seeds. Ownership
  is resolved once per strike (the running nearest-seed sampled at each batch
  boundary, so one pass over the seeds yields every generation) and a vertex's
  shard is the tuple of those per-strike owners — cracks are cut wherever any
  generation disagrees, which is what makes earlier breaks permanent. A boundary
  edge is solved against the seed pair of the earliest generation its two cells
  disagree on. Faces are assigned to cells by centroid; per-shard
  BufferGeometries are rebuilt only when fracture inputs change. Fracture side walls: quads bridging outer↔inner along
  boundary edges (bisque/unglazed material) so shards read as solid ceramic.
- Gold seams: boundary edges chained into polylines, Catmull-Rom smoothed, swept
  with a half-elliptical raised profile aligned to surface normals on both outer
  and inner surfaces; metallic PBR material (metalness 1, low roughness, subtle
  per-vertex width jitter + normal perturbation for hand-applied sparkle).
- Lighting: PMREM RoomEnvironment for reflections, key/fill/rim lights, ACES tone
  mapping, soft shadow under the vessel.
- Performance budget: real-time 3D scene budget, not flat-shader budget — density
  hard-capped (max ~28 shards), moderate tessellation, shared materials, geometry
  rebuild only on fracture-input change; uniform-only updates for glaze/seam
  color/finish; animation work suspended during runtime viewport drag/zoom.

## Export

- PNG: `createToolcraftPngExportCanvas` with selected image resolution; offline
  WebGL render at export pixel size, drawn into the export 2D canvas;
  `includeBackground` respected (transparent when off).
- Video: offline rendered-frame export over runtime timeline duration with
  timeline-based timestamps via WebCodecs `VideoEncoder` + `mp4-muxer` /
  `webm-muxer` (product deps); MIME/capability checked before choosing container;
  `getToolcraftVideoExportSize`; video always keeps background. MediaRecorder is
  not used as the duration mechanism.

## Persistence

- Explicit policy: persist user-edited control values (`persistence.include:
  ["values"]`) so glaze/fracture/seam settings survive reload; reload restoration
  covered in browser acceptance.

## Layers

- None: single-vessel product, no layer workflow.

## Custom controls

- None: every product setting maps to built-in controls (sliders, segmented,
  color, select, switch, actions, panelActions).

## Verification

- Tier 4 (first working product version, dependency changes): `npm run
  verify:perf` receipt → `npm run verify:final` → `npm run dev`.
