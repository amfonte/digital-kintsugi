// Shared seam-width model used by BOTH the fracture cutter (to open the physical
// gap between shards) and the gold seam builder (to fill it). Because the two
// systems evaluate the exact same half-width at the same world position, the
// gold always fills the crack rather than painting over it: crack width == gold
// width everywhere, and both pool wider at junctions.
//
// The width is a pure function of WORLD POSITION + the set of junction/rim pool
// centers, so it needs no per-path identity and stays consistent across modules.

export type WidthVec3 = { x: number; y: number; z: number };

export type SeamWidthModel = {
  // World-space half-width contributions.
  hairHalf: number; // constant floor: a tight run stays a hairline
  bodyBase: number; // generosity-scaled base body added along every run
  bodySpan: number; // generosity-scaled span modulated by flow noise
  generosity: number; // overall repair generosity (0 = hairline everywhere)
  maxHalf: number; // hard cap so wide pools never invert shard corners
  // Pool centers as [x, y, z, scale, radiusMul] quintuples (stride 5): junctions
  // at scale 1, rim endings at a random 0..1 scale so they pool small/medium/
  // large. `radiusMul` scales this center's falloff radius — a rim pool has to
  // bloom over a much longer run than a junction one (see fracture.ts).
  poolCenters: Float32Array;
  poolRadius: number; // world falloff radius of a pool at radiusMul 1
  poolStrength: number; // generosity-scaled peak pool half-width
  seed: number;
};

function hashF(n: number): number {
  const s = Math.sin(n) * 43758.5453123;

  return s - Math.floor(s);
}

// Compact 3D value noise (smoothstep-interpolated lattice), self-contained so
// this module has no import cycle with fracture.ts.
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const corner = (dx: number, dy: number, dz: number): number =>
    hashF((xi + dx) * 127.1 + (yi + dy) * 311.7 + (zi + dz) * 74.7 + seed * 51.3);
  const c000 = corner(0, 0, 0);
  const c100 = corner(1, 0, 0);
  const c010 = corner(0, 1, 0);
  const c110 = corner(1, 1, 0);
  const c001 = corner(0, 0, 1);
  const c101 = corner(1, 0, 1);
  const c011 = corner(0, 1, 1);
  const c111 = corner(1, 1, 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;

  return y0 + (y1 - y0) * w;
}

export function createSeamWidthModel(params: {
  generosity: number;
  poolCenters: Float32Array;
  seed: number;
}): SeamWidthModel {
  const generosity = Math.max(0, params.generosity);

  return {
    // A tight run is always at least this wide. Set so the thinnest gold still
    // fully covers the constant shard channel (see constantGap in fracture.ts) —
    // the gold rides on top of the smooth uniform crack, never leaving a bare
    // sliver, and widens/pools organically above that floor.
    hairHalf: 0.006,
    bodyBase: 0.016,
    // Along-run variation. The width reads as UNIFORM THICK not because the swing
    // is small (it was 4x) but because thin necks were near hairHalf while the
    // gold field's smin/blur (blendK) bridged them back up to the fat width. With
    // blendK now smaller, thin necks survive — so the body is tuned so a slack run
    // sits near the hairline (~0.007) and a full run reaches ~0.025, a strongly
    // visible thin<->thick swing while the thinnest runs stay narrow. Junction
    // pooling adds fatness on top. (bodyBase lowered + span widened together push
    // the CONTRAST up without widening the thin end.)
    bodySpan: 0.44,
    generosity,
    // Cap is now only a SAFETY rail against the widest junction pool inverting
    // shard corners — it sits well above the body band so it never clips the body
    // variation (clipping is what re-flattened everything before). Only extreme
    // overlapping pools reach it.
    maxHalf: 0.02 + generosity * 0.6,
    poolCenters: params.poolCenters,
    // The gold field is metaball capsules, so where seams meet the overlap
    // already swells the junction organically via smin. The explicit pool adds a
    // visible bloom ON TOP of that so branches clearly gather gold; kept modest in
    // radius (relative to strength) and rounded by the field blur so it reads as
    // an organic swell rather than a bolted-on disc. At 0.24 the swell was lost in
    // the floor — this is strong enough to see, still below the disc threshold.
    // (Rim-pool size variance still rides on this, scaled proportionally.)
    poolRadius: 0.045,
    poolStrength: 0.3,
    seed: params.seed,
  };
}

// Smooth 1 -> 0 bloom over [0, 1].
function bloom(x: number): number {
  if (x >= 1) {
    return 0;
  }

  return 0.5 + 0.5 * Math.cos(Math.PI * x);
}

// World-space half-width of the seam (both the open crack and the gold that
// fills it) at a point on the vessel surface.
export function seamHalfWidthAt(
  model: SeamWidthModel,
  x: number,
  y: number,
  z: number,
  // Scales only the pool contribution. The gold fills at 1; the shard gap opens
  // at < 1 so the round gold blob fully covers the gap's sharp junction pocket
  // instead of leaving bare corners.
  poolMul = 1,
): number {
  // Two flow octaves so runs read thicker/thinner AND alternate more often
  // within a run (the base drift alone read as one slowly-changing thickness).
  // Both stay low-freq enough that the crack/gold edge never jaggedizes, and the
  // weights sum to 1 so flow stays 0..1. 0..1.
  const flow =
    0.6 * valueNoise(x * 5, y * 5, z * 5, model.seed) +
    0.4 * valueNoise(x * 12, y * 12, z * 12, model.seed + 17);
  const body = model.generosity * (model.bodyBase + model.bodySpan * flow);

  let pool = 0;
  const centers = model.poolCenters;

  if (centers.length > 0 && model.poolStrength > 0 && poolMul > 0) {
    // Each center contributes its own pool (scaled); take the strongest so a
    // point near several junctions/endings pools by the biggest, not the sum.
    const invRadius = 1 / model.poolRadius;
    let best = 0;

    for (let k = 0; k < centers.length; k += 5) {
      const dx = x - centers[k];
      const dy = y - centers[k + 1];
      const dz = z - centers[k + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const contribution = centers[k + 3] * bloom((d * invRadius) / centers[k + 4]);

      if (contribution > best) {
        best = contribution;
      }
    }

    pool = model.generosity * model.poolStrength * best * poolMul;
  }

  return Math.min(model.maxHalf, model.hairHalf + body + pool);
}
