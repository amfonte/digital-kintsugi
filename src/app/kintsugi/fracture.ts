import { createSeamWidthModel, seamHalfWidthAt } from "./seam-width";
import type { SeamWidthModel } from "./seam-width";
import type { Point3, SurfaceSample, VesselSurfaces } from "./vessel-profile";

// Where the user struck the vessel, in surface (theta, s) parameters. Cracks
// radiate from each of these; the list is the vessel's whole break history.
export type ImpactPoint = { s: number; theta: number };

export type FractureSettings = {
  branching: number;
  density: number;
  // Half-width of the open channel between assembled shards. Coupled to the
  // gold bead width so more gold always means a wider filled gap, never
  // paint-over. Optional; falls back to the default below.
  gapHalf?: number;
  // Every strike the vessel has taken, oldest first. Empty = a pristine,
  // unbroken bowl. Each entry contributes one batch of Voronoi seeds, and
  // because batches only ever get appended, earlier strikes' crack lines
  // survive intact wherever a later strike's seeds don't win the nearest-seed
  // test — which is what lets damage accumulate instead of being replaced.
  impacts: readonly ImpactPoint[];
  seed: number;
  // Repair generosity (the "Gold" control). Drives how far the shards retreat:
  // wider gold => wider crack, pooling open at junctions. Optional; 0 keeps a
  // hairline channel everywhere.
  width?: number;
};

export type ShardScatter = {
  angleRad: number;
  axisX: number;
  axisY: number;
  axisZ: number;
  delaySeconds: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
};

export type ShardSource = {
  bisqueNormals: number[];
  bisquePositions: number[];
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  glazeNormals: number[];
  glazePositions: number[];
  id: number;
  scatter: ShardScatter;
};

export type SeamParamPoint = { s: number; theta: number };

// How a seam path terminates: at a three-way crack junction, at the rim lip,
// or dying out on the surface (pole side). The seam builder widens, caps, or
// tapers each ending accordingly.
export type SeamEndpointKind = "junction" | "rim" | "tip";

export type SeamParamPath = {
  closed: boolean;
  endKind: SeamEndpointKind;
  points: SeamParamPoint[];
  startKind: SeamEndpointKind;
};

export type FractureResult = {
  seamPaths: SeamParamPath[];
  shardCount: number;
  shards: ShardSource[];
  // The shared width model used to open the gap; the gold seam builder reuses it
  // so the gold fills the crack exactly instead of painting over it.
  widthModel: SeamWidthModel;
};

export const fractureThetaSegments = 200;
export const fractureSSegments = 72;

// Meridian sampling is clustered toward the pole. The bowl's center is an
// up-facing cap only ~2% of the radius across; with uniform sampling the whole
// cap falls inside the single innermost mesh ring, so it renders as one coarse
// flat facet -- a bright dot that shades as if painted on. Warping the meridian
// parameter u = j / S packs many more rings into that cap so its curvature is
// actually resolved and it shades continuously with the wall. Only the bottom
// `poleRefineFraction` of the range is warped (u -> u^2 / poleRefineFraction);
// above it the mapping is the identity, so the wall and rim keep their original
// even sampling. This changes vertex density only -- Voronoi ownership is taken
// from the resulting 3D position, so the crack pattern is unaffected.
const poleRefineFraction = 0.16;

function warpMeridian(u: number): number {
  return u < poleRefineFraction ? (u * u) / poleRefineFraction : u;
}

// Fallback channel half-width when the caller does not couple it to the bead
// width. Kintsugi gold FILLS the space between pieces rather than painting
// over a flush joint, so each shard's skin pulls back this far from the
// fracture line and the crack walls sit at the channel sides.
const defaultSeamHalfGap = 0.0055;
// Seam ribbons used to stop at s = 0.04 — a legacy of the swept-tube seam
// builder, which framed each tube in (theta, s) and so blew up where that
// parameterization degenerates at the pole. The gold is now a world-space
// metaball field with no such frame, but the cutoff stayed: on the domed base
// (radius 0.2225) it left a bare disc of radius 0.049 at the exact spot every
// crack converges, so a seam crossing the center rendered as two gold runs with
// an open crack between them. Seam segments now run all the way into the pole.
const seamMinS = 0;

export function createSeededRandom(seed: number): () => number {
  let state = (Math.floor(seed) || 1) >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);

    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) | 0;

  h = Math.imul(h ^ (h >>> 13), 1274126177);

  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);

  let result = 0;

  for (let cz = 0; cz <= 1; cz += 1) {
    for (let cy = 0; cy <= 1; cy += 1) {
      for (let cx = 0; cx <= 1; cx += 1) {
        const weight =
          (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);

        result += hash3(ix + cx, iy + cy, iz + cz, seed) * weight;
      }
    }
  }

  return result;
}

// `batch` is which strike produced the seed. Ownership is resolved once per
// batch rather than once overall, so a crack cut by an early strike survives a
// later one — see `resolveOwnership`.
type FractureSeed = { batch: number; x: number; y: number; z: number };

// Shard ceiling across every accumulated strike, and the load the performance
// budgets are proven at, so repeated strikes can never walk the scene past that
// proven envelope. Because strikes overlay rather than replace each other, a
// strike splits cells the earlier ones already cut, so shards outrun seeds:
// roughly 4 -> 9 -> 17 -> 26 over four strikes, where the vessel tops out and
// further strikes are dropped whole. Where exactly it tops out depends on where
// the clicks landed, so treat the progression as typical, not fixed.
export const maxAccumulatedSeeds = 28;

// Domain-warped Voronoi: every sample point is displaced once by a smooth
// noise field before the distance test, which bends cell boundaries into
// organic crack lines without producing salt-and-pepper ownership.
const warpFrequency = 2.6;
const warpAmplitude = 0.085;

function warpPoint(
  point: { x: number; y: number; z: number },
  noiseSeed: number,
): { x: number; y: number; z: number } {
  return {
    x:
      point.x +
      (valueNoise3(point.x * warpFrequency, point.y * warpFrequency, point.z * warpFrequency, noiseSeed) - 0.5) *
        2 *
        warpAmplitude,
    y:
      point.y +
      (valueNoise3(point.x * warpFrequency + 19.7, point.y * warpFrequency, point.z * warpFrequency, noiseSeed) -
        0.5) *
        2 *
        warpAmplitude,
    z:
      point.z +
      (valueNoise3(point.x * warpFrequency, point.y * warpFrequency + 7.3, point.z * warpFrequency, noiseSeed) -
        0.5) *
        2 *
        warpAmplitude,
  };
}

