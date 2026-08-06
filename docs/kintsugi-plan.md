# Digital Kintsugi — Implementation Plan

Verification tier: Tier 4
Reason: fresh product delivery — schema, custom WebGL renderer, timeline, exports,
dependency additions (`three`, `mp4-muxer`, `webm-muxer`).
Run: `npm install`, `npm run verify:perf` (receipt), `npm run verify:final`, `npm run dev`.
Skip: nothing at the final gate; intermediate edits use targeted typecheck/unit runs.

## Dependencies

- Add `three` + `@types/three`, `mp4-muxer`, `webm-muxer` (product deps only;
  no protected config or script changes).

## Files

| File | Change |
| --- | --- |
| `src/app/app-schema.ts` | Full product schema per spec: editable-output canvas, renderScale, no upload, playback timeline (8s default), persistence values, control sections (Glaze, Fracture, Gold Seam, Turntable, Orientation), Background, Image Export, Video Export, sticky panelActions. |
| `src/app/app-composition.tsx` | `canvasContent` hosting the 3D renderer component; `onPanelAction` for the Reset vessel section action + Export PNG / Export Video promises. |
| `src/app/kintsugi/vessel-profile.ts` | Bowl profile curve + shared (θ,t) parametric surface sampling (outer/inner/rim/foot), normals. |
| `src/app/kintsugi/fracture.ts` | Seeded RNG, per-impact Voronoi seed batches (equal-radius rosette ring centred on the clicked point, sized to the nearest existing seed and two or three rays wide depending on how near existing damage the click landed, so the break originates on the click and reads as a junction there, + branching satellites outside it), noisy cell assignment, per-shard geometry build, fracture side walls, shard rest/scatter transforms, raycast-hit → (θ, s) conversion. |
| `src/app/kintsugi/seams.ts` | Boundary edge chaining → polylines → smoothed swept gold ribbon geometry (outer+inner), ordered for drawRange reveal. |
| `src/app/kintsugi/scene.ts` | Imperative three.js scene manager class: renderer, PMREM RoomEnvironment, lights, shadow, materials, orbit/dolly pointer handling, turntable, settle tweens, resize/renderScale, offline render-to-size for exports, dispose. |
| `src/app/kintsugi/kintsugi-canvas.tsx` | React bridge: canvas element, scene manager lifecycle, subscribes to runtime state/timeline, viewport-interaction suspension, `data-toolcraft-product-output`. |
| `src/app/kintsugi/video-export.ts` | Offline frame loop → WebCodecs VideoEncoder → mp4-muxer/webm-muxer with timeline timestamps; capability check; `getToolcraftVideoExportSize`. |
| `src/app/kintsugi/png-export.ts` | `createToolcraftPngExportCanvas` wiring with offline WebGL render. |
| `src/app/app-acceptance-data.ts` | `mode: "product"`, transfer mode animation intent, `appControlSectionInventory`, full acceptance matrix rows for every visible entity, timelineLoopProof, rendererPipeline if typed there. |
| `src/app/app-performance.ts` | Renderer technique matrix, rendererPipeline inventory, workload scenarios (density hard limit, seam width, reset action, export-copy scenarios, viewport drag/zoom). |
| `docs/toolcraft/agent-worklog.md` | Product mode, decision trail, decisions, evidence, verification. |
| `e2e/` app-owned additions | Only if required rows aren't covered by the generic harness (prefer typed acceptance config + protected recipes). |

## Schema targets → renderer mapping

| Target | Renderer effect | Invalidates |
| --- | --- | --- |
| `vessel.glazeColor` | glaze material color uniform | material only |
| `vessel.finish` | roughness/clearcoat preset | material only |
| canvas click on the vessel (no target) | appends an impact, rebuilds, runs the shatter → hold → repair cycle | shard+seam geometry rebuild + transforms + seam reveal |
| `vessel.reset` | clears the impact list back to a whole vessel | shard+seam geometry rebuild + seam reveal |
| `seam.width` / `seam.relief` | seam sweep profile | seam geometry rebuild only |
| `seam.color` | gold material color | material only |
| `turntable.autoRotate` / `turntable.easing` | timeline-driven yaw | per-frame transform |
| `object.rotX/rotY/rotZ` | vessel group rotation offsets | per-frame transform |
| `scene.background` + `export.includeBackground` | scene clear color / transparent | frame |
| `canvas.size` / `canvas.renderScale` | renderer size/backing scale | resize |
| timeline time/duration | turntable phase | per-frame |

## Export paths

- PNG: sticky `Export PNG` → offline render at `export.image.resolution` →
  `createToolcraftPngExportCanvas` → download; format select honors JPG.
- Video: sticky `Export Video` → offline frame loop at chosen fps (30) over
  runtime timeline duration, timeline timestamps into WebCodecs → muxer →
  download; `reportProgress` determinate; background always kept.
- Settings transfer: runtime-owned (Setup).

## Acceptance / performance coverage (Tier 4)

- Acceptance rows: every control section + action + export + background +
  persistence reload + timeline loop proof + orbit/turntable behavior evidence.
- Performance: density at hard limit workload, live slider responsiveness
  (seam width with density workload fixture), shatter/repair action change
  evidence, export-copy download completion evidence for both exports, viewport
  drag/zoom stability with animated renderer, render scale.
- Commands: `npm run ai:check` → `npm run test` → `npm run verify:perf` →
  `npm run verify:final` → `npm run dev` (report URL).

## Order of work

1. `npm install` deps.
2. Schema + acceptance-data skeleton (product mode) so tests target real config.
3. Geometry modules (profile → fracture → seams) with unit-testable pure cores.
4. Scene manager + React bridge; static whole bowl first, then shatter/settle,
   then seam reveal.
5. Click-to-strike cycle and the Reset panel action, then PNG export, then video export.
6. Performance matrix + acceptance matrix completion + worklog.
7. Browser verify loop; perf receipt; final gate; dev server.
