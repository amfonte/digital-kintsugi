import type { SeamParamPath, SeamParamPoint } from "./fracture";
import { createSeamWidthModel, seamHalfWidthAt } from "./seam-width";
import type { SeamWidthModel } from "./seam-width";
import type { SurfaceSample, VesselSurfaces } from "./vessel-profile";

export type SeamGeometrySource = {
  // Per-vertex signed coverage (positive inside the gold, negative just outside).
  // The mesh is emitted one ring past the edge and the fragment shader discards
  // where interpolated coverage < 0, giving a smooth sub-cell silhouette.
  coverages: Float32Array;
  // Per-vertex face tag: 0 = outer shell face, 1 = inner + over-lip face. The
  // two faces are separate grids that meet at the rim; a pure-metal seam reflects
  // each face's normals differently, so the gold shader uses this to colour-match
  // the outer face to the inner one (see goldMaterial in scene.ts).
  faces: Float32Array;
  // Indexed triangle list over a shared (theta, coord) grid.
  index: Uint32Array;
  normals: Float32Array;
  // Per-vertex displacement from the vessel surface. The reveal shader collapses
  // this at the advancing front so the gold flows up out of the crack.
  offsets: Float32Array;
  positions: Float32Array;
  // Per-vertex reveal coordinate: network distance from the origin.
  reveals: Float32Array;
  revealMax: number;
  totalVertexCount: number;
  uvs: Float32Array;
};

export type SeamSettings = {
  // Half-width of the open channel between shards; the gold fills it.
  gapHalf?: number;
  // Relief scale and repair "generosity" (how fat the gold pools at hotspots).
  relief: number;
  seed: number;
  width: number;
  // Shared width model from the fracture cutter: the gold fills exactly the
  // crack the shards opened, so it reads as filling a gap, not painting over it.
  // Optional; when omitted (e.g. unit tests) a default model derived from
  // `width` is used, giving generosity-scaled body with no junction pools.
  widthModel?: SeamWidthModel;
};

type Vec3 = { x: number; y: number; z: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Smooth minimum (IQ polynomial): unions distance fields with a rounded blend,
// so cracks meeting at a junction bulge into a seamless fillet.
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-9) {
    return Math.min(a, b);
  }

  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));

  return b + (a - b) * h - k * h * (1 - h);
}

// The face grids start at the pole itself. They used to start at s = 0.02 (world
// radius 0.025 on the 0.2225-radius base), which punched a hole clean through the
// gold at the bowl's center. coord = 0 is a degenerate ring — every column is the
// same point on the axis — so the innermost band is closed with a triangle fan to
// one shared pole vertex instead of quads (see hasPole in buildGrid).
const seamMinS = 0;

// Where a gold vertex collapses to at the advancing front of the pour. The gold
// shader reconstructs `spine = position - aOffset` and scales the offset by the
// fill parameter, so the spine is the line the cross-section shrinks onto.
//
// At 0 each face grid collapses onto its OWN skin and each side wall onto its own
// depth row, so at the front the seam is a zero-width ribbon spanning the FULL
// wall depth. At 1 everything resolves to the mid-wall axis instead and the shell
// closes to a point.
//
// SHIPS AT 0, and that is a measured result, not the default surviving by
// inertia. 1 and 0.5 were both rendered against 0 across a pinned pour sweep.
// Converging on the axis drags every cap vertex up to half a wall thickness off
// its final position mid-fill, and at a rim crossing — where the ceramic is
// thinnest and the notch is already complex — that is enough to push gold through
// the shard: the crossing sheds fins and translucent slivers and shows ceramic
// through the middle of the bead for a good part of the pour. 0.5 halved it
// without clearing it. Meanwhile 0 loses nothing that matters: the tip is rounded
// by uTipRound in the shader, not by this, and a front that stays full-depth is
// arguably the better read of gold filling a crack anyway.
const capSpineDepth = 0;

// Side-wall placement, as a fraction of the model half-width. The shard edge
// retreats to 0.9 and the cap covers to goldFill = 1.1, so a wall anywhere in
// (0.9, 1.1] would be buried inside the ceramic and never seen. 0.85 lines the
// slot just inside the shard face, with enough clearance not to z-fight it.
const wallFill = 0.85;

// How far the wall's normals tilt toward the cap they meet. The wall is flat —
// there is no room to round it, the ceramic is ~6e-4 away — but at metalness 1
// the normal IS the appearance, so tilting the end rows makes the reflection
// roll over from side-facing to cap-facing and the junction reads as a rounded
// bead instead of a crease.
const wallNormalBlend = 0.6;

// The fill arrives marginally before the caps it hides behind. Lagging by even
// one frame shows a sliver of void at the front; leading reads as gold running
// down inside the crack and then welling up to the surface.
const wallRevealLead = 0.01;

// Field/mesh resolution over (theta, s). Only cells near the network are touched.
const gridThetaCount = 1024;
const faceRowCount = 224;
const rimRowCount = 24;

function smoothParamPath(path: SeamParamPath): SeamParamPoint[] {
  const source = path.points.map((point) => ({ ...point }));

  if (source.length < 3) {
    return source;
  }

  const lastIndex = source.length - 1;

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const previousPass = source.map((point) => ({ ...point }));

    for (let index = 0; index < source.length; index += 1) {
      const isEndpoint = index === 0 || index === lastIndex;

      if (isEndpoint && !path.closed) {
        continue;
      }

      const before = index === 0 ? previousPass[lastIndex - 1] : previousPass[index - 1];
      const after = index === lastIndex ? previousPass[1] : previousPass[index + 1];

      source[index] = {
        s: previousPass[index].s * 0.5 + (before.s + after.s) * 0.25,
        theta: previousPass[index].theta * 0.5 + (before.theta + after.theta) * 0.25,
      };
    }

    if (path.closed) {
      source[lastIndex] = { ...source[0] };
    }
  }

  return source;
}

function resampleParamPath(
  points: readonly SeamParamPoint[],
  surfaces: VesselSurfaces,
): { cumulative: number[]; length: number; samples: SeamParamPoint[] } {
  if (points.length < 2) {
    return { cumulative: [0], length: 0, samples: [...points] };
  }

  const worldPoints = points.map((point) => surfaces.midpointAt(point.theta, clamp01(point.s)));
  const cumulativeIn: number[] = [0];

  for (let index = 1; index < worldPoints.length; index += 1) {
    cumulativeIn.push(
      cumulativeIn[index - 1] +
        Math.hypot(
          worldPoints[index].x - worldPoints[index - 1].x,
          worldPoints[index].y - worldPoints[index - 1].y,
          worldPoints[index].z - worldPoints[index - 1].z,
        ),
    );
  }

  const totalLength = cumulativeIn[cumulativeIn.length - 1];
  const spacing = 0.01;
  const ringCount = Math.min(320, Math.max(2, Math.ceil(totalLength / spacing)));
  const samples: SeamParamPoint[] = [];
  const cumulative: number[] = [];
  let cursor = 0;

  for (let ring = 0; ring <= ringCount; ring += 1) {
    const target = (ring / ringCount) * totalLength;

    while (cursor < cumulativeIn.length - 2 && cumulativeIn[cursor + 1] < target) {
      cursor += 1;
    }

    const spanStart = cumulativeIn[cursor];
    const spanEnd = cumulativeIn[cursor + 1];
    const local = spanEnd > spanStart ? (target - spanStart) / (spanEnd - spanStart) : 0;
    const a = points[cursor];
    const b = points[cursor + 1];

    samples.push({
      s: a.s + (b.s - a.s) * local,
      theta: a.theta + (b.theta - a.theta) * local,
    });
    cumulative.push(target);
  }

  return { cumulative, length: totalLength, samples };
}