function normalizeVector(vector: Point3, fallback: Point3): Point3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);

  return length < 1e-9
    ? fallback
    : { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

// Orthonormal tangent frame on the midsurface at (theta, s): one axis running up
// the meridian, one running around it. The impact rosette is laid out in this
// frame rather than in (theta, s) because parameter space is wildly anisotropic
// — a given dTheta spans almost no distance near the pole, and s clamps flat at
// the rim — so a ring measured in parameters comes out a squashed sliver in one
// place and a fat band in another. Here a radius is a world distance wherever
// the strike landed, which is what the equal-radius ring below depends on.
function surfaceTangentFrame(
  surfaces: VesselSurfaces,
  theta: number,
  s: number,
): { alongS: Point3; aroundTheta: Point3 } {
  // Sampled a hair inside the ends: at s = 0 every theta maps to the same point
  // on the axis, so the around-theta difference degenerates there.
  const sampleS = Math.min(0.98, Math.max(0.02, s));
  const step = 0.01;
  const here = surfaces.midpointAt(theta, sampleS);
  const up = surfaces.midpointAt(theta, sampleS + step);
  const side = surfaces.midpointAt(theta + step, sampleS);
  const alongS = normalizeVector(
    { x: up.x - here.x, y: up.y - here.y, z: up.z - here.z },
    { x: 0, y: 1, z: 0 },
  );
  const raw = { x: side.x - here.x, y: side.y - here.y, z: side.z - here.z };
  // Gram-Schmidt: on the curved wall the two raw differences are not quite
  // perpendicular, and a skewed frame stretches the ring into an ellipse whose
  // seeds are no longer all the same distance from the strike.
  const skew = raw.x * alongS.x + raw.y * alongS.y + raw.z * alongS.z;
  const aroundTheta = normalizeVector(
    {
      x: raw.x - alongS.x * skew,
      y: raw.y - alongS.y * skew,
      z: raw.z - alongS.z * skew,
    },
    { x: 1, y: 0, z: 0 },
  );

  return { alongS, aroundTheta };
}

// Base radius of the crack star, in world units on a bowl of radius ~1.
const starRadius = 0.3;

// Rays one strike opens at the point it hit. Three is the minimum that makes the
// click itself a junction; two seeds equidistant from it share a single boundary,
// which runs straight THROUGH the point instead of meeting there. Both put a
// crack exactly on the click — equal radii are what does that, not the count — so
// the choice between them costs no accuracy, only whether the break reads as a Y
// or as a line, and a two-seed strike is a cell split by one line rather than
// three, which is the cheaper way to spend the shard ceiling.
const minStarRays = 3;
const throughStrikeRays = 2;

// How close an existing crack has to be to the click for a two-seed strike to be
// enough. Inside this, the line through the click meets that crack a short run
// from the point struck, so the strike still produces a junction near it without
// paying for a third ray; outside it, a lone line through untouched glaze has
// nothing to meet, so the strike opens its own junction instead. Tuned against
// the measured junction distance, not guessed — see the worklog.
const nearbyCrackReach = starRadius * 0.5;

// Estimated distance from a point to the nearest crack the strikes so far have
// already cut. Cracks are the boundaries of every generation's diagram, so per
// generation the two seeds nearest the point give the bisector the boundary there
// runs along, and the point's distance to that plane — (d2^2 - d1^2) / 2L for
// seeds L apart — is how far that crack is; the nearest across the generations
// wins. It is an estimate because the true boundary bends under the domain warp
// and can belong to a farther seed, but it only ever decides which of two seed
// counts to spend, and it is measured in the space ownership actually resolves in
// (warped point against raw seeds), so the caller must pass a WARPED point.
function distanceToExistingCrack(
  seeds: readonly FractureSeed[],
  point: Point3,
  generations: number,
): number {
  let nearest = Number.POSITIVE_INFINITY;

  for (let generation = 0; generation < generations; generation += 1) {
    let first = -1;
    let second = -1;
    let firstDistance = Number.POSITIVE_INFINITY;
    let secondDistance = Number.POSITIVE_INFINITY;

    // Seeds run oldest strike first, so this generation can only see the prefix.
    for (let index = 0; index < seeds.length && seeds[index].batch <= generation; index += 1) {
      const distance = Math.hypot(
        point.x - seeds[index].x,
        point.y - seeds[index].y,
        point.z - seeds[index].z,
      );

      if (distance < firstDistance) {
        second = first;
        secondDistance = firstDistance;
        first = index;
        firstDistance = distance;
      } else if (distance < secondDistance) {
        second = index;
        secondDistance = distance;
      }
    }

    if (first < 0 || second < 0) {
      continue;
    }

    const span = Math.hypot(
      seeds[first].x - seeds[second].x,
      seeds[first].y - seeds[second].y,
      seeds[first].z - seeds[second].z,
    );

    if (span < 1e-9) {
      continue;
    }

    nearest = Math.min(
      nearest,
      (secondDistance * secondDistance - firstDistance * firstDistance) / (2 * span),
    );
  }

  return nearest;
}

// Seeds for one strike: a ring of them around the point struck, plus the
// branching share as satellites further out. The ring is the mechanism — a
// Voronoi boundary runs between neighbouring seeds, so the bisectors between
// consecutive ring seeds all run radially outward, giving the star of cracks a
// struck vessel actually shows.
//
// Two properties put the junction of that star exactly on the point the user
// clicked, and both are load-bearing:
//
//   - No seed at the strike itself. A seed is the INTERIOR of a cell, so a seed
//     on the click buries it mid-shard with the cracks ringing it at arm's
//     length — which is what used to leave every click ~0.11-0.21 world units
//     off the nearest crack. Leaving the centre empty is what makes the click a
//     corner shared by every cell of the ring instead.
//   - Every ring seed at EXACTLY the same distance from the strike. The bisector
//     of two points equidistant from P passes through P, so equal radii make all
//     the rays converge on the click and nowhere else. Per-seed radius jitter
//     (which this ring used to carry) drags that meeting point off it, so the
//     variety comes from jittering the ANGLES — that fans the rays unevenly
//     without moving where they meet — plus one radius per strike, so stars
//     still differ in size.
//
// The equidistance has to hold in the space the ownership test actually runs in,
// and that test compares WARPED vertex positions against raw seed positions. The
// point the star converges on is therefore the one whose warped image sits at the
// ring's centre: centre the ring on the raw impact and the junction lands up to
// warpAmplitude (0.085) away from the click. Centring it on the warped impact is
// what cancels that out.
//
// One more thing has to hold once the vessel is already broken, and it is what
// used to leave a strike next to an earlier one ~0.12 off: a generation's owner is
// the nearest seed among ALL the seeds up to it, not just this strike's, so a ring
// only owns the surface where it beats the older seeds. An earlier seed closer to
// the click than the ring radius therefore owns the click outright and the new
// bisectors never reach it. Pulling the ring in to exactly that seed's distance
// fixes it and does something better than merely avoiding the problem: the click
// becomes equidistant from the old seed and every new one, so the old cell joins
// the star as one more participant, and even a two-seed strike meets there
// three-ways. The star gets tighter the closer it lands to existing damage, which
// is also how a real break near a seam behaves.
function generateImpactSeeds(
  surfaces: VesselSurfaces,
  impact: ImpactPoint,
  count: number,
  branching: number,
  random: () => number,
  noiseSeed: number,
  existing: readonly FractureSeed[],
): Point3[] {
  const center = warpPoint(surfaces.midpointAt(impact.theta, impact.s), noiseSeed);
  const frame = surfaceTangentFrame(surfaces, impact.theta, impact.s);
  // Satellites are spent out of the strike's own budget, but never down past the
  // rays the junction needs, so a minimal strike (two or three seeds) puts all of
  // them on the ring. Note the caller trims the last batch to whatever the shard
  // cap still allows and relies on getting back exactly `count` seeds, so the two
  // counts must always sum back to it.
  const satelliteCount = Math.min(
    Math.max(0, count - minStarRays),
    Math.round(count * (branching / 100) * 0.5),
  );
  const ringCount = count - satelliteCount;
  const nearestExisting = existing.reduce(
    (nearest, seed) =>
      Math.min(
        nearest,
        Math.hypot(center.x - seed.x, center.y - seed.y, center.z - seed.z),
      ),
    Number.POSITIVE_INFINITY,
  );
  const radius = Math.min(starRadius * (0.8 + random() * 0.4), nearestExisting);
  const seedAt = (angle: number, scale: number): Point3 => {
    const reach = radius * scale;
    const across = Math.cos(angle) * reach;
    const up = Math.sin(angle) * reach;

    return {
      x: center.x + frame.aroundTheta.x * across + frame.alongS.x * up,
      y: center.y + frame.aroundTheta.y * across + frame.alongS.y * up,
      z: center.z + frame.aroundTheta.z * across + frame.alongS.z * up,
    };
  };
  const ringAngles: number[] = [];
  const seeds: Point3[] = [];

  for (let index = 0; index < ringCount; index += 1) {
    // Even spacing plus jitter: evenly spaced ring seeds give evenly fanned
    // cracks, and the jitter keeps them from reading as a machined asterisk.
    const angle =
      ((index + 0.5) / ringCount) * Math.PI * 2 +
      ((random() - 0.5) * Math.PI) / ringCount;

    ringAngles.push(angle);
    seeds.push(seedAt(angle, 1));
  }

  // Satellites fork one ray into a branched pair the way a real break frays.
  // They sit strictly OUTSIDE the ring: a seed nearer the strike than the ring is
  // would win the surface right at the click and pull the junction off it.
  for (let index = 0; index < satelliteCount; index += 1) {
    const parent = ringAngles[Math.floor(random() * ringAngles.length)] ?? 0;

    seeds.push(
      seedAt(
        parent + ((random() - 0.5) * Math.PI) / Math.max(1, ringCount),
        1.3 + random() * 0.5,
      ),
    );
  }

  return seeds;
}

// Walk the strike history oldest to newest, appending each strike's batch. Every
// batch draws from its own stream keyed by its position in the history, so
// appending a strike cannot shift the seeds of the strikes before it — the
// earlier crack lines then reproduce exactly, and the new rosette merely carves
// into the cells around it. That is what makes damage cumulative rather than
// replaced, and it is why the streams must not be shared.
function generateSeeds(
  surfaces: VesselSurfaces,
  settings: FractureSettings,
  impactLimit: number,
  noiseSeed: number,
): FractureSeed[] {
  // A pristine vessel is one Voronoi cell: with a single seed no ownership ever
  // flips, so no boundary is cut, no seam is emitted, and the bowl comes out
  // whole through the very same code path a broken one does.
  if (impactLimit === 0) {
    return [{ ...surfaces.midpointAt(0, 0.5), batch: 0 }];
  }

  const perStrike = Math.max(minStarRays, Math.round(settings.density));
  const seeds: FractureSeed[] = [];

  for (let index = 0; index < impactLimit; index += 1) {
    const impact = settings.impacts[index];
    // The first strike breaks the pristine bowl into `density` pieces. Later
    // strikes only ever add a minimal star: their cracks cut across every cell
    // the earlier strikes left, so a handful of seeds already opens fresh break
    // lines right through the existing network, and anything larger saturates the
    // shard ceiling in two clicks instead of four or five.
    //
    // How minimal depends on where the click landed. Both sizes put a crack
    // exactly on the point struck, so this spends the third ray only where it
    // buys something: on glaze with no crack near enough for a single line to run
    // into, the strike opens its own junction, and next to an existing seam it
    // spends two and lets the line cross that seam instead. That is what keeps
    // the vessel taking about as many strikes as it did before the click became a
    // junction at all, since a broken bowl is mostly near-a-crack by then.
    const batchSize =
      index === 0
        ? perStrike
        : distanceToExistingCrack(
              seeds,
              warpPoint(surfaces.midpointAt(impact.theta, impact.s), noiseSeed),
              index,
            ) < nearbyCrackReach
          ? throughStrikeRays
          : minStarRays;
    const budget = maxAccumulatedSeeds - seeds.length;

    if (budget <= 0) {
      break;
    }

    seeds.push(
      ...generateImpactSeeds(
        surfaces,
        impact,
        Math.min(batchSize, budget),
        settings.branching,
        createSeededRandom(settings.seed * 7919 + 17 + index * 104729),
        noiseSeed,
        seeds,
      ).map((seed) => ({ ...seed, batch: index })),
    );
  }

  return seeds;
}

// Inverse of midpointAt: turn a point on the vessel (a raycast hit) back into
// the (theta, s) parameters a strike is recorded in. Theta is exact; s is found
// by a coarse scan along the meridian refined by bisection, which is plenty at
// click rates and avoids inverting the wobbled arc profile analytically.
export function nearestSurfaceParam(
  surfaces: VesselSurfaces,
  point: { x: number; y: number; z: number },
): ImpactPoint {
  const theta = Math.atan2(point.z, point.x);
  const distanceAt = (s: number): number => {
    const sample = surfaces.midpointAt(theta, s);

    return Math.hypot(sample.x - point.x, sample.y - point.y, sample.z - point.z);
  };

  const scanCount = 64;
  let bestS = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index <= scanCount; index += 1) {
    const s = index / scanCount;
    const distance = distanceAt(s);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestS = s;
    }
  }

  let low = Math.max(0, bestS - 1 / scanCount);
  let high = Math.min(1, bestS + 1 / scanCount);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const mid = (low + high) / 2;
    const midLow = (low + mid) / 2;
    const midHigh = (mid + high) / 2;

    if (distanceAt(midLow) < distanceAt(midHigh)) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return { s: (low + high) / 2, theta };
}

type ShardBuilder = {
  bisqueNormals: number[];
  bisquePositions: number[];
  glazeNormals: number[];
  glazePositions: number[];
  positionSumX: number;
  positionSumY: number;
  positionSumZ: number;
  positionSampleCount: number;
};

function pushTriangle(
  positions: number[],
  normals: number[],
  a: SurfaceSample,
  b: SurfaceSample,
  c: SurfaceSample,
): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  normals.push(a.nx, a.ny, a.nz, b.nx, b.ny, b.nz, c.nx, c.ny, c.nz);
}

function trackCentroid(builder: ShardBuilder, samples: readonly SurfaceSample[]): void {
  for (const sample of samples) {
    builder.positionSumX += sample.x;
    builder.positionSumY += sample.y;
    builder.positionSumZ += sample.z;
    builder.positionSampleCount += 1;
  }
}

type ParamPoint = { s: number; theta: number };

// boundary marks points lying on the fracture line itself; shard skins pull
// back from these to open the gap the gold will fill.
type KeyedPoint = ParamPoint & { boundary?: boolean; key: string };

type GridVertex = KeyedPoint & {
  iNorm: number;
  id: number;
  j: number;
  owner: number;
};

type SeamSegment = {
  a: ParamPoint;
  aKey: string;
  b: ParamPoint;
  bKey: string;
};

