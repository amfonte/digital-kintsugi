export type SurfaceSample = {
  nx: number;
  ny: number;
  nz: number;
  x: number;
  y: number;
  z: number;
};

export type Point3 = { x: number; y: number; z: number };

export type VesselSurfaces = {
  innerAt: (theta: number, s: number) => SurfaceSample;
  // Fast sample: wobbled position + analytic (ideal-arc) normal, skipping the
  // finite-difference normal. Enough to orient a decal whose own shading normal
  // is derived elsewhere; used by the gold field for its displacement direction.
  innerFast: (theta: number, s: number) => SurfaceSample;
  // Position-only accessors (no normal at all), for the many cheap distance
  // samples the gold field takes before it ever needs a normal.
  innerPoint: (theta: number, s: number) => Point3;
  midpointAt: (theta: number, s: number) => Point3;
  outerAt: (theta: number, s: number) => SurfaceSample;
  outerFast: (theta: number, s: number) => SurfaceSample;
  outerPoint: (theta: number, s: number) => Point3;
  rimAt: (theta: number, t: number) => SurfaceSample;
  rimPoint: (theta: number, t: number) => Point3;
};

// Analytic bowl silhouette: both skins are vertically scaled circular arcs in
// the r/y half-plane, so curvature and normals stay perfectly smooth (a
// sampled spline showed visible terracing under a glossy glaze). s runs 0
// (bottom center) -> 1 (rim) on both skins so a fracture cell computed in
// (theta, s) space stays aligned through the wall thickness.
type ArcProfile = {
  arcRadius: number;
  baseY: number;
  maxPhi: number;
  minPhi: number;
  verticalScale: number;
  // Outer skin only: carve a foot ring into the flat base so the bowl rests on a
  // rim with the center recessed, like real pottery.
  foot: boolean;
  // Domed-base cap constants, precomputed. These depend only on the profile, but
  // used to be derived (three trig calls) inside every base sample — and the base
  // is the single hottest region of a rebuild, since the fracture grid clusters
  // its meridian rings toward the pole and the gold field splats a full ring of
  // columns per row down there.
  baseEdgeRadius: number; // rBase: radius where the cap meets the wall
  baseEdgeY: number; // yBase: height there
  baseDomeDrop: number; // parabola depth that meets the wall tangentially
};

const rimHeight = 0.74;
const outerRimRadius = 1.0;
const innerRimRadius = 0.952;
const innerBottomY = 0.085;

// Handmade-wobble: a wheel-thrown bowl is never truly round, and its rim drifts
// off a perfect circle. A few low angular harmonics push the silhouette off-round
// and give the rim a gentle rise/fall. Every term is periodic in theta so the
// theta = 2*PI seam stays continuous, and the whole field is deterministic so the
// live preview and export renderers agree frame to frame. Amplitudes are a small
// fraction of the ~1.0 rim radius: enough to break the mirror-blob reflections
// that make a flawless surface read as metal, without looking dented.
const wobbleHarmonics = [
  { k: 2, phase: 0.72, radial: 0.017, vertical: 0.0 }, // ovality (dominant)
  { k: 3, phase: 2.14, radial: 0.006, vertical: 0.011 }, // tri-lobe lean + rim rise
  { k: 5, phase: 4.41, radial: 0.0034, vertical: 0.006 },
  { k: 7, phase: 1.19, radial: 0.0017, vertical: 0.0038 },
];

// The base and lower wall get no wobble at all, so the foot the bowl rests on
// stays precise and round; the wobble ramps in above the base and reaches full
// strength at the rim, where a thrown piece actually drifts. smoothstep is a
// hoisted function declaration below, so it is safe to call here.
function wobbleWeight(s: number): number {
  return smoothstep(wobbleRampStart, 1, s);
}

// Both wobbles bail out where the ramp is fully off. Below wobbleRampStart the
// weight is exactly 0, so the harmonic sum is multiplied away — but it was still
// being evaluated, eight sines per position sample across the entire base and
// lower wall. That is the hottest region of the whole rebuild: the fracture grid
// clusters its meridian rings toward the pole, and the gold field splats a full
// ring of columns per row down there, so these samples run into the hundreds of
// thousands.
function radialWobble(theta: number, s: number): number {
  const weight = wobbleWeight(s);

  if (weight <= 0) {
    return 0;
  }

  let sum = 0;

  for (const harmonic of wobbleHarmonics) {
    sum += harmonic.radial * Math.sin(harmonic.k * theta + harmonic.phase);
  }

  return sum * weight;
}