// A capsule segment of the gold vein: a rounded tube from A to B with end radii.
type Segment = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  c0: number;
  c1: number;
  // Consecutive segments sharing a chain id are ONE dense run of capsules over
  // the same cells and are combined with a true min before they touch the
  // field; see the splat loop. Undefined = splat on its own.
  chain?: number;
  ra: number;
  rb: number;
  reveal: number;
  t0: number;
  t1: number;
};

export function buildSeamGeometry(
  surfaces: VesselSurfaces,
  paths: readonly SeamParamPath[],
  settings: SeamSettings,
): SeamGeometrySource {
  const gapHalf = settings.gapHalf ?? 0.0042;
  const relief = settings.relief;
  const widthModel =
    settings.widthModel ??
    createSeamWidthModel({
      generosity: settings.width,
      poolCenters: new Float32Array(0),
      seed: settings.seed,
    });
  // The gold laps slightly over the cut walls (which have their own thickness)
  // so no bare sliver of open crack shows at the seam edge.
  const goldFill = 1.1;
  // Smooth-min blend radius for splatting capsules into the field. Kept BELOW a
  // thin neck's half-width (was gapHalf * 2.4 ~= 0.013, which is wider than a thin
  // run and bridged thin necks back up to the fat width — so the vein rendered as
  // uniformly thick even though the width model varied 4x). At gapHalf * 1.35 the
  // blend still irons out capsule-joint scallop but no longer fills thin runs, so
  // the thin<->thick variation survives to the silhouette. Explicit pool centers
  // (not blendK) carry the junction blooms, so sharpening this doesn't lose them.
  const blendK = gapHalf * 1.35;

  // Each face grid is extended past s = 1 out over its OWN HALF of the lip, and
  // the two meet at the crest.
  //
  // It used to be the inner grid alone that ran the whole way over: coord in
  // [1, 1+rimExtend] mapped inner edge -> over the top -> outer edge, and the
  // outer grid stopped dead at s = 1. That is literally the inner seam wrapping
  // over the top lip to reach the outer one, and it is what the render showed —
  // tinting the two grids apart put a single slab of INNER gold across the whole
  // lip with the outer vein emerging from underneath it. Splitting the lip means
  // neither face laps over the other: each vein climbs its own skin, crosses its
  // own half of the rim, and they join at the top edge.
  const faceDCoord = (1 - seamMinS) / faceRowCount;
  // Rows spanning the FULL lip, outer edge -> inner edge. Each grid carries half.
  const rimExtraRows = 10;
  const rimHalfRows = rimExtraRows / 2;
  // Built past the crest but never meshed. `emitVertex` differences row j+1
  // against j-1, so without them each grid would take a one-sided difference at
  // the crest, the two would disagree, and a mirror-metal surface turns that into
  // a hard brightness line along the top of the rim.
  const rimGuardRows = 2;
  const rimExtend = rimExtraRows * faceDCoord;
  const rimHalfExtend = (rimHalfRows + rimGuardRows) * faceDCoord;

  // The lip used to get its relief flattened to 0.18 of the faces', to stop the
  // crossing reading as a raised plateau strapped over the rim. It did not read
  // as a filled notch either — it read as a flat pale PLATE, because a level
  // upward-facing patch of metalness-1 gold just mirrors the sky evenly while the
  // veins beside it are rounded and shade. The flare it was compensating for was
  // the real problem and is fixed at the source (rim pools now bloom over ~2 wall
  // thicknesses instead of one, so the swell runs down the vein instead of
  // stacking on the lip). At full relief the crossing is the same rounded ridge
  // as the vein, carried over the rim.

  // How much reveal distance the gold spends crossing the lip, in the same
  // world-distance units as every other reveal (the vessel is fixed scale, so
  // this is directly comparable: revealMax lands near 2.2). Deliberately wider
  // than the shader's reveal band (0.14) so the crest is its own beat rather
  // than one more band-width of front travel — this is the moment the eye is on.
  const rimCrestReveal = 0.22;

  type Centerline = {
    closed: boolean;
    cumulative: number[];
    endKind: SeamParamPath["endKind"];
    length: number;
    samples: SeamParamPoint[];
    startKind: SeamParamPath["startKind"];
  };

  const centerlines: Centerline[] = [];

  for (const path of paths) {
    const resampled = resampleParamPath(smoothParamPath(path), surfaces);

    if (resampled.samples.length < 2 || resampled.length < 1e-4) {
      continue;
    }

    centerlines.push({
      closed: path.closed,
      cumulative: resampled.cumulative,
      endKind: path.endKind,
      length: resampled.length,
      samples: resampled.samples,
      startKind: path.startKind,
    });
  }

  // ---- Reveal graph: geodesic-ish distance from an origin near the pole. ----
  const nodeKeyFor = (point: SeamParamPoint): string => {
    // Every theta collapses to the same world point at s = 0, so runs arriving
    // at the bowl's center must share ONE node key or the graph tears apart
    // exactly where the network is most connected — each run would be its own
    // component and the reveal front would restart at every branch.
    if (point.s < 1e-4) {
      return "pole";
    }

    const twoPi = Math.PI * 2;
    const wrapped = ((point.theta % twoPi) + twoPi) % twoPi;

    return `${Math.round(wrapped * 4000)}|${Math.round(point.s * 4000)}`;
  };
  const worldAt = (point: SeamParamPoint): Vec3 => {
    const s = clamp01(point.s);
    const outer = surfaces.outerPoint(point.theta, s);
    const inner = surfaces.innerPoint(point.theta, s);

    return {
      x: (outer.x + inner.x) / 2,
      y: (outer.y + inner.y) / 2,
      z: (outer.z + inner.z) / 2,
    };
  };

  const nodeDistance = new Map<string, number>();
  const nodePosition = new Map<string, Vec3>();
  const edges: Array<{ a: string; b: string; length: number }> = [];

  for (const line of centerlines) {
    if (line.closed) {
      continue;
    }

    const aKey = nodeKeyFor(line.samples[0]);
    const bKey = nodeKeyFor(line.samples[line.samples.length - 1]);

    if (!nodePosition.has(aKey)) {
      nodePosition.set(aKey, worldAt(line.samples[0]));
      nodeDistance.set(aKey, Number.POSITIVE_INFINITY);
    }

    if (!nodePosition.has(bKey)) {
      nodePosition.set(bKey, worldAt(line.samples[line.samples.length - 1]));
      nodeDistance.set(bKey, Number.POSITIVE_INFINITY);
    }

    edges.push({ a: aKey, b: bKey, length: line.length });
  }

  let originKey: string | null = null;
  let originRadial = Number.POSITIVE_INFINITY;

  for (const [key, position] of nodePosition) {
    const radial = Math.hypot(position.x, position.z);

    if (radial < originRadial) {
      originRadial = radial;
      originKey = key;
    }
  }

  const originPosition = originKey ? nodePosition.get(originKey)! : { x: 0, y: 0, z: 0 };

  if (originKey) {
    nodeDistance.set(originKey, 0);
  }

  for (let pass = 0; pass <= nodePosition.size; pass += 1) {
    let changed = false;

    for (const edge of edges) {
      const da = nodeDistance.get(edge.a)!;
      const db = nodeDistance.get(edge.b)!;

      if (da + edge.length < db) {
        nodeDistance.set(edge.b, da + edge.length);
        changed = true;
      }

      if (db + edge.length < da) {
        nodeDistance.set(edge.a, db + edge.length);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  for (const [key, distance] of nodeDistance) {
    if (!Number.isFinite(distance)) {
      const position = nodePosition.get(key)!;

      nodeDistance.set(
        key,
        Math.hypot(
          position.x - originPosition.x,
          position.y - originPosition.y,
          position.z - originPosition.z,
        ),
      );
    }
  }

  // ---- Build capsule segments per surface. ----
  const outerSegments: Segment[] = [];
  const innerSegments: Segment[] = [];
  let nextChain = 0;

  // Per-sample run data, kept for buildCrackFill: the two face grids are
  // heightfields over their own skin and know nothing about the space between
  // them, so the fill needs the raw pairs of skin points to span the wall.
  type FillNode = { r: number; reveal: number; s: number; theta: number; w: Vec3 };
  type FillRun = {
    closed: boolean;
    endKind: SeamParamPath["endKind"];
    inner: FillNode[];
    outer: FillNode[];
    startKind: SeamParamPath["startKind"];
  };
  const fillRuns: FillRun[] = [];

  centerlines.forEach((line, lineIndex) => {
    void lineIndex;
    const count = line.samples.length;
    const lastIndex = count - 1;
    const startNodeDistance = line.closed ? 0 : nodeDistance.get(nodeKeyFor(line.samples[0])) ?? 0;
    const endNodeDistance = line.closed
      ? 0
      : nodeDistance.get(nodeKeyFor(line.samples[lastIndex])) ?? 0;

    let closedBase = 0;
    let closedNearest = 0;

    if (line.closed) {
      let best = Number.POSITIVE_INFINITY;

      line.samples.forEach((sample, index) => {
        const world = worldAt(sample);
        const distance = Math.hypot(
          world.x - originPosition.x,
          world.y - originPosition.y,
          world.z - originPosition.z,
        );

        if (distance < best) {
          best = distance;
          closedNearest = index;
        }
      });

      closedBase = best;
    }

    // Per-sample radius + reveal, then stitched into capsules.
    const outerNodes: FillNode[] = [];
    const innerNodes: FillNode[] = [];

    for (let index = 0; index < count; index += 1) {
      const sample = line.samples[index];
      const along = line.cumulative[index] ?? 0;

      let tipScale = 1;

      if (!line.closed) {
        if (line.startKind === "tip") {
          tipScale = Math.min(tipScale, 0.3 + 0.12 * index);
        }

        if (line.endKind === "tip") {
          tipScale = Math.min(tipScale, 0.3 + 0.12 * (lastIndex - index));
        }
      }

      tipScale = Math.min(1, tipScale);

      const outer = surfaces.outerPoint(sample.theta, clamp01(sample.s));
      const inner = surfaces.innerPoint(sample.theta, clamp01(sample.s));
      const midX = (outer.x + inner.x) * 0.5;
      const midY = (outer.y + inner.y) * 0.5;
      const midZ = (outer.z + inner.z) * 0.5;
      // Gold half-width == the crack the shards opened here (shared model),
      // lapped slightly over the walls; tips taper to a point.
      const radius = tipScale * goldFill * seamHalfWidthAt(widthModel, midX, midY, midZ);
      const reveal = line.closed
        ? closedBase +
          Math.min(
            Math.abs(along - (line.cumulative[closedNearest] ?? 0)),
            line.length - Math.abs(along - (line.cumulative[closedNearest] ?? 0)),
          )
        : Math.min(startNodeDistance + along, endNodeDistance + (line.length - along));

      outerNodes.push({ r: radius, reveal, s: sample.s, theta: sample.theta, w: outer });
      innerNodes.push({ r: radius, reveal, s: sample.s, theta: sample.theta, w: inner });
    }

    fillRuns.push({
      closed: line.closed,
      endKind: line.endKind,
      inner: innerNodes,
      outer: outerNodes,
      startKind: line.startKind,
    });

    // One chain id per RUN, covering its vein on both skins and both of its rim
    // crossings. smin is not idempotent, so splatting a run's own capsules into
    // the field one at a time shaves the field a little further with every call;
    // resolving the run against itself with a true min first and blending once
    // keeps a vein the width the model asked for.
    //
    // The rim crossing belongs in that same chain. It used to get its own, so a
    // vein and the crossing it feeds met through smin, which drops the field by
    // up to blendK/4 at the elbow where they turn and swells the gold by that
    // much along the lip. (It is worth ~blendK/4 = 0.002 world and is NOT what
    // made the visible collar at each crossing — that was the gold's lap onto
    // the lip, see rimLipLap in fracture.ts — but a run should not smin against
    // itself either way.) Chains only need to be CONTIGUOUS in each segment
    // list, and a run pushes its vein and then its crossings with nothing in
    // between, so one id per run is enough.
    const chain = nextChain;

    nextChain += 1;

    const stitch = (
      nodes: typeof outerNodes,
      target: Segment[],
      coordOf: (n: (typeof outerNodes)[number]) => number,
    ): void => {
      for (let index = 0; index < nodes.length - 1; index += 1) {
        const a = nodes[index];
        const b = nodes[index + 1];

        target.push({
          ax: a.w.x,
          ay: a.w.y,
          az: a.w.z,
          bx: b.w.x,
          by: b.w.y,
          bz: b.w.z,
          c0: coordOf(a),
          c1: coordOf(b),
          chain,
          ra: a.r,
          rb: b.r,
          reveal: (a.reveal + b.reveal) * 0.5,
          t0: a.theta,
          t1: b.theta,
        });
      }
    };

    stitch(outerNodes, outerSegments, (n) => n.s);
    stitch(innerNodes, innerSegments, (n) => n.s);

    // Rim crossing: capsule chains laid across the lip, splatted into BOTH face
    // grids — the whole chain into each, in that grid's own coord space, so the
    // two halves are cut out of the SAME distance field and agree exactly where
    // they meet at the crest. (The distances are world-space, so a capsule on the
    // far side of the lip contributes the honest distance to a near-side cell;
    // the row clamp only decides which cells get visited, and the chain id makes
    // the repeat visits a true min rather than a repeated smin.)
    //
    // The chain carries its own reveal RAMP. Handing every rim segment the one
    // endpoint reveal made the whole crest share a single reveal value, so the
    // lip — the most conspicuous gold on the vessel, and the last thing to
    // arrive — popped on in a single band width no matter how the pour was
    // eased. The ramp is symmetric: both skins reach the lip together (they share
    // a reveal at every sample) and the last gold to land is the crest, which is
    // exactly the two seams meeting at the rim.
    //
    // Each chain runs at CONSTANT theta, and that is right rather than merely
    // convenient: the crack surface through the wall is radial, so it meets the
    // lip in a constant-theta line. Skewing a chain along the crack's bearing
    // instead — which looks plausible, and does make the crossing read as the
    // vein continuing — walks the gold off the crack it is supposed to be
    // filling, and leaves bare ceramic in the notch behind it.
    const addRim = (theta: number, r: number, reveal: number): void => {
      // Fine enough that the crest advances ~1 grid row per segment; reveal is
      // assigned per nearest segment, so a coarse chain would step visibly.
      const steps = 12;
      const revealAt = (t: number): number =>
        reveal + (1 - Math.abs(2 * t - 1)) * rimCrestReveal;
      let prev: Vec3 | null = null;
      let prevT = 0;
      let prevReveal = 0;

      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const point = surfaces.rimPoint(theta, t);
        const nodeReveal = revealAt(t);

        if (prev) {
          const shared = {
            ax: prev.x,
            ay: prev.y,
            az: prev.z,
            bx: point.x,
            by: point.y,
            bz: point.z,
            chain,
            ra: r,
            rb: r,
            reveal: (prevReveal + nodeReveal) * 0.5,
            t0: theta,
            t1: theta,
          };

          // t runs 0 at the outer edge -> 1 at the inner edge; each grid counts
          // its own coord up from 1 at its own skin.
          outerSegments.push({ ...shared, c0: 1 + prevT * rimExtend, c1: 1 + t * rimExtend });
          innerSegments.push({
            ...shared,
            c0: 1 + (1 - prevT) * rimExtend,
            c1: 1 + (1 - t) * rimExtend,
          });
        }

        prev = point;
        prevT = t;
        prevReveal = nodeReveal;
      }
    };

    // The band is the vein's OWN radius — no mitre. An oblique crack used to
    // open a notch gap / sin α wide along the lip (the shard skins retreat
    // perpendicular to the crack, so their top-row edges slide sideways by that
    // much), and everything covering it had to be fattened to match; sin α
    // floors at 0.35, so a near-tangential ending got a band nearly 3x the vein
    // that fed it, lying square across the rim. fracture.ts now swings the
    // retreat round to the lip tangent over the last few rows instead, so the
    // channel meets the rim head-on at exactly `gap` and the vein's own width
    // covers it — and the lip is now CUT to that same width (`rimLipLap` in
    // fracture.ts) instead of to the narrower shard gap, so the band fills the
    // slot rather than lapping a flange of gold onto the ceramic either side.
    if (!line.closed && line.startKind === "rim") {
      addRim(line.samples[0].theta, outerNodes[0].r, outerNodes[0].reveal);
    }

    if (!line.closed && line.endKind === "rim") {
      addRim(
        line.samples[lastIndex].theta,
        outerNodes[lastIndex].r,
        outerNodes[lastIndex].reveal,
      );
    }
  });

  // The gold sits DOWN in the channel (base sunk below the surface) and crests
  // only slightly, so it reads as filling the gap rather than a bead painted on
  // top. Shared with buildCrackFill, whose side walls have to land ON the cap
  // surface rather than at the skin.
  const baseSink = relief * 0.28;

  // ---- Grid mesher over one surface. ----
  const positions: number[] = [];
  const normals: number[] = [];
  const offsets: number[] = [];
  const reveals: number[] = [];
  const coverages: number[] = [];
  const faces: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let revealMax = 0;

  const buildGrid = (
    surfaceFn: (theta: number, coord: number) => SurfaceSample,
    pointFn: (theta: number, coord: number) => Vec3,
    rowCount: number,
    coordMin: number,
    coordMax: number,
    segments: readonly Segment[],
    normalToSurface: number,
    faceId: number,
    // Trailing rows built (so the last meshed row still gets a two-sided normal
    // stencil) but not themselves meshed.
    guardRows: number,
  ): void => {
    if (segments.length === 0) {
      return;
    }

    const cols = gridThetaCount;
    const rows = rowCount + 1;
    const total = cols * rows;
    const dTheta = (Math.PI * 2) / cols;
    const dCoord = (coordMax - coordMin) / rowCount;

    const field = new Float32Array(total).fill(1e9);
    const nearest = new Float32Array(total).fill(1e9);
    const radiusGrid = new Float32Array(total);
    const revealGrid = new Float32Array(total);
    const isTouched = new Uint8Array(total);
    const touchedList: number[] = [];

    const ptX = new Float32Array(total);
    const ptY = new Float32Array(total);
    const ptZ = new Float32Array(total);
    const ptDone = new Uint8Array(total);
    const pointAt = (i: number, j: number): Vec3 => {
      const idx = j * cols + i;

      if (!ptDone[idx]) {
        const created = pointFn(i * dTheta, coordMin + j * dCoord);

        ptX[idx] = created.x;
        ptY[idx] = created.y;
        ptZ[idx] = created.z;
        ptDone[idx] = 1;
      }

      return { x: ptX[idx], y: ptY[idx], z: ptZ[idx] };
    };

    // The mid-wall axis under this cell — the line the cross-section collapses
    // onto at the front (see capSpineDepth).
    //
    // FACES ONLY. Over the lip the blend ramps back to 0 and the gold collapses
    // onto the lip surface exactly as it always did. That is not a special case
    // to keep the code quiet: the two caps already MEET at the crest, so there
    // are no separate strips to join there and nothing for a shared spine to
    // fix. Running it over the lip anyway is actively wrong — the axis is only
    // defined for coord <= 1, so every lip vertex collapsed toward the lip's
    // BASE CHORD midpoint ~0.011 below the crest, which dragged the rim gold
    // down into the ceramic mid-pour and shed fins and see-through slivers all
    // around the crossing.
    const spineX = new Float32Array(total);
    const spineY = new Float32Array(total);
    const spineZ = new Float32Array(total);
    const spineDone = new Uint8Array(total);
    const spineAt = (i: number, j: number): Vec3 => {
      const idx = j * cols + i;

      if (!spineDone[idx]) {
        const created = surfaces.midpointAt(i * dTheta, clamp01(coordMin + j * dCoord));

        spineX[idx] = created.x;
        spineY[idx] = created.y;
        spineZ[idx] = created.z;
        spineDone[idx] = 1;
      }

      return { x: spineX[idx], y: spineY[idx], z: spineZ[idx] };
    };

    const sampleCache = new Array<SurfaceSample | undefined>(total);
    const sampleAt = (i: number, j: number): SurfaceSample => {
      const idx = j * cols + i;
      const cached = sampleCache[idx];

      if (cached) {
        return cached;
      }

      const created = surfaceFn(i * dTheta, coordMin + j * dCoord);

      sampleCache[idx] = created;

      return created;
    };

    const rowRadius = new Float32Array(rows);
    const rowArc = new Float32Array(rows);

    for (let j = 0; j < rows; j += 1) {
      const here = pointFn(0, coordMin + j * dCoord);
      // The LAST row has no row above it, so difference it downward. Taking
      // min(rowCount, j + 1) there measured a row against itself: rowArc came out
      // as the 1e-4 divide guard rather than a real spacing, and any capsule whose
      // coord landed on that row got dj = reach / 1e-4 ~= 190 rows — a splat
      // stripe down most of the vessel, ~20k stray touched cells and the vertices
      // that come with them. Invisible in the render (a distance field is still a
      // distance field however many cells you evaluate it in) but it was quietly
      // spending a tenth of the seam vertex budget.
      const next = pointFn(0, coordMin + (j < rowCount ? j + 1 : j - 1) * dCoord);

      // TRUE ring radius. This used to be floored at 0.05, which silently lied
      // about the near-pole rows: a column step there spans far less world arc
      // than the floor claims, so the splat's theta half-span below came out
      // several times too narrow and every capsule approaching the center was
      // clipped off mid-run. The floor here is only a divide-by-zero guard; the
      // half-span is bounded properly by halfCols instead.
      rowRadius[j] = Math.max(1e-4, Math.hypot(here.x, here.z));
      rowArc[j] = Math.max(1e-4, Math.hypot(next.x - here.x, next.y - here.y, next.z - here.z));
    }

    // Column step for the theta arm of each vertex's normal stencil. Rings shrink
    // toward the pole while the row spacing does not, so with a fixed one-column
    // arm the stencil goes wildly anisotropic down there: at the first ring the
    // two theta neighbours are 3e-5 apart in world space against a 5.5e-3 row
    // step, so the cross product is all round-off and the gold shades as a
    // starburst of radial spokes. Widening the arm to match the row spacing keeps
    // the tangent basis roughly square at every radius. Rows out on the wall are
    // already near-square and keep a one-column arm.
    // Widest usable column half-span: -halfCols..halfCols must stay under `cols`
    // columns so a capsule that reaches all the way around a tiny near-pole ring
    // never visits the same cell twice (smin is not idempotent — a repeat splat
    // would shave another 0.25 * blendK off the field and bulge the gold there).
    const halfCols = Math.floor((cols - 1) / 2);
    const normalStep = new Int32Array(rows);
    // Innermost rings are smaller than the field's own blend radius, so the field
    // holds no angular detail there at all — it is blurred flat across the whole
    // ring, the crest saturates, and the gold is simply the vessel surface pushed
    // out by a constant. Its normal is therefore the vessel normal, and every
    // per-column difference is round-off dressed up as shading (a sunburst of
    // spokes at the bowl's centre). Hand those rows the surface normal, ramped in
    // smoothly so the pool's outer slope keeps shading itself.
    const poleNormalBlend = new Float32Array(rows);

    for (let j = 0; j < rows; j += 1) {
      const angularArm = rowArc[j] / rowRadius[j];

      normalStep[j] = Math.max(1, Math.min(halfCols, Math.round(angularArm / dTheta)));

      // `angularArm` is how much of the ring the stencil has to span to stay
      // square — the honest measure of how degenerate this row is. Out on the
      // wall it is a few hundredths of a radian and the difference is a true
      // local tangent; approaching the pole it grows without bound and the
      // "tangent" becomes a secant across a large arc, so the normal it yields is
      // noise. Where the crest is saturated (which is exactly where this happens)
      // the gold is the vessel surface offset by a constant, so the vessel normal
      // is not a fudge — it is the right answer.
      const ramp = clamp01((angularArm - 0.03) / 0.12);

      poleNormalBlend[j] = ramp * ramp * (3 - 2 * ramp);
    }

    // Splat every capsule into the field via smooth-min — except that smin is
    // NOT idempotent: each call shaves up to blendK/4 off the field even when
    // the two capsules coincide. Along a centerline that is harmless (the
    // capsules march past each other a row at a time), but the rim crossing
    // packs a dozen capsules into the width of the lip, so every lip cell was
    // smin'd a dozen times and the field there sank ~2-3x blendK below the true
    // distance. That is what turned each rim ending into a flat-topped rivet
    // head wider than the vein feeding it. Segments carrying the same chain id
    // are therefore resolved among themselves with a true min first, and blend
    // into the field exactly once.
    const chainField = new Float32Array(total).fill(1e9);
    const chainTouched: number[] = [];

    const splatSegment = (seg: Segment, intoChain: boolean): void => {
      const abx = seg.bx - seg.ax;
      const aby = seg.by - seg.ay;
      const abz = seg.bz - seg.az;
      const abLenSq = abx * abx + aby * aby + abz * abz || 1e-9;
      const rMax = Math.max(seg.ra, seg.rb);
      const twoPi = Math.PI * 2;
      const ct = (((seg.t0 + seg.t1) * 0.5) % twoPi + twoPi) % twoPi;
      const cc = (seg.c0 + seg.c1) * 0.5;
      const jc = Math.round((cc - coordMin) / dCoord);
      const ic = Math.round(ct / dTheta);
      const jMetric = Math.max(0, Math.min(rowCount, jc));
      const reach = rMax + blendK + rowArc[jMetric] * 1.5;
      const spanTheta = Math.abs(seg.t1 - seg.t0);
      const spanCoord = Math.abs(seg.c1 - seg.c0);
      const halfSpanTheta = Math.ceil(spanTheta / dTheta / 2);
      const dj = Math.ceil(spanCoord / dCoord / 2) + Math.max(1, Math.ceil(reach / rowArc[jMetric]));

      for (let jj = Math.max(0, jc - dj); jj <= Math.min(rowCount, jc + dj); jj += 1) {
        // Per-ROW theta half-span. Rings shrink toward the pole, so one column
        // covers less and less world arc; a single half-span taken at the
        // capsule's own row would under-reach on every row inside it. Rows tight
        // enough that `reach` wraps the whole ring simply take all of it.
        const di = Math.min(
          halfCols,
          halfSpanTheta + Math.max(1, Math.ceil(reach / (rowRadius[jj] * dTheta))),
        );

        for (let d = -di; d <= di; d += 1) {
          const ii = ((ic + d) % cols + cols) % cols;
          const point = pointAt(ii, jj);
          const apx = point.x - seg.ax;
          const apy = point.y - seg.ay;
          const apz = point.z - seg.az;
          const proj = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / abLenSq));
          const cxp = seg.ax + abx * proj;
          const cyp = seg.ay + aby * proj;
          const czp = seg.az + abz * proj;
          const rHere = seg.ra + (seg.rb - seg.ra) * proj;
          const distance =
            Math.hypot(point.x - cxp, point.y - cyp, point.z - czp) - rHere;
          const idx = jj * cols + ii;

          if (!isTouched[idx]) {
            isTouched[idx] = 1;
            touchedList.push(idx);
          }

          if (distance < nearest[idx]) {
            nearest[idx] = distance;
            radiusGrid[idx] = rHere;
            revealGrid[idx] = seg.reveal;
          }

          if (intoChain) {
            if (chainField[idx] > 1e8) {
              chainTouched.push(idx);
            }

            if (distance < chainField[idx]) {
              chainField[idx] = distance;
            }
          } else {
            field[idx] = smin(field[idx], distance, blendK);
          }
        }
      }
    };

    for (let index = 0; index < segments.length; ) {
      const chain = segments[index].chain;

      if (chain === undefined) {
        splatSegment(segments[index], false);
        index += 1;
        continue;
      }

      let end = index;

      while (end < segments.length && segments[end].chain === chain) {
        splatSegment(segments[end], true);
        end += 1;
      }

      for (const idx of chainTouched) {
        field[idx] = smin(field[idx], chainField[idx], blendK);
        chainField[idx] = 1e9;
      }

      chainTouched.length = 0;
      index = end;
    }

    // Blur the field over the touched band for a smooth silhouette + normals.
    // Several passes iron out the periodic scallop from the capsule joints so
    // the vein edge reads as one smooth flowing line.
    const blurCap = blendK;
    const prev = new Float32Array(total);

    for (let pass = 0; pass < 4; pass += 1) {
      for (const idx of touchedList) {
        prev[idx] = field[idx];
      }

      const neighbour = (nIdx: number): number =>
        isTouched[nIdx] ? Math.min(prev[nIdx], blurCap) : blurCap;

      for (const idx of touchedList) {
        const i = idx % cols;
        const j = (idx - i) / cols;
        const jUp = Math.min(rows - 1, j + 1);
        const jDown = Math.max(0, j - 1);
        const center = Math.min(prev[idx], blurCap);
        const left = neighbour(j * cols + ((i - 1 + cols) % cols));
        const right = neighbour(j * cols + ((i + 1) % cols));
        const up = neighbour(jUp * cols + i);
        const down = neighbour(jDown * cols + i);

        field[idx] = center * 0.4 + (left + right + up + down) * 0.15;
      }
    }

    // Collapse row 0 (the pole ring) to a single value. All `cols` cells there
    // are the SAME world point, so they start out identical — but the blur mixes
    // each one with its own row-1 neighbours and pulls them apart, which would
    // give the pole a different height and coverage depending on which column
    // you sampled. Take the most-covered (min) so the center never ends up
    // outside the gold that surrounds it, and mark the whole row touched so
    // row 1's normals difference against a consistent pole below them.
    const hasPole = coordMin <= 1e-9;

    if (hasPole) {
      let best = 1e9;
      let bestColumn = -1;

      for (let i = 0; i < cols; i += 1) {
        if (isTouched[i] && field[i] < best) {
          best = field[i];
          bestColumn = i;
        }
      }

      if (bestColumn >= 0) {
        for (let i = 0; i < cols; i += 1) {
          if (!isTouched[i]) {
            isTouched[i] = 1;
            touchedList.push(i);
          }

          field[i] = best;
          radiusGrid[i] = radiusGrid[bestColumn];
          revealGrid[i] = revealGrid[bestColumn];
        }
      }
    }

    const posX = new Float32Array(total);
    const posY = new Float32Array(total);
    const posZ = new Float32Array(total);
    const posDone = new Uint8Array(total);
    const posAt = (i: number, j: number): Vec3 => {
      const idx = j * cols + i;

      if (posDone[idx]) {
        return { x: posX[idx], y: posY[idx], z: posZ[idx] };
      }

      const sample = sampleAt(i, j);
      const distance = field[idx];
      const radius = radiusGrid[idx];
      const t = radius > 1e-6 ? clamp01(-distance / radius) : 0;
      const disp = relief * t * t * (3 - 2 * t) - baseSink;

      posX[idx] = sample.x + sample.nx * disp;
      posY[idx] = sample.y + sample.ny * disp;
      posZ[idx] = sample.z + sample.nz * disp;
      posDone[idx] = 1;

      return { x: posX[idx], y: posY[idx], z: posZ[idx] };
    };

    const vertexIndex = new Int32Array(total).fill(-1);

    const emitVertex = (i: number, j: number): number => {
      const idx = j * cols + i;

      if (vertexIndex[idx] >= 0) {
        return vertexIndex[idx];
      }

      const sample = sampleAt(i, j);
      const position = posAt(i, j);
      const step = normalStep[j];
      const right = posAt((i + step) % cols, j);
      const left = posAt((i - step + cols) % cols, j);
      const up = posAt(i, Math.min(rowCount, j + 1));
      const down = posAt(i, Math.max(0, j - 1));
      const ax = right.x - left.x;
      const ay = right.y - left.y;
      const az = right.z - left.z;
      const bx = up.x - down.x;
      const by = up.y - down.y;
      const bz = up.z - down.z;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz);

      if (length < 1e-12) {
        // Degenerate ring: at the pole all four neighbours are the same point,
        // so there is no surface to difference. Fall back to the vessel normal
        // (straight along the axis there) rather than shading the center black.
        nx = sample.nx;
        ny = sample.ny;
        nz = sample.nz;
      } else {
        nx /= length;
        ny /= length;
        nz /= length;
      }

      if (nx * sample.nx + ny * sample.ny + nz * sample.nz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }

      const toSurface = Math.max(normalToSurface, poleNormalBlend[j]);

      if (toSurface > 0) {
        nx += (sample.nx - nx) * toSurface;
        ny += (sample.ny - ny) * toSurface;
        nz += (sample.nz - nz) * toSurface;

        const blendLength = Math.hypot(nx, ny, nz) || 1;

        nx /= blendLength;
        ny /= blendLength;
        nz /= blendLength;
      }

      const reveal = revealGrid[idx];

      const spine = spineAt(i, j);
      const spineDepth =
        capSpineDepth * (1 - clamp01((coordMin + j * dCoord - 1) / rimExtend));
      const spx = sample.x + (spine.x - sample.x) * spineDepth;
      const spy = sample.y + (spine.y - sample.y) * spineDepth;
      const spz = sample.z + (spine.z - sample.z) * spineDepth;

      positions.push(position.x, position.y, position.z);
      normals.push(nx, ny, nz);
      offsets.push(position.x - spx, position.y - spy, position.z - spz);
      reveals.push(reveal);
      coverages.push(Math.max(-0.03, Math.min(0.03, -field[idx])));
      faces.push(faceId);
      uvs.push(i / cols, coordMin + j * dCoord);

      if (reveal > revealMax) {
        revealMax = reveal;
      }

      const nextIndex = positions.length / 3 - 1;

      vertexIndex[idx] = nextIndex;

      return nextIndex;
    };

    // Emit geometry a few rows PAST the field=0 contour so the fragment-shader
    // coverage discard has a wide enough band to draw a smooth sub-cell edge.
    // Too thin a band (~1 row) lets the silhouette snap to grid rows, which
    // reads as a sawtooth along the seam.
    const edgeMargin = rowArc[Math.min(rowCount, Math.round(rowCount / 2))] * 2;


    // One shared vertex for the whole degenerate pole ring, so the innermost
    // band closes as a proper triangle fan. Emitting quads there instead would
    // give two triangles per column of which one is exactly zero-area, leaving
    // an unfilled disc at the bowl's center — which is what the cracks converge
    // on, so it showed as open crack right where the gold should pool.
    let poleVertex = -1;
    const emitPole = (): number => {
      if (poleVertex < 0) {
        poleVertex = emitVertex(0, 0);
      }

      return poleVertex;
    };

    for (let i = 0; i < cols; i += 1) {
      const iNext = (i + 1) % cols;

      if (hasPole && field[0] < edgeMargin) {
        const cNext = field[cols + iNext];
        const cHere = field[cols + i];

        if (Math.min(cNext, cHere) < edgeMargin) {
          // Same winding as the quad this replaces: (v00, v11, v01) with v00
          // and v01 both collapsed onto the pole.
          indices.push(emitPole(), emitVertex(iNext, 1), emitVertex(i, 1));
        }
      }

      for (let j = hasPole ? 1 : 0; j < rowCount - guardRows; j += 1) {
        const c00 = field[j * cols + i];
        const c10 = field[j * cols + iNext];
        const c11 = field[(j + 1) * cols + iNext];
        const c01 = field[(j + 1) * cols + i];

        if (Math.min(c00, c10, c11, c01) >= edgeMargin) {
          continue;
        }

        const v00 = emitVertex(i, j);
        const v10 = emitVertex(iNext, j);
        const v11 = emitVertex(iNext, j + 1);
        const v01 = emitVertex(i, j + 1);

        indices.push(v00, v10, v11, v00, v11, v01);
      }
    }
  };

  // Each face rides its own skin for coord <= 1, then its own half of the lip.
  // `t` is the shared rim parameter (0 = outer edge, 1 = inner edge), so the two
  // grids walk toward each other and their last meshed rows land on the same
  // world ring at the crest, t = 0.5.
  const outerLipT = (coord: number): number => clamp01((coord - 1) / rimExtend);
  const innerLipT = (coord: number): number => clamp01(1 - (coord - 1) / rimExtend);
  const lipSurface =
    (tOf: (coord: number) => number, skin: (theta: number, s: number) => SurfaceSample) =>
    (theta: number, coord: number): SurfaceSample =>
      coord <= 1 ? skin(theta, clamp01(coord)) : surfaces.rimAt(theta, tOf(coord));
  const lipPoint =
    (tOf: (coord: number) => number, skin: (theta: number, s: number) => Vec3) =>
    (theta: number, coord: number): Vec3 =>
      coord <= 1 ? skin(theta, clamp01(coord)) : surfaces.rimPoint(theta, tOf(coord));

  buildGrid(
    lipSurface(outerLipT, surfaces.outerFast),
    lipPoint(outerLipT, surfaces.outerPoint),
    faceRowCount + rimHalfRows + rimGuardRows,
    seamMinS,
    1 + rimHalfExtend,
    outerSegments,
    0,
    0,
    rimGuardRows,
  );
  buildGrid(
    lipSurface(innerLipT, surfaces.innerFast),
    lipPoint(innerLipT, surfaces.innerPoint),
    faceRowCount + rimHalfRows + rimGuardRows,
    seamMinS,
    1 + rimHalfExtend,
    innerSegments,
    0,
    1,
    rimGuardRows,
  );

  // ---- Side walls: close the seam into one shell through the wall. ----
  //
  // The two face grids are heightfields on opposite skins — each ~0.005 thick,
  // sitting ~0.048 apart at the two ends of a slot that runs clean through the
  // vessel. Two foil lids over an empty box. These walls run the FULL depth down
  // either side of the centerline and join the caps, so the gold becomes a closed
  // box-section: cap / wall / wall / cap. That is the same construction as the
  // vessel itself (outer skin, inner skin, rim strip, nothing in between) and it
  // reads solid for the same reason — the shell is closed, so nothing can see in.
  //
  // The caps are NOT rebuilt. They keep their field, their displacement, their
  // sub-cell coverage silhouette and their reveal; the walls are additional
  // geometry pushed into the same attribute arrays.
  const buildCrackFill = (): void => {
    // Where the wall's end rows have to land: ON the cap, not at the skin. The
    // wall stands at wallFill while the cap covers to goldFill, so it meets the
    // cap partway across its footprint. Near a straight run the cap's field is
    // just the lateral distance, so its height there is closed-form — the same
    // smoothstep posAt() uses, evaluated at the wall's own offset.
    const wallT = (goldFill - wallFill) / goldFill;
    const wallDisp = Math.min(
      relief - baseSink,
      Math.max(-baseSink, relief * wallT * wallT * (3 - 2 * wallT) - baseSink),
    );
    // Three depth rows, not two, so the wall keeps an honest side-facing normal
    // at mid-depth between the two rows tilted toward the caps. A 2-row wall is
    // all junction and no side.
    //
    // The middle row rides the straight chord the whole way, including into a
    // rim ending. The lip is a Hermite curve bulging ~0.011 above that chord, so
    // a lens of void is left under the strap — but it is CLOSED: the lip caps
    // roof it, the chord floors it and the run's end quad shuts the side. An
    // earlier version bowed the middle row up onto the lip curve to fill it and
    // that was strictly worse: the curve only exists at s = 1, so ramping toward
    // it over the last few percent of s dragged the row up and out of the vessel
    // and stood a gold fin off the rim.
    const rows = 3;
    // Every other centerline sample. The walls are buried inside the ceramic —
    // they are never the visible edge of the gold, only the thing that stops you
    // seeing between the two caps — so they do not need the caps' resolution,
    // and at full stride the fill did not fit the seam vertex budget.
    const stride = 2;

    for (const run of fillRuns) {
      const picks: number[] = [];

      for (let index = 0; index < run.outer.length; index += stride) {
        picks.push(index);
      }

      if (picks[picks.length - 1] !== run.outer.length - 1) {
        picks.push(run.outer.length - 1);
      }

      const count = picks.length;

      if (count < 2) {
        continue;
      }

      // Index of a vertex in the +L / -L walls, row-major per sample.
      const plusIndex = new Int32Array(count * rows);
      const minusIndex = new Int32Array(count * rows);

      for (let index = 0; index < count; index += 1) {
        const outer = run.outer[picks[index]];
        const inner = run.inner[picks[index]];
        const midX = (outer.w.x + inner.w.x) * 0.5;
        const midY = (outer.w.y + inner.w.y) * 0.5;
        const midZ = (outer.w.z + inner.w.z) * 0.5;

        // Depth axis (outer skin -> inner skin), the same chord the ceramic
        // crack wall is cut along, so the two agree by construction.
        let dx = inner.w.x - outer.w.x;
        let dy = inner.w.y - outer.w.y;
        let dz = inner.w.z - outer.w.z;
        const depthLength = Math.hypot(dx, dy, dz) || 1;

        dx /= depthLength;
        dy /= depthLength;
        dz /= depthLength;

        // Along-run tangent, from the mid-wall axis so both walls share it.
        const beforeAt = picks[Math.max(0, index - 1)];
        const afterAt = picks[Math.min(count - 1, index + 1)];
        const before = run.outer[beforeAt];
        const beforeInner = run.inner[beforeAt];
        const after = run.outer[afterAt];
        const afterInner = run.inner[afterAt];
        const tx = (after.w.x + afterInner.w.x - before.w.x - beforeInner.w.x) * 0.5;
        const ty = (after.w.y + afterInner.w.y - before.w.y - beforeInner.w.y) * 0.5;
        const tz = (after.w.z + afterInner.w.z - before.w.z - beforeInner.w.z) * 0.5;

        // Lateral direction: perpendicular to both the run and the wall depth.
        let lx = ty * dz - tz * dy;
        let ly = tz * dx - tx * dz;
        let lz = tx * dy - ty * dx;
        const lateralLength = Math.hypot(lx, ly, lz);

        if (lateralLength < 1e-9) {
          // Degenerate frame (a duplicated sample). Skip the offset rather than
          // emit a NaN; the neighbouring quads still close the shell.
          lx = 0;
          ly = 0;
          lz = 0;
        } else {
          lx /= lateralLength;
          ly /= lateralLength;
          lz /= lateralLength;
        }

        // Square the fill up to the lip over the last 15% of s — the SAME ramp
        // and the same direction the shard skins retreat along in fracture.ts's
        // addRetreated. Both walls are offset by `half` along this direction, so
        // it has to be the direction the ceramic actually parted or the fill
        // stands in the wrong plane at the crossing.
        //
        // It was: an oblique run's lateral is T x d, and at the lip d is purely
        // radial, so a run arriving at 45deg to the meridian gives a lateral
        // tilted ~45deg out of horizontal. The end panel then stabs one corner
        // up THROUGH the lip (measured 0.0066 above the lip edge, against a gold
        // cap that only crests 0.0037) and drops the other corner into the wall
        // — the sharp fins sticking out of every rim cap. Squared up, the panel
        // lies flat in the notch the ceramic opened and the caps roof it.
        const rimBlend = clamp01((outer.s - 0.85) / 0.15);

        if (rimBlend > 0 && lateralLength >= 1e-9) {
          const lipX = -Math.sin(outer.theta);
          const lipZ = Math.cos(outer.theta);
          // Toward whichever way along the lip the frame was already leaning, so
          // the +L and -L walls do not both swing to the same side.
          const side = lx * lipX + lz * lipZ >= 0 ? 1 : -1;

          lx += (side * lipX - lx) * rimBlend;
          ly += (0 - ly) * rimBlend;
          lz += (side * lipZ - lz) * rimBlend;

          const squared = Math.hypot(lx, ly, lz) || 1;

          lx /= squared;
          ly /= squared;
          lz /= squared;
        }

        const half = wallFill * (outer.r / goldFill);
        const outerSample = surfaces.outerFast(outer.theta, clamp01(outer.s));
        const innerSample = surfaces.innerFast(inner.theta, clamp01(inner.s));

        const reveal = outer.reveal - wallRevealLead;
        const u = index / (count - 1);

        for (let row = 0; row < rows; row += 1) {
          const w = row / (rows - 1);
          // Row centre, before the lateral offset: on the cap surface at the two
          // ends, on the mid-wall axis in between.
          let cx: number;
          let cy: number;
          let cz: number;
          let nx: number;
          let ny: number;
          let nz: number;

          if (row === 0) {
            cx = outer.w.x + outerSample.nx * wallDisp;
            cy = outer.w.y + outerSample.ny * wallDisp;
            cz = outer.w.z + outerSample.nz * wallDisp;
            nx = outerSample.nx * wallNormalBlend;
            ny = outerSample.ny * wallNormalBlend;
            nz = outerSample.nz * wallNormalBlend;
          } else if (row === rows - 1) {
            cx = inner.w.x + innerSample.nx * wallDisp;
            cy = inner.w.y + innerSample.ny * wallDisp;
            cz = inner.w.z + innerSample.nz * wallDisp;
            nx = innerSample.nx * wallNormalBlend;
            ny = innerSample.ny * wallNormalBlend;
            nz = innerSample.nz * wallNormalBlend;
          } else {
            cx = midX;
            cy = midY;
            cz = midZ;
            nx = 0;
            ny = 0;
            nz = 0;
          }

          // Spine: what this vertex collapses onto at the front of the pour.
          const chordX = outer.w.x + (inner.w.x - outer.w.x) * w;
          const chordY = outer.w.y + (inner.w.y - outer.w.y) * w;
          const chordZ = outer.w.z + (inner.w.z - outer.w.z) * w;
          const spineX = chordX + (midX - chordX) * capSpineDepth;
          const spineY = chordY + (midY - chordY) * capSpineDepth;
          const spineZ = chordZ + (midZ - chordZ) * capSpineDepth;

          for (const sign of [1, -1] as const) {
            const px = cx + lx * half * sign;
            const py = cy + ly * half * sign;
            const pz = cz + lz * half * sign;
            // Tilt the end rows toward the cap they meet. The wall is flat —
            // there is no room to round it — but at metalness 1 the normal is
            // the whole appearance, so this turns the junction into a rounded
            // roll-over rather than a bright/dark crease.
            let vnx = lx * sign + nx;
            let vny = ly * sign + ny;
            let vnz = lz * sign + nz;
            const normalLength = Math.hypot(vnx, vny, vnz) || 1;

            vnx /= normalLength;
            vny /= normalLength;
            vnz /= normalLength;

            positions.push(px, py, pz);
            normals.push(vnx, vny, vnz);
            offsets.push(px - spineX, py - spineY, pz - spineZ);
            reveals.push(reveal);
            // No sub-cell silhouette to carve: the fill is never the visible
            // edge of the gold, so it must never be discarded by the coverage
            // test that shapes the caps.
            coverages.push(0.03);
            faces.push(w);
            uvs.push(u, w);

            const vertex = positions.length / 3 - 1;

            if (sign === 1) {
              plusIndex[index * rows + row] = vertex;
            } else {
              minusIndex[index * rows + row] = vertex;
            }
          }
        }
      }

      // Quads along the run. Parameterised i along the tangent and row along the
      // depth, so (v00, v10, v11) faces +L; the -L wall is the same strip wound
      // the other way. Gold is DoubleSide, which flips shading normals on back
      // faces, so mixed winding would stripe the wall light/dark.
      for (let index = 0; index < count - 1; index += 1) {
        for (let row = 0; row < rows - 1; row += 1) {
          const a = index * rows + row;
          const b = (index + 1) * rows + row;

          indices.push(
            plusIndex[a],
            plusIndex[b],
            plusIndex[b + 1],
            plusIndex[a],
            plusIndex[b + 1],
            plusIndex[a + 1],
          );
          indices.push(
            minusIndex[a],
            minusIndex[b + 1],
            minusIndex[b],
            minusIndex[a],
            minusIndex[a + 1],
            minusIndex[b + 1],
          );
        }
      }

      if (run.closed) {
        continue;
      }

      // Close both ends so nothing can look down the axis of a run into the box.
      // Parameterised across the wall (-L -> +L) and down the depth, whose normal
      // is L x d = -T: outward at the start, inward at the end.
      for (let row = 0; row < rows - 1; row += 1) {
        const first = row;
        const last = (count - 1) * rows + row;

        indices.push(
          minusIndex[first],
          plusIndex[first],
          plusIndex[first + 1],
          minusIndex[first],
          plusIndex[first + 1],
          minusIndex[first + 1],
        );
        indices.push(
          minusIndex[last],
          plusIndex[last + 1],
          plusIndex[last],
          minusIndex[last],
          minusIndex[last + 1],
          plusIndex[last + 1],
        );
      }
    }
  };

  buildCrackFill();
  void rimRowCount;

  return {
    coverages: new Float32Array(coverages),
    faces: new Float32Array(faces),
    index: new Uint32Array(indices),
    normals: new Float32Array(normals),
    offsets: new Float32Array(offsets),
    positions: new Float32Array(positions),
    reveals: new Float32Array(reveals),
    revealMax: revealMax || 1,
    totalVertexCount: positions.length / 3,
    uvs: new Float32Array(uvs),
  };
}