export function buildFracture(
  surfaces: VesselSurfaces,
  settings: FractureSettings,
): FractureResult {
  const T = fractureThetaSegments;
  const S = fractureSSegments;
  const dTheta = (Math.PI * 2) / T;
  const seamHalfGap = settings.gapHalf ?? defaultSeamHalfGap;

  // Junction/rim pool centers, collected as the fracture is cut, so the width
  // model can open wider gaps where cracks meet. Deduped by rounded (theta, s).
  // Each carries a scale: junctions pool full (1), rim endings a random amount
  // so they read small/medium/large (the variable rim pooling).
  const poolCenterMap = new Map<
    string,
    { x: number; y: number; z: number; scale: number; radiusMul: number }
  >();
  const addPoolCenter = (
    theta: number,
    s: number,
    scale: number,
    radiusMul = 1,
  ): void => {
    const twoPi = Math.PI * 2;
    const wrapped = ((theta % twoPi) + twoPi) % twoPi;
    const key = `${Math.round(wrapped * 120)}|${Math.round(s * 120)}`;

    if (!poolCenterMap.has(key)) {
      const p = surfaces.midpointAt(theta, Math.min(1, Math.max(0, s)));

      poolCenterMap.set(key, { radiusMul, scale, x: p.x, y: p.y, z: p.z });
    }
  };
  const noiseSeed = Math.floor(settings.seed * 31 + 7);

  // Warped midsurface position per grid vertex (i, j). Shard boundaries are
  // then cut where ownership flips, with the exact crossing interpolated inside
  // each cell instead of snapped to grid edges, so fracture lines stay smooth
  // at any zoom.
  const vertexTotal = (S + 1) * T;
  const warpedX = new Float64Array(vertexTotal);
  const warpedY = new Float64Array(vertexTotal);
  const warpedZ = new Float64Array(vertexTotal);

  for (let j = 0; j <= S; j += 1) {
    for (let i = 0; i < T; i += 1) {
      const id = j * T + i;
      const warped = warpPoint(
        surfaces.midpointAt(i * dTheta, warpMeridian(j / S)),
        noiseSeed,
      );

      warpedX[id] = warped.x;
      warpedY[id] = warped.y;
      warpedZ[id] = warped.z;
    }
  }

  // Surface area a single grid vertex stands for. The (theta, s) grid is even in
  // parameter space but not in area — rows near the pole are tiny — so a shard's
  // size has to be measured with this weight rather than by counting vertices.
  const rowArea = new Float64Array(S + 1);
  {
    let total = 0;

    for (let j = 0; j <= S; j += 1) {
      const here = surfaces.midpointAt(0, warpMeridian(j / S));
      const near = surfaces.midpointAt(0, warpMeridian(Math.min(S, j + 1) / S));
      const away = surfaces.midpointAt(0, warpMeridian(Math.max(0, j - 1) / S));
      const span = Math.hypot(near.x - away.x, near.y - away.y, near.z - away.z) / 2;

      rowArea[j] = Math.hypot(here.x, here.z) * dTheta * span;
      total += rowArea[j] * T;
    }

    for (let j = 0; j <= S; j += 1) {
      rowArea[j] /= total || 1;
    }
  }

  // A strike landing close to an existing crack carves a sliver off the cell it
  // hits: geometrically valid, but it reads as a chip of debris rather than a
  // shard, and the gold has to run a hairpin around it. Anything under this much
  // of the vessel's surface is absorbed back into whichever SIBLING it shares the
  // most edge with, so breaks stay clean. Ownership is rewritten before any
  // geometry is cut, so the crack network simply never contains the sliver.
  const minShardArea = 0.009;

  // `parent` maps each cell to the cell it was split out of by the generation
  // being applied. A sliver may only be absorbed by a sibling — a cell with the
  // same parent — because the boundary between siblings is one this strike just
  // cut, whereas the boundary to any other neighbour was cut by an earlier
  // strike and erasing it would rewrite damage the bowl already carries.
  const absorbSlivers = (
    cellTuples: number[][],
    resolved: Int32Array,
    parent: Int32Array,
  ): { cellTuples: number[][]; owners: Int32Array } => {
    const count = cellTuples.length;

    if (count < 2) {
      return { cellTuples, owners: resolved };
    }

    const area = new Float64Array(count);

    for (let j = 0; j <= S; j += 1) {
      for (let i = 0; i < T; i += 1) {
        area[resolved[j * T + i]] += rowArea[j];
      }
    }

    // Shared-boundary length between neighbouring cells, kept per cell so a
    // merge can fold one list into another.
    const adjacent: Map<number, number>[] = cellTuples.map(() => new Map<number, number>());
    const share = (a: number, b: number, amount: number): void => {
      if (a === b) {
        return;
      }

      adjacent[a].set(b, (adjacent[a].get(b) ?? 0) + amount);
      adjacent[b].set(a, (adjacent[b].get(a) ?? 0) + amount);
    };

    for (let j = 0; j <= S; j += 1) {
      for (let i = 0; i < T; i += 1) {
        const id = j * T + i;

        share(resolved[id], resolved[j * T + ((i + 1) % T)], rowArea[j]);

        if (j < S) {
          share(resolved[id], resolved[id + T], (rowArea[j] + rowArea[j + 1]) / 2);
        }
      }
    }

    // Merge smallest-first: absorbing a sliver only ever grows its host, so one
    // pass in size order settles without re-sorting.
    const merged = new Int32Array(count);

    for (let cell = 0; cell < count; cell += 1) {
      merged[cell] = cell;
    }

    const rootOf = (cell: number): number => {
      let root = cell;

      while (merged[root] !== root) {
        root = merged[root];
      }

      return root;
    };
    const order = [...cellTuples.keys()].sort((a, b) => area[a] - area[b]);
    let alive = count;

    for (const cell of order) {
      if (alive < 2 || area[cell] >= minShardArea) {
        continue;
      }

      const byRoot = new Map<number, number>();

      for (const [other, amount] of adjacent[cell]) {
        const root = rootOf(other);

        if (root !== cell && parent[root] === parent[cell]) {
          byRoot.set(root, (byRoot.get(root) ?? 0) + amount);
        }
      }

      let host = -1;
      let bestShare = 0;

      for (const [root, amount] of byRoot) {
        if (amount > bestShare) {
          host = root;
          bestShare = amount;
        }
      }

      if (host < 0) {
        continue;
      }

      merged[cell] = host;
      area[host] += area[cell];
      alive -= 1;

      for (const [other, amount] of adjacent[cell]) {
        const target = rootOf(other);

        if (target === host) {
          continue;
        }

        adjacent[host].set(target, (adjacent[host].get(target) ?? 0) + amount);
        adjacent[target].set(host, (adjacent[target].get(host) ?? 0) + amount);
      }
    }

    if (alive === count) {
      return { cellTuples, owners: resolved };
    }

    const remap = new Int32Array(count).fill(-1);
    const keptTuples: number[][] = [];

    for (let cell = 0; cell < count; cell += 1) {
      const root = rootOf(cell);

      if (remap[root] < 0) {
        remap[root] = keptTuples.length;
        keptTuples.push(cellTuples[root]);
      }

      remap[cell] = remap[root];
    }

    for (let id = 0; id < vertexTotal; id += 1) {
      resolved[id] = remap[resolved[id]];
    }

    return { cellTuples: keptTuples, owners: resolved };
  };

  // A vertex's shard is not "which seed is nearest" but "which seed was nearest
  // after each strike" — the whole tuple. Resolving one flattened diagram over
  // every accumulated seed is what used to erase history: a new seed that wins
  // a patch of surface takes the old boundaries inside that patch with it, so
  // an earlier strike's cracks vanished wherever a later strike landed near
  // them. Keeping the per-strike owners and splitting wherever ANY of them
  // disagrees overlays the generations instead: a crack cut by strike one is
  // still a boundary after strike four, and the new break terminates against
  // it the way a real second impact runs into an existing seam.
  const resolveOwnership = (
    batchSeeds: readonly FractureSeed[],
  ): { cellTuples: number[][]; owners: Int32Array } => {
    const generations = batchSeeds[batchSeeds.length - 1].batch + 1;
    const genOwners = new Int32Array(vertexTotal * generations);

    for (let id = 0; id < vertexTotal; id += 1) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      let generation = 0;

      // Seeds run oldest strike first, so the running nearest-seed sampled at
      // each batch boundary IS that strike's Voronoi owner: one pass over the
      // seeds yields every generation, no repeated scans.
      for (let index = 0; index < batchSeeds.length; index += 1) {
        while (batchSeeds[index].batch > generation) {
          genOwners[id * generations + generation] = best;
          generation += 1;
        }

        const distance = Math.hypot(
          warpedX[id] - batchSeeds[index].x,
          warpedY[id] - batchSeeds[index].y,
          warpedZ[id] - batchSeeds[index].z,
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }

      while (generation < generations) {
        genOwners[id * generations + generation] = best;
        generation += 1;
      }
    }

    // Near the pole every vertex is nearly equidistant from the seeds, which
    // produces alternating sliver wedges. Propagate ownership downward from the
    // first stable ring so cracks continue cleanly into the bowl center.
    for (let j = 0; j < 3; j += 1) {
      for (let i = 0; i < T; i += 1) {
        const from = (3 * T + i) * generations;
        const to = (j * T + i) * generations;

        for (let generation = 0; generation < generations; generation += 1) {
          genOwners[to + generation] = genOwners[from + generation];
        }
      }
    }

    // Split ONE GENERATION AT A TIME, absorbing slivers after each, rather than
    // keying every vertex by its whole tuple and absorbing once at the end.
    //
    // This is what keeps damage cumulative. Absorbing a sliver deletes the crack
    // between it and its host; done on the final diagram, a sliver that a LATER
    // strike happens to carve out of an EARLIER shard takes an old crack line
    // with it, and the whole point of the overlay model is that a strike never
    // erases a line an earlier strike cut. Deciding it generation by generation
    // means each merge only ever removes a boundary belonging to the strike
    // being applied, and the merge is carried forward into every later
    // generation's keys — so a shard absorbed after strike two is still absorbed
    // after strike five, and nothing older than the strike in hand can move.
    let cellTuples: number[][] = [[]];
    let resolved: Int32Array = new Int32Array(vertexTotal);

    for (let generation = 0; generation < generations; generation += 1) {
      const splitTuples: number[][] = [];
      const splitParent: number[] = [];
      const cellIds = new Map<string, number>();
      const split = new Int32Array(vertexTotal);

      for (let id = 0; id < vertexTotal; id += 1) {
        const from = resolved[id];
        const owner = genOwners[id * generations + generation];
        const key = `${from},${owner}`;
        let cell = cellIds.get(key);

        if (cell === undefined) {
          cell = splitTuples.length;
          cellIds.set(key, cell);
          splitTuples.push([...cellTuples[from], owner]);
          splitParent.push(from);
        }

        split[id] = cell;
      }

      ({ cellTuples, owners: resolved } = absorbSlivers(
        splitTuples,
        split,
        Int32Array.from(splitParent),
      ));
    }

    return { cellTuples, owners: resolved };
  };

  // Overlaying generations means a strike adds more shards than it adds seeds,
  // and how many depends on where it landed, so the ceiling cannot be enforced
  // by rationing seeds up front the way a flat diagram could. Resolve the whole
  // history, and if the newest strike would push the vessel past the shard
  // limit every performance budget is proven at, drop it and keep the network
  // the bowl already carries — the strike still shatters and repairs, it just
  // stops adding damage. Ownership is the cheap half of the build (no geometry
  // is emitted), and this only ever re-runs once the vessel is near saturation.
  let impactLimit = settings.impacts.length;
  let seeds = generateSeeds(surfaces, settings, impactLimit, noiseSeed);
  let ownership = resolveOwnership(seeds);

  while (impactLimit > 1 && ownership.cellTuples.length > maxAccumulatedSeeds) {
    impactLimit -= 1;
    seeds = generateSeeds(surfaces, settings, impactLimit, noiseSeed);
    ownership = resolveOwnership(seeds);
  }

  const owners = ownership.owners;

  // Two neighbouring cells disagree about at least one strike; the earliest one
  // they disagree on is the strike whose crack runs between them, and its two
  // seeds are the pair the boundary must be solved against. Later disagreements
  // are boundaries too, but they belong to cracks that meet this one at a
  // junction rather than to the edge being cut here.
  const seedPairFor = (cellA: number, cellB: number): { a: number; b: number } => {
    const tupleA = ownership.cellTuples[cellA];
    const tupleB = ownership.cellTuples[cellB];

    for (let generation = 0; generation < tupleA.length; generation += 1) {
      if (tupleA[generation] !== tupleB[generation]) {
        return { a: tupleA[generation], b: tupleB[generation] };
      }
    }

    return { a: tupleA[tupleA.length - 1], b: tupleB[tupleB.length - 1] };
  };

  const normalizeI = (i: number): number => ((i % T) + T) % T;

  const makeVertex = (i: number, j: number): GridVertex => {
    const iNorm = normalizeI(i);
    const id = j * T + iNorm;

    return {
      iNorm,
      id,
      j,
      key: `g${id}`,
      owner: owners[id],
      s: warpMeridian(j / S),
      theta: i * dTheta,
    };
  };

  // Signed distance difference to two seeds, evaluated at the stabilized row
  // (rows <= 2 read row 3) so the bisector stays consistent with propagated
  // ownership and the near-pole cuts run straight into the center.
  const seedDistanceAt = (vertex: GridVertex, seedIndex: number): number => {
    const id = (vertex.j < 3 ? 3 : vertex.j) * T + vertex.iNorm;
    const seed = seeds[seedIndex];

    return Math.hypot(warpedX[id] - seed.x, warpedY[id] - seed.y, warpedZ[id] - seed.z);
  };

  // Where the bisector between the two vertices' owners crosses the edge,
  // cached by edge so both adjacent triangles split at the identical point.
  const crossingTs = new Map<string, number>();

  const crossing = (va: GridVertex, vb: GridVertex): KeyedPoint => {
    const flipped = va.id > vb.id;
    const lo = flipped ? vb : va;
    const hi = flipped ? va : vb;
    const key = `e${lo.id}:${hi.id}`;
    let t = crossingTs.get(key);

    if (t === undefined) {
      const pair = seedPairFor(lo.owner, hi.owner);
      const fLo = seedDistanceAt(lo, pair.a) - seedDistanceAt(lo, pair.b);
      const fHi = seedDistanceAt(hi, pair.a) - seedDistanceAt(hi, pair.b);
      const denominator = fLo - fHi;

      t = denominator !== 0 ? fLo / denominator : 0.5;

      if (!Number.isFinite(t) || t <= 0 || t >= 1) {
        t = 0.5;
      }

      t = Math.min(0.94, Math.max(0.06, t));
      crossingTs.set(key, t);
    }

    const local = flipped ? 1 - t : t;

    return {
      boundary: true,
      key,
      s: va.s + (vb.s - va.s) * local,
      theta: va.theta + (vb.theta - va.theta) * local,
    };
  };

  const builders = new Map<number, ShardBuilder>();

  const builderFor = (cellId: number): ShardBuilder => {
    let builder = builders.get(cellId);

    if (!builder) {
      builder = {
        bisqueNormals: [],
        bisquePositions: [],
        glazeNormals: [],
        glazePositions: [],
        positionSampleCount: 0,
        positionSumX: 0,
        positionSumY: 0,
        positionSumZ: 0,
      };
      builders.set(cellId, builder);
    }

    return builder;
  };

  // Skin polygons are queued, then emitted after the fracture-wall normals
  // are known: vertices on the fracture line retreat along the SAME per-point
  // averaged wall direction that positions the crack walls, so every polygon
  // of a shard shifts a shared point identically (watertight skins) and the
  // assembled bowl shows a clean open channel between shards for the gold.
  const pendingPolygons: Array<{
    owner: number;
    polygon: readonly (ParamPoint | KeyedPoint)[];
  }> = [];

  const emitPolygon = (owner: number, polygon: readonly (ParamPoint | KeyedPoint)[]): void => {
    pendingPolygons.push({ owner, polygon });
  };

  // Wall quads are collected first, then emitted with normals averaged per
  // crossing point so the fracture wall shades and offsets as one smooth
  // strip instead of banding quad by quad.
  type WallSegment = {
    a: KeyedPoint;
    b: KeyedPoint;
    ownerA: number;
    ownerB: number;
  };

  const wallSegments: WallSegment[] = [];

  const segments: SeamSegment[] = [];

  const handleBoundary = (
    a: KeyedPoint,
    b: KeyedPoint,
    ownerA: number,
    ownerB: number,
  ): void => {
    wallSegments.push({ a, b, ownerA, ownerB });

    if ((a.s + b.s) / 2 >= seamMinS) {
      segments.push({
        a: { s: a.s, theta: a.theta },
        aKey: a.key,
        b: { s: b.s, theta: b.theta },
        bKey: b.key,
      });
    }
  };

  // Split one grid triangle along the smooth bisector between its vertices'
  // owners. Two owners cut off the lone corner; three owners meet at a
  // junction point connected to a crossing on each edge.
  const processTriangle = (
    v0: GridVertex,
    v1: GridVertex,
    v2: GridVertex,
    junctionKey: string,
  ): void => {
    const distinct =
      v0.owner === v1.owner && v1.owner === v2.owner
        ? 1
        : v0.owner !== v1.owner && v1.owner !== v2.owner && v0.owner !== v2.owner
          ? 3
          : 2;

    if (distinct === 1) {
      emitPolygon(v0.owner, [v0, v1, v2]);
      return;
    }

    if (distinct === 3) {
      const c01 = crossing(v0, v1);
      const c12 = crossing(v1, v2);
      const c20 = crossing(v2, v0);
      const junction: KeyedPoint = {
        boundary: true,
        key: junctionKey,
        s: (c01.s + c12.s + c20.s) / 3,
        theta: (c01.theta + c12.theta + c20.theta) / 3,
      };

      // A three-way meeting: the gold pools here, so the crack opens widest.
      if (junction.s >= seamMinS) {
        addPoolCenter(junction.theta, junction.s, 1);
      }

      emitPolygon(v0.owner, [v0, c01, junction, c20]);
      emitPolygon(v1.owner, [v1, c12, junction, c01]);
      emitPolygon(v2.owner, [v2, c20, junction, c12]);
      handleBoundary(c01, junction, v0.owner, v1.owner);
      handleBoundary(c12, junction, v1.owner, v2.owner);
      handleBoundary(c20, junction, v2.owner, v0.owner);
      return;
    }

    const [lone, next, prev] =
      v1.owner === v2.owner
        ? [v0, v1, v2]
        : v0.owner === v2.owner
          ? [v1, v2, v0]
          : [v2, v0, v1];
    const cNext = crossing(lone, next);
    const cPrev = crossing(prev, lone);

    emitPolygon(lone.owner, [lone, cNext, cPrev]);
    emitPolygon(next.owner, [cNext, next, prev, cPrev]);
    handleBoundary(cNext, cPrev, lone.owner, next.owner);
  };

  // Pole fan: every fan triangle meets at the exact pole point, and boundary
  // cuts run straight from ring 1 into the pole.
  const polePoint: KeyedPoint = { key: "pole", s: 0, theta: 0 };
  // At s = 0 every theta maps to the same point on the axis, so a pole endpoint
  // can carry the theta of the crack that arrives there without moving. It must:
  // the gold centerline is resampled by lerping (theta, s), so a run ending at
  // theta 0 instead of its own theta would spiral around the center rather than
  // driving straight into it. All of them still share the key "pole", which is
  // what makes the chainer treat the center as one high-degree junction.
  const poleAt = (theta: number): KeyedPoint => ({
    boundary: true,
    key: "pole",
    s: 0,
    theta,
  });
  let poleIsCracked = false;

  for (let i = 0; i < T; i += 1) {
    const vL = makeVertex(i, 1);
    const vR = makeVertex(i + 1, 1);

    if (vL.owner === vR.owner) {
      emitPolygon(vL.owner, [polePoint, vL, vR]);
      continue;
    }

    const c = crossing(vL, vR);

    emitPolygon(vL.owner, [polePoint, vL, c]);
    emitPolygon(vR.owner, [polePoint, c, vR]);
    // Through handleBoundary (not straight into wallSegments) so the ring-1 ->
    // pole cut is a GOLD segment too, not just a crack wall.
    handleBoundary(poleAt(c.theta), c, vL.owner, vR.owner);
    poleIsCracked = true;
  }

  // The center is where the most cracks meet of anywhere on the bowl, so it
  // pools like the junction it is. Scaled a little under a regular junction:
  // several runs converge inside one pool radius here and their metaball overlap
  // already swells the middle, so a full-strength bloom on top reads as a blob.
  if (poleIsCracked) {
    addPoolCenter(0, 0, 0.7);
  }

  // Body quads between ring j and j+1.
  for (let j = 1; j < S; j += 1) {
    for (let i = 0; i < T; i += 1) {
      const v00 = makeVertex(i, j);
      const v10 = makeVertex(i + 1, j);
      const v11 = makeVertex(i + 1, j + 1);
      const v01 = makeVertex(i, j + 1);

      if (
        v00.owner === v10.owner &&
        v10.owner === v11.owner &&
        v11.owner === v01.owner
      ) {
        emitPolygon(v00.owner, [v00, v10, v11, v01]);
        continue;
      }

      processTriangle(v00, v10, v11, `ja${i}:${j}`);
      processTriangle(v00, v11, v01, `jb${i}:${j}`);
    }
  }

  // Rim lip, split at the crack's crossing theta so the fracture cuts all the
  // way through the edge of the bowl.
  const emitRimStrip = (owner: number, thetaA: number, thetaB: number): void => {
    const builder = builderFor(owner);

    for (let step = 0; step < 2; step += 1) {
      const t0 = step / 2;
      const t1 = (step + 1) / 2;
      const r00 = surfaces.rimAt(thetaA, t0);
      const r10 = surfaces.rimAt(thetaB, t0);
      const r11 = surfaces.rimAt(thetaB, t1);
      const r01 = surfaces.rimAt(thetaA, t1);

      pushTriangle(builder.glazePositions, builder.glazeNormals, r00, r10, r11);
      pushTriangle(builder.glazePositions, builder.glazeNormals, r00, r11, r01);
    }
  };

  // Cut face between the rim lip and the chord joining the two skins at the
  // top edge; without it a shattered shard shows a slit under the lip.
  const emitRimWall = (
    thetaStar: number,
    ownerLow: number,
    ownerHigh: number,
    halfGap: number,
  ): void => {
    const outerTop = surfaces.outerAt(thetaStar, 1);
    const innerTop = surfaces.innerAt(thetaStar, 1);
    const tx = -Math.sin(thetaStar);
    const tz = Math.cos(thetaStar);
    const steps = 4;

    const emit = (cellId: number, sign: 1 | -1): void => {
      const builder = builderFor(cellId);
      const shift = -sign * halfGap;
      const point = (t: number, onRim: boolean): SurfaceSample => {
        const rim = surfaces.rimAt(thetaStar, t);
        const x = onRim ? rim.x : outerTop.x + (innerTop.x - outerTop.x) * t;
        const y = onRim ? rim.y : outerTop.y + (innerTop.y - outerTop.y) * t;
        const z = onRim ? rim.z : outerTop.z + (innerTop.z - outerTop.z) * t;

        return {
          nx: sign * tx,
          ny: 0,
          nz: sign * tz,
          x: x + shift * tx,
          y,
          z: z + shift * tz,
        };
      };

      for (let step = 0; step < steps; step += 1) {
        const t0 = step / steps;
        const t1 = (step + 1) / steps;
        const corners = [point(t0, false), point(t0, true), point(t1, true), point(t1, false)];
        // Wind front-facing along the cut normal for consistent DoubleSide
        // shading on both sides of the cut.
        const [a, b, c, d] =
          sign === 1 ? corners : [corners[0], corners[3], corners[2], corners[1]];

        pushTriangle(builder.bisquePositions, builder.bisqueNormals, a, b, c);
        pushTriangle(builder.bisquePositions, builder.bisqueNormals, a, c, d);
      }
    };

    emit(ownerLow, 1);
    emit(ownerHigh, -1);
  };

  // The lip cut needs the width model, which needs the rim pool centers this
  // pass collects — so record the crossings now and cut the lip further down,
  // once `rimGapAt` exists. Pieces of lip are queued rather than emitted for the
  // same reason: a wide pool can eat past its own grid cell into a neighbour's.
  type RimPiece = { owner: number; thetaA: number; thetaB: number };
  type RimCut = {
    ownerHigh: number;
    ownerLow: number;
    theta: number;
  };
  const rimPieces: RimPiece[] = [];
  const rimCuts: RimCut[] = [];

  for (let i = 0; i < T; i += 1) {
    const vL = makeVertex(i, S);
    const vR = makeVertex(i + 1, S);

    if (vL.owner === vR.owner) {
      rimPieces.push({ owner: vL.owner, thetaA: vL.theta, thetaB: vR.theta });
      continue;
    }

    const c = crossing(vL, vR);

    // NO pool center at a rim ending. A junction pools because several runs
    // converge there and the gold has somewhere to gather; a rim ending is just
    // where the crack runs off the edge of the bowl, and the gold's own width is
    // all there is to fill. Blooming it here made the gold widest at exactly the
    // lip — measured 1.3-1.9x the vein a wall-thickness below — and because the
    // crack surface is radial the crossing runs ACROSS the lip, so that extra
    // width read as a strap laid perpendicular to the vein that fed it, joined to
    // it at a visible step. Spreading the bloom down the vein (radiusMul 2) only
    // made the strap's shoulders longer; the peak still sat on the lip.
    //
    // Endings still read small/medium/large: the body flow noise alone spans
    // 0.011-0.024 half-width across the crossings of one fracture, a 2x swing,
    // and it is the SAME model the shard channel is cut from, so the gap at the
    // rim stays in proportion to the gold that fills it.

    rimPieces.push({ owner: vL.owner, thetaA: vL.theta, thetaB: c.theta });
    rimPieces.push({ owner: vR.owner, thetaA: c.theta, thetaB: vR.theta });
    rimCuts.push({
      ownerHigh: vR.owner,
      ownerLow: vL.owner,
      theta: c.theta,
    });
  }

  // All junction + rim pool centers are now known; build the shared width model.
  // Both the shard retreat below and the gold seam builder evaluate it, so the
  // crack the shards open exactly matches the gold that fills it — pooling wide
  // at junctions and by a random amount at each rim ending.
  const poolCenters = new Float32Array(poolCenterMap.size * 5);
  {
    let k = 0;

    for (const center of poolCenterMap.values()) {
      poolCenters[k] = center.x;
      poolCenters[k + 1] = center.y;
      poolCenters[k + 2] = center.z;
      poolCenters[k + 3] = center.scale;
      poolCenters[k + 4] = center.radiusMul;
      k += 5;
    }
  }

  const widthModel = createSeamWidthModel({
    generosity: Math.max(0, settings.width ?? 0),
    poolCenters,
    seed: settings.seed,
  });
  // Half-width the shards retreat at a world point. The crack tracks the SAME
  // width model as the gold, so the channel opens to (just under) the gold's
  // width everywhere — variable along each run and POOLING wide at junctions —
  // and the gold fills the crack instead of painting over a thin line.
  //
  // The shard-edge sawtooth is NOT caused by this variation. The offset edge is
  // (smoothed position) + gap * normal, so teeth = local_gap * (residual normal
  // wobble). A wide/variable gap only makes teeth visible because it multiplies
  // the wobble; the cure is to drive the wobble ~0 (see relaxNormals below, run
  // to convergence), after which the edge is smooth at ANY gap. The crack is
  // scaled a touch under the gold (0.9) and pools slightly less (poolMul 0.85)
  // so the rounder gold always laps over the ceramic edge — no bare sliver.
  const gapAt = (x: number, y: number, z: number): number =>
    Math.max(seamHalfGap * 0.6, seamHalfWidthAt(widthModel, x, y, z, 0.85) * 0.9);

  // Half-gap at the rim lip for a crack crossing at this theta. The lip strips,
  // the rim wall and the skins' top row all read this ONE value so they stay
  // flush with each other (a mismatch there is what used to show as a lip tab).
  //
  // The lip is cut to the GOLD's own half-width here (`goldFill` 1.1 in seams.ts,
  // less a hair), not to `gapAt`'s 0.9. On the curved skin the gold's 22% lap over
  // the ceramic edge is invisible — it is a rounded meniscus running along a
  // rounded surface, and it is what guarantees no bare sliver. On the LIP the
  // notch is a straight-sided slot cut square across a narrow flat band, so the
  // same lap comes out as a rectangular flange of gold lying flush on the ceramic
  // either side of the slot, with hard corners at each end of it — a collar
  // around every crossing that reads as a separate part from the rounded pad
  // filling the slot. Cutting the slot to the gold's own width leaves the pad and
  // nothing else. Verified against a matched-seed A/B (scratchpad tight/ vs
  // fix2/): the collar is gone at all eight crossings and no ceramic shows
  // through. The 4% that is still lapped is under a fifth of a grid cell — enough
  // that the sub-cell coverage silhouette can never expose the notch edge.
  const rimLipLap = 1.04;
  const rimGapAt = (theta: number): number => {
    const m = surfaces.midpointAt(theta, 1);

    return Math.max(
      seamHalfGap * 0.6,
      seamHalfWidthAt(widthModel, m.x, m.y, m.z) * rimLipLap,
    );
  };

  // Second rim pass: the width model exists now, so each crossing gets its own
  // channel — variable along the rim and pooled wide where a run ends there,
  // exactly the width the gold is built to and the skins retreat to.
  {
    const twoPi = Math.PI * 2;
    const notches: { high: number; low: number }[] = [];

    for (const cut of rimCuts) {
      const rim = surfaces.rimAt(cut.theta, 0.5);
      const halfGap = rimGapAt(cut.theta);
      const halfTheta = halfGap / Math.max(0.2, Math.hypot(rim.x, rim.z));

      emitRimWall(cut.theta, cut.ownerLow, cut.ownerHigh, halfGap);

      // The lip wraps, so a notch near theta = 0 also has to clip pieces near 2pi.
      for (const wrap of [-twoPi, 0, twoPi]) {
        notches.push({
          high: cut.theta + halfTheta + wrap,
          low: cut.theta - halfTheta + wrap,
        });
      }
    }

    for (const piece of rimPieces) {
      let spans: [number, number][] = [[piece.thetaA, piece.thetaB]];

      for (const notch of notches) {
        const next: [number, number][] = [];

        for (const [a, b] of spans) {
          if (notch.high <= a || notch.low >= b) {
            next.push([a, b]);
            continue;
          }

          if (notch.low > a) {
            next.push([a, notch.low]);
          }

          if (notch.high < b) {
            next.push([notch.high, b]);
          }
        }

        spans = next;
      }

      for (const [a, b] of spans) {
        if (b - a > 1e-4) {
          emitRimStrip(piece.owner, a, b);
        }
      }
    }
  }

  // The warped Voronoi cut crosses the grid one edge at a time, so consecutive
  // crossing points zig-zag at grid resolution and the shard edges read as
  // sawtooth. Relax the crossing positions along each crack polyline — keeping
  // junctions (degree >= 3), the rim, the pole, and dangling ends pinned — so
  // shard edges become smooth curves. Skins, walls, and the gold centerline
  // all read these relaxed positions, so the pieces stay watertight and the
  // gold keeps sitting in the middle of the now-smooth channel.
  const smoothedBoundary = ((): Map<string, ParamPoint> => {
    const points = new Map<string, { s: number; theta: number }>();
    const neighbors = new Map<string, Set<string>>();

    const register = (point: KeyedPoint): void => {
      if (!points.has(point.key)) {
        points.set(point.key, { s: point.s, theta: point.theta });
      }
    };
    const link = (a: KeyedPoint, b: KeyedPoint): void => {
      register(a);
      register(b);

      if (a.key === b.key) {
        return;
      }

      const forA = neighbors.get(a.key) ?? new Set<string>();
      const forB = neighbors.get(b.key) ?? new Set<string>();

      forA.add(b.key);
      forB.add(a.key);
      neighbors.set(a.key, forA);
      neighbors.set(b.key, forB);
    };

    for (const segment of wallSegments) {
      link(segment.a, segment.b);
    }

    const isPinned = (key: string): boolean => {
      if (key === "pole") {
        return true;
      }

      const point = points.get(key);

      // Pin only the very top rim row. The near-pole center is NOT blanket
      // pinned any more (that left the worst sawtooth, the star where every
      // shard meets at the bowl center, un-smoothed). Instead only the ring of
      // crossings directly wired to the pole is held, because averaging their
      // theta against the pole — where theta is degenerate — would swing them
      // sideways. Everything inward of the rim and outward of that ring relaxes.
      if (!point || point.s >= 0.999) {
        return true;
      }

      const adjacency = neighbors.get(key);

      if (!adjacency || adjacency.has("pole")) {
        return true;
      }

      // Junctions hold the Y-meeting sharp; degree < 2 is a dangling tip.
      return adjacency.size !== 2;
    };

    const iterations = 20;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const snapshot = new Map(
        [...points].map(([key, value]) => [key, { ...value }] as const),
      );

      for (const [key, set] of neighbors) {
        if (isPinned(key)) {
          continue;
        }

        const current = snapshot.get(key)!;
        let sSum = 0;
        let thetaSum = 0;
        let count = 0;

        for (const neighborKey of set) {
          const neighbor = snapshot.get(neighborKey)!;
          let theta = neighbor.theta;

          // Unwrap across the theta seam relative to the point being moved.
          while (theta - current.theta > Math.PI) {
            theta -= Math.PI * 2;
          }

          while (current.theta - theta > Math.PI) {
            theta += Math.PI * 2;
          }

          sSum += neighbor.s;
          thetaSum += theta;
          count += 1;
        }

        if (count === 0) {
          continue;
        }

        const target = points.get(key)!;

        target.s = current.s * 0.5 + (sSum / count) * 0.5;
        target.theta = current.theta * 0.5 + (thetaSum / count) * 0.5;
      }
    }

    return points;
  })();

  // Resolve a point's parameter position, preferring the relaxed boundary
  // position when one exists (grid-interior vertices keep their own).
  const paramOf = (point: { key?: string; s: number; theta: number }): ParamPoint =>
    point.key !== undefined && smoothedBoundary.has(point.key)
      ? smoothedBoundary.get(point.key)!
      : { s: point.s, theta: point.theta };

  // Fold the relaxed positions back into the seam segments so the gold
  // centerline follows the same smooth curve as the shard channel.
  // "pole" is excluded: smoothedBoundary stores ONE entry per key, so folding it
  // back would overwrite every pole endpoint's own theta with whichever crack
  // registered first, splaying the near-center runs sideways. Its s is 0 either
  // way, so the world position is identical — only the approach direction the
  // gold centerline is resampled along would be lost.
  for (const segment of segments) {
    const a = segment.aKey === "pole" ? undefined : smoothedBoundary.get(segment.aKey);
    const b = segment.bKey === "pole" ? undefined : smoothedBoundary.get(segment.bKey);

    if (a) {
      segment.a = { s: a.s, theta: a.theta };
    }

    if (b) {
      segment.b = { s: b.s, theta: b.theta };
    }
  }

  // Pass 1: per-segment face normals, oriented from the lower-id owner
  // toward the higher-id owner and accumulated at each crossing point.
  const wallNormalSums = new Map<string, { x: number; y: number; z: number }>();

  const pairPointKey = (segment: WallSegment, pointKey: string): string => {
    const low = Math.min(segment.ownerA, segment.ownerB);
    const high = Math.max(segment.ownerA, segment.ownerB);

    return `${low}|${high}|${pointKey}`;
  };

  const segmentFaceNormal = (
    segment: WallSegment,
  ): { x: number; y: number; z: number } => {
    const pa = paramOf(segment.a);
    const pb = paramOf(segment.b);
    const outerA = surfaces.outerAt(pa.theta, pa.s);
    const outerB = surfaces.outerAt(pb.theta, pb.s);
    const innerA = surfaces.innerAt(pa.theta, pa.s);
    const low = Math.min(segment.ownerA, segment.ownerB);
    const high = Math.max(segment.ownerA, segment.ownerB);
    // The wall's two sides are cells, not seeds; the strike that cut this wall
    // supplies the seed pair whose field orients it.
    const wallSeeds = seedPairFor(low, high);
    const lowSeed = seeds[wallSeeds.a];
    const highSeed = seeds[wallSeeds.b];
    const towardHighX = highSeed.x - lowSeed.x;
    const towardHighY = highSeed.y - lowSeed.y;
    const towardHighZ = highSeed.z - lowSeed.z;
    const e1x = outerB.x - outerA.x;
    const e1y = outerB.y - outerA.y;
    const e1z = outerB.z - outerA.z;
    const e2x = innerA.x - outerA.x;
    const e2y = innerA.y - outerA.y;
    const e2z = innerA.z - outerA.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz);

    if (length < 1e-9) {
      const fallback = Math.hypot(towardHighX, towardHighY, towardHighZ) || 1;

      return { x: towardHighX / fallback, y: towardHighY / fallback, z: towardHighZ / fallback };
    }

    nx /= length;
    ny /= length;
    nz /= length;

    // Orient the normal toward the higher-id shard by probing the warped
    // Voronoi field on both sides of the wall. A plain seed-direction dot
    // product flips wherever the crack curves away from the seed axis, which
    // corrugates the wall into alternating front/back-facing quads.
    const midTheta = (pa.theta + pb.theta) / 2;
    const midS = Math.max((pa.s + pb.s) / 2, 3 / S);
    const mid = surfaces.midpointAt(midTheta, midS);
    const probeEpsilon = 0.02;
    const fieldToward = (sign: 1 | -1): number => {
      const warped = warpPoint(
        {
          x: mid.x + sign * probeEpsilon * nx,
          y: mid.y + sign * probeEpsilon * ny,
          z: mid.z + sign * probeEpsilon * nz,
        },
        noiseSeed,
      );
      const toHigh = Math.hypot(
        warped.x - highSeed.x,
        warped.y - highSeed.y,
        warped.z - highSeed.z,
      );
      const toLow = Math.hypot(
        warped.x - lowSeed.x,
        warped.y - lowSeed.y,
        warped.z - lowSeed.z,
      );

      return toHigh - toLow;
    };

    if (fieldToward(1) > fieldToward(-1)) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    return { x: nx, y: ny, z: nz };
  };

  const segmentNormals = wallSegments.map(segmentFaceNormal);

  wallSegments.forEach((segment, index) => {
    const normal = segmentNormals[index];

    for (const pointKey of [segment.a.key, segment.b.key]) {
      const key = pairPointKey(segment, pointKey);
      const sum = wallNormalSums.get(key);

      if (sum) {
        sum.x += normal.x;
        sum.y += normal.y;
        sum.z += normal.z;
      } else {
        wallNormalSums.set(key, { ...normal });
      }
    }
  });

  // Per-(owner, boundary point) retreat direction: the average of the wall
  // normals of every incident segment, oriented into the owner's territory.
  // Skins pull back along these so both faces and all polygons of a shard
  // agree on where its edge sits.
  const retreatDirections = new Map<string, { x: number; y: number; z: number }>();

  wallSegments.forEach((segment, index) => {
    const normal = segmentNormals[index];
    const low = Math.min(segment.ownerA, segment.ownerB);
    const high = Math.max(segment.ownerA, segment.ownerB);

    for (const pointKey of [segment.a.key, segment.b.key]) {
      for (const [owner, sign] of [
        [low, -1],
        [high, 1],
      ] as const) {
        const key = `${owner}|${pointKey}`;
        const sum = retreatDirections.get(key);

        if (sum) {
          sum.x += sign * normal.x;
          sum.y += sign * normal.y;
          sum.z += sign * normal.z;
        } else {
          retreatDirections.set(key, {
            x: sign * normal.x,
            y: sign * normal.y,
            z: sign * normal.z,
          });
        }
      }
    }
  });

  // The gap now opens WIDE, which multiplies any residual grid-scale wiggle in
  // the retreat direction into a visible sawtooth on the shard edge (a narrow
  // gap hid it). Relax the retreat normals ALONG each crack so the offset edge
  // stays smooth at any gap width. Point keys never contain "|", so the map keys
  // (`owner|pointKey`, `low|high|pointKey`) split cleanly.
  const keyNeighbors = new Map<string, Set<string>>();
  const linkKeys = (a: string, b: string): void => {
    if (a === b) {
      return;
    }

    let forA = keyNeighbors.get(a);

    if (!forA) {
      forA = new Set<string>();
      keyNeighbors.set(a, forA);
    }

    forA.add(b);

    let forB = keyNeighbors.get(b);

    if (!forB) {
      forB = new Set<string>();
      keyNeighbors.set(b, forB);
    }

    forB.add(a);
  };

  for (const segment of wallSegments) {
    linkKeys(segment.a.key, segment.b.key);
  }

  const relaxNormals = (
    map: Map<string, { x: number; y: number; z: number }>,
    prefixLength: (key: string) => number,
    passes: number,
  ): void => {
    for (let pass = 0; pass < passes; pass += 1) {
      const snapshot = new Map(
        [...map].map(([key, value]) => [key, { ...value }] as const),
      );

      for (const [key, vec] of map) {
        const cut = prefixLength(key);
        const prefix = key.slice(0, cut);
        const adjacency = keyNeighbors.get(key.slice(cut));

        if (!adjacency) {
          continue;
        }

        const base = snapshot.get(key)!;
        const baseLength = Math.hypot(base.x, base.y, base.z) || 1;
        let x = base.x / baseLength;
        let y = base.y / baseLength;
        let z = base.z / baseLength;

        for (const neighborPointKey of adjacency) {
          const neighbor = snapshot.get(prefix + neighborPointKey);

          if (!neighbor) {
            continue;
          }

          const length = Math.hypot(neighbor.x, neighbor.y, neighbor.z) || 1;

          x += neighbor.x / length;
          y += neighbor.y / length;
          z += neighbor.z / length;
        }

        const length = Math.hypot(x, y, z) || 1;

        vec.x = x / length;
        vec.y = y / length;
        vec.z = z / length;
      }
    }
  };

  // Relax HARD. The offset shard edge is (smoothed position) + gap * normal, and
  // with the gap now open wide any mid-frequency wobble left in the retreat
  // normal is multiplied straight into a visible sawtooth. 6 passes left a
  // period-8 wobble at ~39%; 30 passes drives it below 1%, so the offset edge is
  // as smooth as the (already heavily smoothed) crossing polyline underneath it.
  // retreatDirections key = `${owner}|${pointKey}` — the direction each shard
  // point retreats. wallNormalSums key = `${low}|${high}|${pointKey}` — used only
  // for wall SHADING now (geometry comes from the shared retreated-position map
  // below). Modest relaxation is enough; the final EDGE smoothness is handled by
  // Taubin-smoothing the retreated positions, not by perfecting these normals.
  relaxNormals(retreatDirections, (key) => key.indexOf("|") + 1, 16);
  relaxNormals(
    wallNormalSums,
    (key) => key.indexOf("|", key.indexOf("|") + 1) + 1,
    16,
  );

  // ONE retreated position per (owner, boundary point), shared by the skin and
  // the wall so their edges are identical, then Taubin-smoothed directly. This
  // is the fix for the shard-edge sawtooth: retreating a coarse per-cell polyline
  // by a wide gap scallops the edge no matter how smooth the direction is, so we
  // smooth the RESULTING positions (low-pass that removes the per-cell teeth
  // while pinning junctions/rim/pole to keep the crack's shape and sharp Y's).
  type Retreated = {
    ox: number; oy: number; oz: number; // outer face, retreated
    ix: number; iy: number; iz: number; // inner face, retreated
    ox0: number; oy0: number; oz0: number; // outer face, ORIGINAL (pre-retreat)
    ix0: number; iy0: number; iz0: number; // inner face, ORIGINAL (pre-retreat)
    s: number; // param s of the base point (for rim pinning)
    pin: boolean;
  };
  const retreatedPos = new Map<string, Retreated>();
  const addRetreated = (owner: number, point: KeyedPoint): void => {
    const key = `${owner}|${point.key}`;

    if (point.key === "pole" || retreatedPos.has(key)) {
      return;
    }

    const p = paramOf(point);
    const o = surfaces.outerAt(p.theta, p.s);
    const inr = surfaces.innerAt(p.theta, p.s);
    let ox = o.x;
    let oy = o.y;
    let oz = o.z;
    let ix = inr.x;
    let iy = inr.y;
    let iz = inr.z;
    const direction = retreatDirections.get(key);

    if (direction) {
      // The lip strip, the rim wall and the skin's top row now all read the same
      // width model, so the skin no longer has to taper down to a constant to
      // meet the lip: it keeps its full, pooling width right up to the rim and
      // the channel stays open through the edge of the bowl. The last 15% of s
      // is still blended onto rimGapAt so the top row lands on exactly the value
      // the lip was cut at rather than a wall-thickness away from it.
      const fullGap = gapAt(o.x, o.y, o.z);
      const rimBlend = Math.max(0, Math.min(1, (p.s - 0.85) / 0.15));
      const gap = fullGap + (rimGapAt(p.theta) - fullGap) * rimBlend;
      // ...and the crack SQUARES UP to the rim over the same last 15%: the
      // retreat direction swings round to the lip tangent, so the channel meets
      // the edge of the bowl head-on however obliquely the crack was running.
      //
      // This is what kills the slab at the crossings. The crack surface is
      // radial, so it meets the lip in a constant-theta line; offsetting an
      // oblique boundary by `gap` PERPENDICULAR to itself slides its top-row
      // crossing sideways to gap/sin(alpha) along the lip. Everything that has
      // to cover that opening — the lip cut, the rim wall, the gold band, all of
      // which run at constant theta — then has to be mitred by the same figure,
      // and sin(alpha) floors at ~0.35, so a near-tangential crack ended up with
      // a band nearly 3x the vein's width lying square across the rim with a
      // vein half its size feeding it. That is the flat dart at every crossing.
      //
      // Swinging the direction instead of widening the band costs nothing that
      // reads: the crack opens by `gap` at the rim exactly as it does further
      // down, it just opens perpendicular to the lip rather than perpendicular
      // to itself over the last few rows. Cracks curve; nothing about that looks
      // wrong. And it makes the lip cut, the rim wall and the gold band agree at
      // ±gap with no mitre anywhere.
      const lipX = -Math.sin(p.theta);
      const lipZ = Math.cos(p.theta);
      // Retreat IN the surface tangent plane. The raw wall-face normal tilts out
      // of the bowl surface, so retreating along it lifts the shard edge off the
      // surface and the skin triangles near the edge fold into little flaps — a
      // corrugation that scales with the gap and reads as sawtooth. Projecting
      // the direction onto each face's tangent plane keeps the edge on the
      // surface, so the retreated skin stays flat and smooth.
      const project = (
        nx: number,
        ny: number,
        nz: number,
      ): [number, number, number] => {
        const dot = direction.x * nx + direction.y * ny + direction.z * nz;
        let tx = direction.x - dot * nx;
        let ty = direction.y - dot * ny;
        let tz = direction.z - dot * nz;
        const length = Math.hypot(tx, ty, tz);

        if (length < 1e-9) {
          return [0, 0, 0];
        }

        tx /= length;
        ty /= length;
        tz /= length;

        if (rimBlend > 0) {
          // Toward whichever way along the lip this side was already heading, so
          // the two shards still part rather than both sliding the same way.
          const side = tx * lipX + tz * lipZ >= 0 ? 1 : -1;

          tx += (side * lipX - tx) * rimBlend;
          ty += (0 - ty) * rimBlend;
          tz += (side * lipZ - tz) * rimBlend;

          const squared = Math.hypot(tx, ty, tz) || 1;

          tx /= squared;
          ty /= squared;
          tz /= squared;
        }

        return [tx * gap, ty * gap, tz * gap];
      };
      const [osx, osy, osz] = project(o.nx, o.ny, o.nz);
      const [isx, isy, isz] = project(inr.nx, inr.ny, inr.nz);

      ox += osx;
      oy += osy;
      oz += osz;
      ix += isx;
      iy += isy;
      iz += isz;
    }

    // Pin junctions (keys start with "j"), the rim row, and pole-adjacent points
    // so smoothing can't round off the crack's real corners or drag the rim.
    const adjacency = keyNeighbors.get(point.key);
    const pin =
      point.key.startsWith("j") ||
      p.s >= 0.999 ||
      (adjacency ? adjacency.has("pole") : false);

    retreatedPos.set(key, {
      ix, iy, iz, ix0: inr.x, iy0: inr.y, iz0: inr.z,
      ox, oy, oz, ox0: o.x, oy0: o.y, oz0: o.z,
      pin, s: p.s,
    });
  };

  for (const segment of wallSegments) {
    addRetreated(segment.ownerA, segment.a);
    addRetreated(segment.ownerA, segment.b);
    addRetreated(segment.ownerB, segment.a);
    addRetreated(segment.ownerB, segment.b);
  }

  // Taubin smoothing (λ shrink then μ inflate) of the retreated positions along
  // each shard's own boundary. Build the adjacency DIRECTLY from retreatedPos
  // keys (two same-owner points joined by a wall segment) so it can never miss:
  // this is the low-pass that removes the per-cell scallop from the shard edge.
  {
    const rpNeighbors = new Map<string, string[]>();
    const linkRp = (a: string, b: string): void => {
      if (!retreatedPos.has(a) || !retreatedPos.has(b)) {
        return;
      }

      const forA = rpNeighbors.get(a);

      if (forA) {
        forA.push(b);
      } else {
        rpNeighbors.set(a, [b]);
      }

      const forB = rpNeighbors.get(b);

      if (forB) {
        forB.push(a);
      } else {
        rpNeighbors.set(b, [a]);
      }
    };

    for (const segment of wallSegments) {
      for (const owner of [segment.ownerA, segment.ownerB]) {
        linkRp(`${owner}|${segment.a.key}`, `${owner}|${segment.b.key}`);
      }
    }

    const applyPass = (factor: number): void => {
      const snapshot = new Map(
        [...retreatedPos].map(([key, value]) => [key, { ...value }] as const),
      );

      for (const [key, rp] of retreatedPos) {
        if (rp.pin) {
          continue;
        }

        const neighbors = rpNeighbors.get(key);

        if (!neighbors || neighbors.length === 0) {
          continue;
        }

        let ox = 0;
        let oy = 0;
        let oz = 0;
        let ix = 0;
        let iy = 0;
        let iz = 0;

        for (const neighborKey of neighbors) {
          const neighbor = snapshot.get(neighborKey)!;

          ox += neighbor.ox;
          oy += neighbor.oy;
          oz += neighbor.oz;
          ix += neighbor.ix;
          iy += neighbor.iy;
          iz += neighbor.iz;
        }

        const count = neighbors.length;
        const base = snapshot.get(key)!;

        rp.ox = base.ox + factor * (ox / count - base.ox);
        rp.oy = base.oy + factor * (oy / count - base.oy);
        rp.oz = base.oz + factor * (oz / count - base.oz);
        rp.ix = base.ix + factor * (ix / count - base.ix);
        rp.iy = base.iy + factor * (iy / count - base.iy);
        rp.iz = base.iz + factor * (iz / count - base.iz);
      }
    };

    for (let pass = 0; pass < 14; pass += 1) {
      applyPass(0.62);
      applyPass(-0.66);
    }
  }

  // Interior-ring easing: the cure for the wide-crack shard-edge staircase.
  // Retreating a boundary vertex inward by the (wide) gap can pull it further in
  // than the nearest rigid interior grid vertex, so that grid vertex then juts
  // out past the smooth edge and BECOMES the silhouette — a grid-resolution
  // stair that scales with crack width and disappears at gap 0 (which is exactly
  // what we saw). Smoothing the boundary can't fix it because the boundary isn't
  // the outermost geometry there. So we diffuse each boundary point's retreat
  // displacement into the first few interior rings with a per-ring decay: the
  // near-crack band of the shard slides inward as one smooth sheet, no interior
  // vertex overtakes the edge, and the silhouette stays the smoothed boundary.
  type InteriorDisp = {
    dox: number; doy: number; doz: number;
    dix: number; diy: number; diz: number;
  };
  const interiorDisp = new Map<string, InteriorDisp>();
  {
    // Same-owner vertex adjacency straight from the emitted skin polygons, so
    // interior grid vertices are linked to the boundary crossings they share a
    // cell with (walls only touch boundary points, so they need no easing).
    const adjacency = new Map<string, Set<string>>();
    const linkAdjacency = (a: string, b: string): void => {
      if (a === b) {
        return;
      }

      const forA = adjacency.get(a) ?? new Set<string>();
      const forB = adjacency.get(b) ?? new Set<string>();

      forA.add(b);
      forB.add(a);
      adjacency.set(a, forA);
      adjacency.set(b, forB);
    };

    for (const { owner, polygon } of pendingPolygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index] as { key?: string };
        const b = polygon[(index + 1) % polygon.length] as { key?: string };

        if (a.key !== undefined && b.key !== undefined) {
          linkAdjacency(`${owner}|${a.key}`, `${owner}|${b.key}`);
        }
      }
    }

    // Ring 0 = boundary, displacement = its full retreat (smoothed - original).
    const disp = new Map<string, InteriorDisp>();
    const ring = new Map<string, number>();
    let frontier: string[] = [];

    for (const [key, rp] of retreatedPos) {
      disp.set(key, {
        dix: rp.ix - rp.ix0, diy: rp.iy - rp.iy0, diz: rp.iz - rp.iz0,
        dox: rp.ox - rp.ox0, doy: rp.oy - rp.oy0, doz: rp.oz - rp.oz0,
      });
      ring.set(key, 0);
      frontier.push(key);
    }

    // A few rings of decay carry the retreat far enough that the widest junction
    // gap can't outrun the eased band, then fade to zero deeper in the shard.
    const rings = 4;
    const decay = 0.6;

    for (let r = 1; r <= rings; r += 1) {
      const next: string[] = [];

      for (const key of frontier) {
        const neighbors = adjacency.get(key);

        if (!neighbors) {
          continue;
        }

        for (const nk of neighbors) {
          if (ring.has(nk)) {
            continue;
          }

          // Average the already-assigned (closer-ring) neighbors, then decay.
          const nn = adjacency.get(nk)!;
          let dox = 0, doy = 0, doz = 0, dix = 0, diy = 0, diz = 0, count = 0;

          for (const m of nn) {
            const rm = ring.get(m);

            if (rm === undefined || rm >= r) {
              continue;
            }

            const dm = disp.get(m)!;

            dox += dm.dox; doy += dm.doy; doz += dm.doz;
            dix += dm.dix; diy += dm.diy; diz += dm.diz;
            count += 1;
          }

          if (count === 0) {
            continue;
          }

          disp.set(nk, {
            dix: (dix / count) * decay, diy: (diy / count) * decay, diz: (diz / count) * decay,
            dox: (dox / count) * decay, doy: (doy / count) * decay, doz: (doz / count) * decay,
          });
          ring.set(nk, r);
          next.push(nk);
        }
      }

      frontier = next;
    }

    // Publish only the INTERIOR rings; ring 0 is the boundary, already placed by
    // retreatedOuter/Inner.
    for (const [key, r] of ring) {
      if (r > 0) {
        interiorDisp.set(key, disp.get(key)!);
      }
    }

    // ---- Corner-preserving clamp ---------------------------------------------
    // Easing slides the near-crack band inward, but where the gap outruns the
    // grid a ring-1 interior vertex can still sit PROUD of the retreated
    // boundary — poking toward the crack past the smoothed edge and becoming the
    // silhouette itself (the residual staircase tooth). Snap any such vertex
    // back onto the local boundary's tangent plane. Only interior vertices move,
    // and only ever INWARD onto the edge (never past it), so the boundary
    // silhouette and its pinned sharp corners are untouched: the clamp removes a
    // protrusion, it can never round the edge. Corners are pinned junctions
    // whose retreat is ~0, so their zero-length normal skips them entirely — the
    // clamp can't pull a corner in.

    // Original (pre-displacement) surface position of each near-crack interior
    // vertex (ring > 0 only, so this stays a thin band, not the whole skin).
    const vertexOrig = new Map<
      string,
      { ox: number; oy: number; oz: number; ix: number; iy: number; iz: number }
    >();

    for (const { owner, polygon } of pendingPolygons) {
      for (const point of polygon) {
        const kp = point as KeyedPoint;

        if (kp.key === undefined) {
          continue;
        }

        const key = `${owner}|${kp.key}`;
        const rr = ring.get(key);

        if (rr === undefined || rr === 0 || vertexOrig.has(key)) {
          continue;
        }

        const p = paramOf(point);
        const o = surfaces.outerAt(p.theta, p.s);
        const inr = surfaces.innerAt(p.theta, p.s);

        vertexOrig.set(key, {
          ix: inr.x, iy: inr.y, iz: inr.z,
          ox: o.x, oy: o.y, oz: o.z,
        });
      }
    }

    // A few relaxation passes so a vertex constrained by two boundary edges near
    // a corner settles behind BOTH; each pass only ever pushes inward, so it
    // converges monotonically. Cheap — only proud ring-1 vertices ever move.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [key, r] of ring) {
        if (r === 0) {
          continue; // boundary vertices ARE the silhouette; never move them
        }

        const orig = vertexOrig.get(key);
        const neighbors = adjacency.get(key);

        if (!orig || !neighbors) {
          continue;
        }

        const d = interiorDisp.get(key);
        const dox = d ? d.dox : 0;
        const doy = d ? d.doy : 0;
        const doz = d ? d.doz : 0;
        const dix = d ? d.dix : 0;
        const diy = d ? d.diy : 0;
        const diz = d ? d.diz : 0;

        // Current (eased + already-clamped) position of this interior vertex.
        const cox = orig.ox + dox;
        const coy = orig.oy + doy;
        const coz = orig.oz + doz;
        const cix = orig.ix + dix;
        const ciy = orig.iy + diy;
        const ciz = orig.iz + diz;

        let bestPenO = 0;
        let pushOx = 0;
        let pushOy = 0;
        let pushOz = 0;
        let bestPenI = 0;
        let pushIx = 0;
        let pushIy = 0;
        let pushIz = 0;

        for (const nk of neighbors) {
          if (ring.get(nk) !== 0) {
            continue; // only boundary neighbors define the silhouette edge
          }

          const rp = retreatedPos.get(nk);

          if (!rp) {
            continue;
          }

          // Inward unit normal = the boundary vertex's net retreat (smoothed
          // pos - original). ~0 at pinned corners, so their branch is skipped
          // and the corner is never pulled in.
          const orx = rp.ox - rp.ox0;
          const ory = rp.oy - rp.oy0;
          const orz = rp.oz - rp.oz0;
          const olen = Math.hypot(orx, ory, orz);

          if (olen > 1e-6) {
            const nx = orx / olen;
            const ny = ory / olen;
            const nz = orz / olen;
            // Positive => the vertex sits on the CRACK side of the boundary
            // plane (proud) by this many world units.
            const pen = (rp.ox - cox) * nx + (rp.oy - coy) * ny + (rp.oz - coz) * nz;

            if (pen > bestPenO) {
              bestPenO = pen;
              pushOx = nx * pen;
              pushOy = ny * pen;
              pushOz = nz * pen;
            }
          }

          const irx = rp.ix - rp.ix0;
          const iry = rp.iy - rp.iy0;
          const irz = rp.iz - rp.iz0;
          const ilen = Math.hypot(irx, iry, irz);

          if (ilen > 1e-6) {
            const nx = irx / ilen;
            const ny = iry / ilen;
            const nz = irz / ilen;
            const pen = (rp.ix - cix) * nx + (rp.iy - ciy) * ny + (rp.iz - ciz) * nz;

            if (pen > bestPenI) {
              bestPenI = pen;
              pushIx = nx * pen;
              pushIy = ny * pen;
              pushIz = nz * pen;
            }
          }
        }

        if (bestPenO <= 0 && bestPenI <= 0) {
          continue;
        }

        interiorDisp.set(key, {
          dix: dix + pushIx, diy: diy + pushIy, diz: diz + pushIz,
          dox: dox + pushOx, doy: doy + pushOy, doz: doz + pushOz,
        });
      }
    }
  }

  const retreatedOuter = (
    owner: number,
    point: { key?: string },
    fallback: SurfaceSample,
  ): SurfaceSample => {
    const rp = point.key === undefined ? undefined : retreatedPos.get(`${owner}|${point.key}`);

    return rp ? { ...fallback, x: rp.ox, y: rp.oy, z: rp.oz } : fallback;
  };
  const retreatedInner = (
    owner: number,
    point: { key?: string },
    fallback: SurfaceSample,
  ): SurfaceSample => {
    const rp = point.key === undefined ? undefined : retreatedPos.get(`${owner}|${point.key}`);

    return rp ? { ...fallback, x: rp.ix, y: rp.iy, z: rp.iz } : fallback;
  };

  // Flush the queued skin polygons with consistent boundary retreat.
  for (const { owner, polygon } of pendingPolygons) {
    const builder = builderFor(owner);
    const outer = polygon.map((point) => {
      const p = paramOf(point);

      return surfaces.outerAt(p.theta, p.s);
    });
    const inner = polygon.map((point) => {
      const p = paramOf(point);

      return surfaces.innerAt(p.theta, p.s);
    });

    polygon.forEach((point, index) => {
      const keyed = point as KeyedPoint;

      if ("boundary" in point && point.boundary) {
        // Read the shared, Taubin-smoothed retreated position (same one the wall
        // uses) so the skin edge is smooth and watertight with the crack wall.
        outer[index] = retreatedOuter(owner, keyed, outer[index]);
        inner[index] = retreatedInner(owner, keyed, inner[index]);

        return;
      }

      // Interior vertex: slide it along the eased retreat band so it can't jut
      // past the retreated edge and staircase the silhouette. Zero for vertices
      // deeper than the band.
      const d = keyed.key === undefined
        ? undefined
        : interiorDisp.get(`${owner}|${keyed.key}`);

      if (d) {
        outer[index] = {
          ...outer[index],
          x: outer[index].x + d.dox,
          y: outer[index].y + d.doy,
          z: outer[index].z + d.doz,
        };
        inner[index] = {
          ...inner[index],
          x: inner[index].x + d.dix,
          y: inner[index].y + d.diy,
          z: inner[index].z + d.diz,
        };
      }
    });

    for (let index = 1; index < polygon.length - 1; index += 1) {
      pushTriangle(builder.glazePositions, builder.glazeNormals, outer[0], outer[index], outer[index + 1]);
      pushTriangle(builder.glazePositions, builder.glazeNormals, inner[0], inner[index + 1], inner[index]);
    }

    trackCentroid(builder, outer);
  }

  // Pass 2: emit both crack faces of every wall quad, shifted apart along the
  // smoothed per-point normals.
  wallSegments.forEach((segment, index) => {
    const fallback = segmentNormals[index];
    const normalAt = (pointKey: string): { x: number; y: number; z: number } => {
      const sum = wallNormalSums.get(pairPointKey(segment, pointKey)) ?? fallback;
      const length = Math.hypot(sum.x, sum.y, sum.z);

      return length < 1e-9
        ? fallback
        : { x: sum.x / length, y: sum.y / length, z: sum.z / length };
    };
    const normalA = normalAt(segment.a.key);
    const normalB = normalAt(segment.b.key);
    const pa = paramOf(segment.a);
    const pb = paramOf(segment.b);
    const outerA = surfaces.outerAt(pa.theta, pa.s);
    const outerB = surfaces.outerAt(pb.theta, pb.s);
    const innerA = surfaces.innerAt(pa.theta, pa.s);
    const innerB = surfaces.innerAt(pb.theta, pb.s);
    const lowOwner = Math.min(segment.ownerA, segment.ownerB);

    for (const owner of [segment.ownerA, segment.ownerB]) {
      const facing = owner === lowOwner ? 1 : -1;
      const builder = builderFor(owner);
      // Position from the shared, smoothed retreated map (identical to the skin
      // edge); shading normal is the crack-face normal so the wall shades right.
      const shade = (
        pos: SurfaceSample,
        normal: { x: number; y: number; z: number },
      ): SurfaceSample => ({
        nx: facing * normal.x,
        ny: facing * normal.y,
        nz: facing * normal.z,
        x: pos.x,
        y: pos.y,
        z: pos.z,
      });
      const wallA = shade(retreatedOuter(owner, segment.a, outerA), normalA);
      const wallB = shade(retreatedOuter(owner, segment.b, outerB), normalB);
      const wallC = shade(retreatedInner(owner, segment.b, innerB), normalB);
      const wallD = shade(retreatedInner(owner, segment.a, innerA), normalA);

      // Wind the quad to front-face along its vertex normals; DoubleSide
      // rendering flips shading normals on back-facing triangles, so mixed
      // winding would stripe the wall light/dark.
      const e1x = wallB.x - wallA.x;
      const e1y = wallB.y - wallA.y;
      const e1z = wallB.z - wallA.z;
      const e2x = wallC.x - wallA.x;
      const e2y = wallC.y - wallA.y;
      const e2z = wallC.z - wallA.z;
      const windingDot =
        (e1y * e2z - e1z * e2y) * wallA.nx +
        (e1z * e2x - e1x * e2z) * wallA.ny +
        (e1x * e2y - e1y * e2x) * wallA.nz;

      if (windingDot >= 0) {
        pushTriangle(builder.bisquePositions, builder.bisqueNormals, wallA, wallB, wallC);
        pushTriangle(builder.bisquePositions, builder.bisqueNormals, wallA, wallC, wallD);
      } else {
        pushTriangle(builder.bisquePositions, builder.bisqueNormals, wallA, wallC, wallB);
        pushTriangle(builder.bisquePositions, builder.bisqueNormals, wallA, wallD, wallC);
      }
    }
  });

  const seamPaths = chainSeamSegments(segments);

  // Shards with deterministic scatter poses.
  const shardRandom = createSeededRandom(settings.seed * 104729 + 13);
  const shards: ShardSource[] = [];
  const sortedCellIds = [...builders.keys()].sort((left, right) => left - right);

  for (const cellId of sortedCellIds) {
    const builder = builders.get(cellId);

    if (!builder || builder.glazePositions.length === 0) {
      continue;
    }

    const sampleCount = Math.max(1, builder.positionSampleCount);
    const centroidX = builder.positionSumX / sampleCount;
    const centroidY = builder.positionSumY / sampleCount;
    const centroidZ = builder.positionSumZ / sampleCount;
    const radial = Math.hypot(centroidX, centroidZ);
    const hasRadial = radial > 0.08;
    const randomAngle = shardRandom() * Math.PI * 2;
    const dirX = hasRadial ? centroidX / radial : Math.cos(randomAngle);
    const dirZ = hasRadial ? centroidZ / radial : Math.sin(randomAngle);
    const axisAngle = shardRandom() * Math.PI * 2;
    const axisPitch = (shardRandom() - 0.5) * Math.PI;

    shards.push({
      bisqueNormals: builder.bisqueNormals,
      bisquePositions: builder.bisquePositions,
      centroidX,
      centroidY,
      centroidZ,
      glazeNormals: builder.glazeNormals,
      glazePositions: builder.glazePositions,
      id: cellId,
      scatter: {
        angleRad: 0.12 + shardRandom() * 0.5,
        axisX: Math.cos(axisAngle) * Math.cos(axisPitch),
        axisY: Math.sin(axisPitch),
        axisZ: Math.sin(axisAngle) * Math.cos(axisPitch),
        delaySeconds: shardRandom() * 0.16,
        offsetX: dirX * (0.55 + 0.45 * shardRandom()),
        offsetY: (shardRandom() - 0.5) * 0.26 - 0.12,
        offsetZ: dirZ * (0.55 + 0.45 * shardRandom()),
      },
    });
  }

  return { seamPaths, shardCount: shards.length, shards, widthModel };
}