function verticalWobble(theta: number, s: number): number {
  const weight = wobbleWeight(s);

  if (weight <= 0) {
    return 0;
  }

  let sum = 0;

  for (const harmonic of wobbleHarmonics) {
    sum += harmonic.vertical * Math.sin(harmonic.k * theta + harmonic.phase * 1.31);
  }

  return sum * weight;
}

// Below this meridian parameter the bottom is a shallow flat base disc (a real
// disc with finite ring radii and uniform up-normals) instead of a degenerate
// near-zero-radius pole — which is what produced the white-dot artifact and the
// UV singularity at the exact center.
const flatBaseS = 0.18;

// The wobble stays fully off through the flat base and the first bit of wall,
// then ramps up to full strength at the rim. Keeping the start above flatBaseS
// leaves the base disc and the base->wall corner crisp instead of rippled.
const wobbleRampStart = 0.26;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

function createArcProfile(
  arcRadius: number,
  rimRadius: number,
  baseY: number,
  foot: boolean,
): ArcProfile {
  const maxPhi = Math.asin(rimRadius / arcRadius);
  const verticalScale = (rimHeight - baseY) / (arcRadius * (1 - Math.cos(maxPhi)));
  const minPhi = 0.004;
  const phiB = minPhi + (maxPhi - minPhi) * flatBaseS;
  const baseEdgeRadius = arcRadius * Math.sin(phiB);
  const baseEdgeY = baseY + verticalScale * arcRadius * (1 - Math.cos(phiB));
  // Wall slope dy/dr at the base edge = verticalScale * tan(phiB); a parabola
  // y = yBase - domeDrop * (1 - t^2) has dy/dr = 2*domeDrop/rBase at t = 1, so
  // domeDrop = 0.5 * edgeSlope * rBase makes the cap meet the wall tangentially.
  const baseDomeDrop = 0.5 * (verticalScale * Math.tan(phiB)) * baseEdgeRadius;

  return {
    arcRadius,
    baseDomeDrop,
    baseEdgeRadius,
    baseEdgeY,
    baseY,
    foot,
    maxPhi,
    minPhi,
    verticalScale,
  };
}

const outerProfile = createArcProfile(1.04, outerRimRadius, 0, true);
const innerProfile = createArcProfile(1.02, innerRimRadius, innerBottomY, false);

// Flat-base radius (shared by both skins' unwrap seam). Derived from the inner
// arc at flatBaseS so the UV cap matches the geometry.
export const vesselBaseRadius = innerProfile.baseEdgeRadius;

// Displaced (r, y) for a profile at (theta, s): the analytic arc plus the
// handmade wobble. Kept separate from normal computation so normals can be
// derived numerically from finite differences of exactly this position.
function displacedRadiusHeight(
  profile: ArcProfile,
  theta: number,
  s: number,
): { r: number; y: number } {
  const clamped = Math.min(1, Math.max(0, s));

  // Wall: the analytic arc plus the handmade wobble.
  if (clamped >= flatBaseS) {
    const phi = profile.minPhi + (profile.maxPhi - profile.minPhi) * clamped;
    const r = profile.arcRadius * Math.sin(phi) + radialWobble(theta, clamped);
    const y =
      profile.baseY +
      profile.verticalScale * profile.arcRadius * (1 - Math.cos(phi)) +
      verticalWobble(theta, clamped);

    return { r, y };
  }

  // Shallow domed base: radius runs 0 -> rBase, but the height is a gentle
  // spherical-ish cap rather than a perfectly flat disc. A flat disc gives the
  // whole base a single up-normal, so it lights and reflects as one uniform
  // patch that reads as a pasted-on dot against the curved wall. The cap curves
  // the normal continuously from straight-up at the pole to the wall's slope at
  // the base edge, so the bottom shades like the rest of the bowl. The parabola
  // is C1-matched to the wall: same height and same dy/dr at t = 1, and zero
  // slope at t = 0 so the pole normal stays clean. Radius still runs to a finite
  // rBase (no degenerate pole), and the exact center normal is capped in
  // profileSample.
  const rBase = profile.baseEdgeRadius;
  const t = clamped / flatBaseS; // 0 center -> 1 base edge
  const r = (rBase + radialWobble(theta, clamped)) * t;
  let y =
    profile.baseEdgeY -
    profile.baseDomeDrop * (1 - t * t) +
    verticalWobble(theta, clamped) * t;

  if (profile.foot) {
    // Exterior foot ring: a shallow rim near the base edge that the bowl rests on
    // (dips below the base), with the very center recessed slightly upward.
    const ring = Math.exp(-((t - 0.82) ** 2) / (2 * 0.09 ** 2));

    y -= 0.03 * ring;
    y += 0.02 * (1 - smoothstep(0, 0.62, t));
  }

  return { r, y };
}