function chainSeamSegments(segments: readonly SeamSegment[]): SeamParamPath[] {
  const adjacency = new Map<string, number[]>();
  const degree = new Map<string, number>();
  const visited = new Array<boolean>(segments.length).fill(false);

  segments.forEach((segment, index) => {
    for (const key of [segment.aKey, segment.bKey]) {
      const list = adjacency.get(key);

      if (list) {
        list.push(index);
      } else {
        adjacency.set(key, [index]);
      }

      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  });

  const takeUnvisitedEdge = (key: string): number | null => {
    const list = adjacency.get(key);

    if (!list) {
      return null;
    }

    while (list.length > 0) {
      const candidate = list[list.length - 1];

      if (visited[candidate]) {
        list.pop();
        continue;
      }

      return candidate;
    }

    return null;
  };

  const paths: SeamParamPath[] = [];

  const endpointKind = (key: string, point: ParamPoint): SeamEndpointKind => {
    // The bowl's center is always a junction, never a dying tip — even in the
    // rare cut where only two cracks reach it. A "tip" there would taper the
    // gold to 0.3x width exactly where the runs meet and reopen the hole.
    if (key === "pole" || (degree.get(key) ?? 0) >= 3) {
      return "junction";
    }

    return point.s >= 0.985 ? "rim" : "tip";
  };

  const toParamPath = (
    vertices: ReadonlyArray<{ key: string; point: ParamPoint }>,
    closed: boolean,
  ): void => {
    if (vertices.length < 2) {
      return;
    }

    const points: SeamParamPoint[] = [];
    let previousTheta = vertices[0].point.theta;

    for (const vertex of vertices) {
      let theta = vertex.point.theta;

      while (theta - previousTheta > Math.PI) {
        theta -= Math.PI * 2;
      }

      while (previousTheta - theta > Math.PI) {
        theta += Math.PI * 2;
      }

      points.push({ s: vertex.point.s, theta });
      previousTheta = theta;
    }

    const first = vertices[0];
    const last = vertices[vertices.length - 1];

    paths.push({
      closed,
      endKind: closed ? "tip" : endpointKind(last.key, last.point),
      points,
      startKind: closed ? "tip" : endpointKind(first.key, first.point),
    });
  };

  // Walk one chain from startKey through its next unvisited edge, stopping at
  // any junction (degree != 2) so separate cracks never merge into one
  // meandering path.
  const walkFrom = (startKey: string): void => {
    const firstEdgeIndex = takeUnvisitedEdge(startKey);

    if (firstEdgeIndex === null) {
      return;
    }

    visited[firstEdgeIndex] = true;

    const firstEdge = segments[firstEdgeIndex];
    const startsAtA = firstEdge.aKey === startKey;
    const startVertex = startsAtA
      ? { key: firstEdge.aKey, point: firstEdge.a }
      : { key: firstEdge.bKey, point: firstEdge.b };
    let currentVertex = startsAtA
      ? { key: firstEdge.bKey, point: firstEdge.b }
      : { key: firstEdge.aKey, point: firstEdge.a };
    const vertices = [startVertex, currentVertex];

    for (;;) {
      if (currentVertex.key === startKey || (degree.get(currentVertex.key) ?? 0) !== 2) {
        break;
      }

      const nextEdgeIndex = takeUnvisitedEdge(currentVertex.key);

      if (nextEdgeIndex === null) {
        break;
      }

      visited[nextEdgeIndex] = true;

      const edge = segments[nextEdgeIndex];
      currentVertex =
        edge.aKey === currentVertex.key
          ? { key: edge.bKey, point: edge.b }
          : { key: edge.aKey, point: edge.a };
      vertices.push(currentVertex);
    }

    toParamPath(vertices, currentVertex.key === startKey && vertices.length > 3);
  };

  const hasUnvisitedEdge = (key: string): boolean => {
    const list = adjacency.get(key);

    if (!list) {
      return false;
    }

    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (!visited[list[index]]) {
        return true;
      }
    }

    return false;
  };

  // Chains between junctions and open ends first.
  for (const [key, keyDegree] of degree) {
    if (keyDegree === 2) {
      continue;
    }

    while (hasUnvisitedEdge(key)) {
      walkFrom(key);
    }
  }

  // Remaining edges form pure loops.
  segments.forEach((segment, index) => {
    if (!visited[index]) {
      walkFrom(segment.aKey);
    }
  });

  return paths;
}