function positionAt(
  profile: ArcProfile,
  theta: number,
  s: number,
): { x: number; y: number; z: number } {
  const { r, y } = displacedRadiusHeight(profile, theta, s);

  return { x: r * Math.cos(theta), y, z: r * Math.sin(theta) };
}

// Analytic normal of the undisplaced arc, used only to orient the numerically
// derived normal into the correct hemisphere (outer = outward, inner = inward).
function referenceNormal(
  profile: ArcProfile,
  theta: number,
  s: number,
  normalSign: 1 | -1,
): { x: number; y: number; z: number } {
  const clamped = Math.min(1, Math.max(0, s));
  const phi = profile.minPhi + (profile.maxPhi - profile.minPhi) * clamped;
  const tr = Math.cos(phi);
  const ty = profile.verticalScale * Math.sin(phi);
  const tangentLength = Math.hypot(tr, ty) || 1;
  const nr = (ty / tangentLength) * normalSign;
  const ny = (-tr / tangentLength) * normalSign;

  return { x: nr * Math.cos(theta), y: ny, z: nr * Math.sin(theta) };
}

function profileSample(
  profile: ArcProfile,
  theta: number,
  s: number,
  normalSign: 1 | -1,
): SurfaceSample {
  const clamped = Math.min(1, Math.max(0, s));
  const point = positionAt(profile, theta, clamped);

  // Surface tangents from central differences of the displaced position, so the
  // shading normal follows the wobble instead of the ideal arc. Clamp the s
  // samples to the valid band; theta is periodic so it never needs clamping.
  const dTheta = 1e-3;
  const dS = 1e-3;
  const sLow = Math.max(0, clamped - dS);
  const sHigh = Math.min(1, clamped + dS);

  const pThetaPlus = positionAt(profile, theta + dTheta, clamped);
  const pThetaMinus = positionAt(profile, theta - dTheta, clamped);
  const pSHigh = positionAt(profile, theta, sHigh);
  const pSLow = positionAt(profile, theta, sLow);

  const tThetaX = pThetaPlus.x - pThetaMinus.x;
  const tThetaY = pThetaPlus.y - pThetaMinus.y;
  const tThetaZ = pThetaPlus.z - pThetaMinus.z;
  const tSX = pSHigh.x - pSLow.x;
  const tSY = pSHigh.y - pSLow.y;
  const tSZ = pSHigh.z - pSLow.z;

  let nx = tSY * tThetaZ - tSZ * tThetaY;
  let ny = tSZ * tThetaX - tSX * tThetaZ;
  let nz = tSX * tThetaY - tSY * tThetaX;
  const length = Math.hypot(nx, ny, nz);

  // Analytic arc normal — used to orient the numeric normal below, and as a
  // direct fallback at the pole. At s = 0 every theta collapses to the same
  // axis point, so the theta-tangent vanishes and the cross product is zero;
  // without this the pole vertices get a (0,0,0) normal and shade pure black
  // (the dark dot at the bowl center). The reference normal points cleanly
  // along the axis there, so use it whenever the finite-difference normal is
  // degenerate.
  const reference = referenceNormal(profile, theta, clamped, normalSign);
  if (length < 1e-8) {
    return { nx: reference.x, ny: reference.y, nz: reference.z, x: point.x, y: point.y, z: point.z };
  }

  nx /= length;
  ny /= length;
  nz /= length;

  // Orient into the same hemisphere as the ideal arc normal so inner and outer
  // skins keep pointing the right way regardless of the cross-product winding.
  if (nx * reference.x + ny * reference.y + nz * reference.z < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  return { nx, ny, nz, x: point.x, y: point.y, z: point.z };
}

export function createVesselSurfaces(): VesselSurfaces {
  const outerAt = (theta: number, s: number): SurfaceSample =>
    profileSample(outerProfile, theta, s, 1);

  const innerAt = (theta: number, s: number): SurfaceSample =>
    profileSample(innerProfile, theta, s, -1);

  const midpointAt = (theta: number, s: number): { x: number; y: number; z: number } => {
    const outer = outerAt(theta, s);
    const inner = innerAt(theta, s);

    return {
      x: (outer.x + inner.x) / 2,
      y: (outer.y + inner.y) / 2,
      z: (outer.z + inner.z) / 2,
    };
  };

  const outerPoint = (theta: number, s: number): { x: number; y: number; z: number } =>
    positionAt(outerProfile, theta, Math.min(1, Math.max(0, s)));
  const innerPoint = (theta: number, s: number): { x: number; y: number; z: number } =>
    positionAt(innerProfile, theta, Math.min(1, Math.max(0, s)));

  const fastSample = (
    profile: ArcProfile,
    theta: number,
    s: number,
    normalSign: 1 | -1,
  ): SurfaceSample => {
    const clamped = Math.min(1, Math.max(0, s));
    const point = positionAt(profile, theta, clamped);
    const normal = referenceNormal(profile, theta, clamped, normalSign);

    return { nx: normal.x, ny: normal.y, nz: normal.z, x: point.x, y: point.y, z: point.z };
  };

  const outerFast = (theta: number, s: number): SurfaceSample =>
    fastSample(outerProfile, theta, s, 1);
  const innerFast = (theta: number, s: number): SurfaceSample =>
    fastSample(innerProfile, theta, s, -1);

  // Rounded lip joining the two skins at s = 1; t runs 0 (outer edge) -> 1
  // (inner edge). The endpoints ride the displaced skins, so the rim inherits
  // the same off-round wobble.
  //
  // This used to be a straight chord across the wall plus a sin(pi*t) rise. The
  // positions matched the skins exactly at both edges, but the SLOPES did not:
  // the surface normal jumped 16 deg at the outer edge and 21 deg at the inner
  // one, so the lip met each face at a crease. Rough ceramic hides that; the
  // gold seam is a mirror, and a crack crossing the rim showed a hard
  // brightness step exactly where the lip strip butts against each face — the
  // vein and the lip read as separate slabs lapped over each other rather than
  // one ribbon carried over the rim. A cubic Hermite whose end tangents are the
  // skins' own +s directions (outer: still climbing; inner: now descending into
  // the bowl) removes the crease. Tangent magnitude = the wall thickness, which
  // puts the crest at ~0.011 — near enough to the 0.014 rise it replaces that
  // the silhouette is unchanged.
  const rimCurve = (
    theta: number,
    t: number,
  ): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } => {
    const p0 = positionAt(outerProfile, theta, 1);
    const p1 = positionAt(innerProfile, theta, 1);
    const step = 4e-3;
    const q0 = positionAt(outerProfile, theta, 1 - step);
    const q1 = positionAt(innerProfile, theta, 1 - step);
    const span = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) || 1e-6;
    const l0 = Math.hypot(p0.x - q0.x, p0.y - q0.y, p0.z - q0.z) || 1e-6;
    const l1 = Math.hypot(p1.x - q1.x, p1.y - q1.y, p1.z - q1.z) || 1e-6;
    const m0x = ((p0.x - q0.x) / l0) * span;
    const m0y = ((p0.y - q0.y) / l0) * span;
    const m0z = ((p0.z - q0.z) / l0) * span;
    const m1x = ((q1.x - p1.x) / l1) * span;
    const m1y = ((q1.y - p1.y) / l1) * span;
    const m1z = ((q1.z - p1.z) / l1) * span;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const d00 = 6 * t2 - 6 * t;
    const d10 = 3 * t2 - 4 * t + 1;
    const d01 = -6 * t2 + 6 * t;
    const d11 = 3 * t2 - 2 * t;

    return {
      px: h00 * p0.x + h10 * m0x + h01 * p1.x + h11 * m1x,
      py: h00 * p0.y + h10 * m0y + h01 * p1.y + h11 * m1y,
      pz: h00 * p0.z + h10 * m0z + h01 * p1.z + h11 * m1z,
      tx: d00 * p0.x + d10 * m0x + d01 * p1.x + d11 * m1x,
      ty: d00 * p0.y + d10 * m0y + d01 * p1.y + d11 * m1y,
      tz: d00 * p0.z + d10 * m0z + d01 * p1.z + d11 * m1z,
    };
  };

  const rimPoint = (theta: number, t: number): { x: number; y: number; z: number } => {
    const curve = rimCurve(theta, t);

    return { x: curve.px, y: curve.py, z: curve.pz };
  };

  // Normal = the lip tangent turned a quarter turn in the meridian plane, so it
  // agrees with each skin's own normal at the edges by construction.
  const rimAt = (theta: number, t: number): SurfaceSample => {
    const curve = rimCurve(theta, t);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const tangentR = curve.tx * cos + curve.tz * sin;
    const length = Math.hypot(tangentR, curve.ty) || 1;
    const nr = curve.ty / length;
    const ny = -tangentR / length;

    return {
      nx: nr * cos,
      ny,
      nz: nr * sin,
      x: curve.px,
      y: curve.py,
      z: curve.pz,
    };
  };

  return {
    innerAt,
    innerFast,
    innerPoint,
    midpointAt,
    outerAt,
    outerFast,
    outerPoint,
    rimAt,
    rimPoint,
  };
}
