import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { FractureResult, ImpactPoint, ShardSource } from "./fracture";
import { buildFracture, nearestSurfaceParam } from "./fracture";
import {
  defaultGlazePresetId,
  getGlazePreset,
  type GlazePreset,
} from "./glaze-library";
import { buildSeamGeometry, type SeamGeometrySource } from "./seams";
import {
  addStudioLighting,
  configureKintsugiRenderer,
  createGoldEnvironment,
  createGroundShadowDisc,
  createKintsugiSurfaceTextures,
  createKintsugiWebglContext,
  createStudioEnvironment,
  resolveStudioLighting,
  type KintsugiSurfaceTextures,
  type StudioLights,
} from "./stage";
import { createVesselSurfaces } from "./vessel-profile";

// Which way the vessel is currently moving. "pristine" is the load state: a
// whole, unbroken, gold-free bowl, which is only ever left by striking it.
export type VesselStateValue = "kintsugi" | "pristine" | "shattered";

export type KintsugiSettings = {
  autoRotate: boolean;
  background: string;
  easing: "linear" | "smooth";
  glazePreset: string;
  includeBackground: boolean;
  // Lighting controls, all percentages of the tuned studio rig in stage.ts:
  // 100 means "exactly the dialed-in value", so a reset restores the look.
  lightAmbientDome: number;
  lightExposure: number;
  lightFill: number;
  lightKey: number;
  lightSoftbox: number;
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  seamRelief: number;
  seamWidth: number;
  // Bumped by the Reset action; any change returns the vessel to pristine. It is
  // a counter rather than a state because resetting an already-reset vessel has
  // to stay a no-op while resetting a broken one must always land.
  resetToken: number;
};

export const defaultKintsugiSettings: KintsugiSettings = {
  autoRotate: true,
  background: "#242424",
  easing: "linear",
  glazePreset: defaultGlazePresetId,
  includeBackground: true,
  lightAmbientDome: 70,
  lightExposure: 100,
  lightFill: 100,
  lightKey: 100,
  lightSoftbox: 120,
  rotXDeg: 0,
  rotYDeg: 0,
  rotZDeg: 0,
  // Seam relief/width were exposed as sliders; the values are now baked in at
  // the dialed-in look (UI Relief = 1, Gold = 10) and the controls were removed.
  seamRelief: 1,
  seamWidth: 10,
  resetToken: 0,
};

// The crack layout used to be a "Pattern seed" slider. Where the user strikes
// the bowl now supplies that variety, so the seed is a fixed constant (its old
// default) that keeps the domain warp and rosette jitter deterministic.
const fractureSeed = 21;

// Seeds a strike drops into the fracture. Kept low so a click reads as a break
// with a few convincing pieces rather than confetti — and lower still now that
// strikes overlay instead of replacing each other: because every earlier crack
// survives, one strike's seeds split cells the previous strikes already cut, so
// the shard count climbs faster than the seed count and a smaller batch buys
// more strikes before the 28-shard hard limit.
export const shardsPerStrike = 4;

// Share of a strike's seeds that cluster against a radial crack instead of
// sitting on the rosette ring, forking that crack. Held at its old default: it
// only ever redistributed a fixed seed budget, so exposing it changed which
// cracks appeared but never how many, and at six shards spending more of the
// ring on forks collapses the star into a single line.
export const crackBranching = 35;

// How far the shards fly apart at the top of the shatter beat, as a percentage
// of the 1.7-unit scatter envelope. Baked at the old default: the spread is only
// on screen for the second between the break and the gold.
const shatterSpread = 18;

export type ExportSession = {
  dispose: () => void;
  renderFrame: (
    turntableTimeSeconds: number | null,
    includeBackground: boolean,
  ) => HTMLCanvasElement;
};

// The gold that fills the cracks is the whole point of kintsugi, so its color is
// a fixed material property, not a user setting.
const kintsugiGoldColor = "#D2B04B";

// How a preset's textures are wired onto the baked unwraps: which UV channel to
// read, and the repeat/offset that turns that unwrap's baked tiling into the
// preset's own `tiling`. Riding on repeat is much cheaper than rebaking every
// shard's UV attribute on each glaze switch, and it scales both axes together,
// so it can never introduce stretch that the unwrap did not already have.
type GlazeUvTransform = {
  channel: 0 | 1;
  offsetX: number;
  offsetY: number;
  repeat: number;
};

function glazeUvTransform(preset: GlazePreset): GlazeUvTransform {
  if (preset.unwrap === "cylindrical") {
    // Snapped so the texture still makes a WHOLE number of repeats around the
    // circumference, which is what lets the two sides of the unwrap's branch cut
    // line up (see glazeTilesAround). The snap moves a preset by at most half a
    // repeat in 6 — under 4% — well inside the tolerance of a hand-picked
    // feature size. The unwrap puts v = 0 at the rim, so the pattern stays
    // anchored there under scaling and offsetY is left free: it rolls the whole
    // texture up or down the wall in tiles, which is how a particular band gets
    // parked at a particular height.
    const requested = (preset.tiling ?? glazeReferenceTiling) / glazeReferenceTiling;
    // With the ring cut on, the lower island wraps glazeRingCutRatio times less
    // often than this, so the count has to stay divisible by the ratio as well
    // or that island is the one that fails to close up going around.
    const step = glazeRingCutRadius > 0 ? glazeRingCutRatio : 1;
    const tiles = Math.max(step, step * Math.round((requested * glazeTilesAround) / step));

    return {
      channel: 1,
      offsetX: 0,
      offsetY: preset.unwrapOffset ?? 0,
      repeat: tiles / glazeTilesAround,
    };
  }

  // repeat scales UV space about the origin, which would drag the disc unwrap's
  // center (0.5, 0.5) off the texture center; put it back so a scale change
  // resizes the pattern rather than sliding it.
  const repeat = (preset.tiling ?? glazeDiscScale) / glazeDiscScale;

  return {
    channel: 0,
    offsetX: 0.5 * (1 - repeat),
    offsetY: 0.5 * (1 - repeat),
    repeat,
  };
}

const vesselCenterY = 0.37;
// Hairline floor of the open channel between shards. The gold always covers at
// least this; "generosity" (the Width control) then opens the crack — and the
// gold that fills it — wider along each run and pools it open at junctions, via
// the shared width model, so the gold fills the gap instead of painting over it.
const seamChannelHalf = 0.0055;
// World-units per "Gold" slider unit: the generosity fed to both the fracture
// cutter (gap) and the gold seam builder (fill) so they stay coupled.
const seamScale = 0.006;
const shatterDurationSeconds = 1.15;
const repairDurationSeconds = 0.95;
// Beat the vessel holds at full spread before it gathers itself back together.
const shatterHoldSeconds = 1.0;
// A press only counts as a strike if the pointer barely moved and was not held:
// anything else is an orbit drag, which must never break the bowl.
const clickMaxTravelPx = 5;
const clickMaxDurationMs = 600;
// Sized against the VISIBLE pour, not the raw duration. applySeamReveal pads
// the sweep by a lead bound at each end (~12% apiece) so wander can never break
// the empty-at-0/full-at-1 guarantee, and that padding is time the eye sees
// nothing move. With the curve below the gold is actually travelling from about
// 0.27s to 2.6s, which is the number that has to feel cinematic.
const seamRevealDurationSeconds = 3.4;

// How much of the sweep is scheduled by gold arrival rather than by raw distance
// along the crack network. See computeFrontSchedule. 1 tracks arrival exactly but
// makes the front lurch; 0 is the old constant-rate sweep.
const frontScheduleWarp = 0.85;
const seamHideDurationSeconds = 0.3;
const viewportSuspendMs = 180;

// Damped-oscillation settle: overshoots the scattered pose then rings down,
// which reads as physics-like without a solver.
function settleEase(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));

  return 1 - Math.exp(-5.2 * clamped) * Math.cos(8.5 * clamped);
}

function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));

  return 1 - (1 - clamped) ** 3;
}

// Poured, not scrubbed: speed falls monotonically from first frame to last, the
// way a flow does as it divides between branches.
//
// Deliberately NOT a smoothstep. A smoothstep spends its curvature at the two
// ends and runs dead straight through the middle, and the sweep padding puts
// both of those ends off-screen — so the only part left on screen is the linear
// section, which is what made the first attempt read as a wipe. A single
// decaying power curves everywhere, so the deceleration lands inside the window
// the eye is actually watching. Velocity is 0 at t=1, so the last veins creep in
// rather than stopping dead; the hard start at t=0 is hidden inside the padding.
//
// The exponent sets how much speed is left when the last of the network fills.
// At 1.5 the front was still travelling at ~40% of its opening speed as it
// reached the rim, which read as a hard stop; 2.2 more than halves that, at the
// cost of a quicker opening — which is the right trade, since the opening is
// one fast channel and the ending is the whole rim.
function pourEase(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));

  return 1 - (1 - clamped) ** 2.2;
}

// Seconds for one full turntable revolution. There is no timeline panel, so
// this single constant is the loop period for both the live preview and the
// video export, and every exported clip is exactly one revolution long.
export const turntableLoopSeconds = 12;

// A tab that was backgrounded returns with a huge frame delta; clamping it
// keeps the vessel from jumping most of a revolution on the first frame back.
const maxTurntableStepSeconds = 0.25;

export function turntableYaw(progress: number, easing: "linear" | "smooth"): number {
  const looped = progress - Math.floor(progress);
  const eased =
    easing === "smooth" ? looped * looped * (3 - 2 * looped) : looped;

  return eased * Math.PI * 2;
}

type ShardEntry = {
  mesh: THREE.Mesh;
  source: ShardSource;
};

export class KintsugiSceneManager {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly controls: OrbitControls;
  private readonly bisqueMaterial: THREE.MeshStandardMaterial;
  private readonly glazeMaterial: THREE.MeshPhysicalMaterial;
  private readonly goldMaterial: THREE.MeshPhysicalMaterial;
  private disposeGoldEnvironment: () => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly surfaces = createVesselSurfaces();
  private readonly textures: KintsugiSurfaceTextures;
  private readonly vesselPivot: THREE.Group;
  private readonly glazeTextureLoader = new THREE.TextureLoader();
  private readonly studioLights: StudioLights;

  // Both environments are re-bakeable now that the Softbox / Ambient dome
  // controls change emitters inside each of them, so their disposers are kept
  // rather than dropped. environmentDirty coalesces a drag's many value commits
  // into at most one bake of the pair per frame.
  private disposeStudioEnvironment: () => void;
  private environmentDirty = false;
  private bakedDomeScale = 1;
  private bakedSoftboxScale = 1;

  // Only one glaze's PBR maps are ever resident: switching disposes the
  // previous set, so the number of presets does not grow GPU memory.
  private activeGlazeTextures: THREE.Texture[] = [];
  private activeGlazeTexturePreset: string | null = null;
  private appliedGlazePreset: string | null = null;

  private animationFrame: number | null = null;
  private cssHeight = 0;
  private cssWidth = 0;
  private disposed = false;
  private exporting = false;
  private fracture: FractureResult | null = null;
  private fractureDirty = true;
  private lastTickMs: number | null = null;
  private lastRenderedYaw = Number.NaN;
  private needsRender = true;
  private renderScale = 0;
  private seamDirty = false;
  private seamGeometry: THREE.BufferGeometry | null = null;
  private seamMesh: THREE.Mesh | null = null;
  // Starts hidden: the vessel loads whole, with no gold anywhere on it.
  private seamReveal = 0;
  private seamTotalVertices = 0;
  private seamRevealMax = 1;
  // Exact front values at which the first gold appears and the last gold finishes
  // settling, measured off the geometry that actually renders, plus the sweep
  // schedule between them. See computeFrontSchedule.
  private seamFrontStart = 0;
  private seamFrontEnd = 1;
  private readonly seamFrontTable = new Float32Array(129);
  // Shared uniform driving the flowing reveal front through the gold shader.
  private readonly goldFront = { value: 0 };
  private readonly goldRevealBand = { value: 0.14 };
  // Surface tension at the running tip: how far past full width the leading
  // edge beads up before it relaxes back. 0 = the old monotone widening.
  private readonly goldBeadAmount = { value: 0.22 };
  // Shape of the ADVANCING TIP. The seam is a closed box-section through the
  // wall, and the reveal is a per-fragment discard that fires exactly where the
  // cross-section has already collapsed to nothing — so the tip is never cut
  // flat, its shape is entirely whatever the cross-section does on the way to
  // zero. The settle curve below is a smoothstep, which has zero slope at 0 and
  // therefore opens the section as ~t^2: a cusp, sharper than a plain wedge. A
  // rounded meniscus needs it to open like sqrt(t). uTipRound blends that in
  // (0 = the old cusp), uTipLength is the fraction of the reveal band the nose
  // occupies — kept short so the surface-tension bead behind it is untouched.
  private readonly goldTipRound = { value: 1 };
  private readonly goldTipLength = { value: 0.25 };
  // Per-vein desync. Without this every branch at the same network distance
  // fills on the same frame, and that lockstep is what reads as mechanical.
  // Set from revealMax at build time so the units track the crack network.
  private readonly goldWanderAmount = { value: 0 };
  private readonly goldWanderScale = { value: 2.5 };
  // Downhill veins run first.
  private readonly goldGravityBias = { value: 0 };
  // Hard bound on the combined lead, so applySeamReveal knows exactly how far
  // to extend the sweep to still guarantee empty at 0 and full at 1.
  private readonly goldLeadMax = { value: 0 };
  // Strength of the outer-face gold colour-match (0 = off, inner face is never
  // affected). Tuned so the convex outside reads the same gold as the inside.
  private readonly goldMatchAmount = { value: 0.40 };
  private settings: KintsugiSettings = { ...defaultKintsugiSettings };
  private shardEntries: ShardEntry[] = [];
  private suspendedUntilMs = 0;
  // Phase of the turntable loop, advanced by the tick's own wall clock while
  // Auto-rotate is on. Pausing simply stops advancing it, so re-enabling
  // Auto-rotate resumes from the same angle rather than snapping to zero.
  private turntableTimeSeconds = 0;
  private transitionDirection: VesselStateValue = "pristine";
  private transitionStartMs: number | null = null;
  private revealAnchorMs: number | null = null;
  private revealAnchorValue = 0;

  // Every strike the vessel has taken, oldest first — the durable state the
  // whole fracture is rebuilt from, so a seam-width change re-cuts the same
  // break history rather than relocating the cracks.
  private impacts: ImpactPoint[] = [];
  // Where the vessel currently is in the strike cycle. It starts whole.
  private vesselState: VesselStateValue = "pristine";
  // When the automatic repair begins; the pause between the two is what makes
  // the vessel read as gathering itself back together rather than snapping.
  private autoRepairAtMs: number | null = null;
  private appliedResetToken = 0;
  // Gold geometry owed for the current break, built during the hold beat.
  private seamsDeferred = false;

  // Click detection. The press is tracked so an orbit drag can be told apart
  // from a strike, and the raycaster is reused rather than rebuilt per event.
  private readonly raycaster = new THREE.Raycaster();
  private pressX = 0;
  private pressY = 0;
  private pressMs = 0;
  private hoveringVessel = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // The context is created explicitly (antialiased, with a preserved buffer
    // so the canvas stays readable for export and test pixel snapshots).
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: createKintsugiWebglContext(canvas),
    });
    configureKintsugiRenderer(this.renderer);

    this.scene = new THREE.Scene();

    const studioEnv = createStudioEnvironment(this.renderer);

    this.scene.environment = studioEnv.texture;
    this.disposeStudioEnvironment = studioEnv.dispose;

    // Dedicated warm reflection map for the gold seams (see createGoldEnvironment).
    // Only the disposer is held: once goldMaterial exists its envMap is the
    // single source of truth for which bake is live, so a rebake has one place
    // to write rather than two that could drift apart.
    const goldEnv = createGoldEnvironment(this.renderer);

    this.disposeGoldEnvironment = goldEnv.dispose;

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 60);
    this.camera.position.set(2.15, 1.7, 2.3);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, vesselCenterY, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.addEventListener("change", () => {
      this.needsRender = true;
    });

    this.studioLights = addStudioLighting(this.scene);
    this.scene.add(createGroundShadowDisc());

    this.textures = createKintsugiSurfaceTextures();

    // Glaze: fired ceramic with a fine orange-peel normal and a clearcoat so
    // the surface has the wet depth of a real glaze. The per-preset color and
    // PBR response are applied by applyGlazePreset; the scalars here just seed a
    // sensible first frame (the default glaze) before the first applySettings.
    // Ceramic, not chrome: restrained clearcoat and reflection, a real roughness
    // floor, and a normal map whose coarse octave (wheel-throwing rings) bends
    // the big environment reflections into irregular streaks instead of mirrors.
    const initialGlaze = getGlazePreset(defaultGlazePresetId);
    this.glazeMaterial = new THREE.MeshPhysicalMaterial({
      clearcoat: initialGlaze.clearcoat,
      clearcoatNormalMap: this.textures.glazeNormal,
      clearcoatNormalScale: new THREE.Vector2(0.3, 0.3),
      clearcoatRoughness: initialGlaze.clearcoatRoughness,
      color: new THREE.Color(initialGlaze.color),
      envMapIntensity: initialGlaze.envMapIntensity,
      normalMap: this.textures.glazeNormal,
      normalScale: new THREE.Vector2(initialGlaze.normalScale, initialGlaze.normalScale),
      roughness: initialGlaze.roughness,
      roughnessMap: this.textures.glazeRoughness,
      side: THREE.DoubleSide,
      specularIntensity: initialGlaze.specularIntensity,
    });
    // Raw bisque body exposed on the fracture walls: coarse clay grain.
    this.bisqueMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#e6dcc8"),
      envMapIntensity: 0.35,
      normalMap: this.textures.bisqueNormal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.92,
      side: THREE.DoubleSide,
    });
    // Gold: hand-applied lacquer-and-metal with hammered grain and roughness
    // break-up so highlights read as brushed leaf, not chrome.
    // Smooth molten gold. The SDF field already gives the vein its organic
    // shape, and its (theta, s) grid UVs would smear a hammered normal map along
    // branches, so the map is applied only faintly and the roughness is uniform
    // — the gold reads as a poured, glossy metal rather than a textured rope.
    this.goldMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(kintsugiGoldColor),
      envMap: goldEnv.texture,
      envMapIntensity: 1.1,
      metalness: 1,
      normalMap: this.textures.goldNormal,
      normalScale: new THREE.Vector2(0.08, 0.08),
      roughness: 0.34,
      side: THREE.DoubleSide,
    });

    // Flowing fill: instead of popping the finished bead into view, a reveal
    // front sweeps outward along the crack network (aReveal = distance from the
    // origin). Ahead of the front the bead is clipped; right at the front its
    // cross-section is collapsed toward the centerline, so gold appears to run
    // in as a thin thread and then pool up to full width behind the front.
    // Unit gold chroma (linear gold ÷ its luminance) so multiplying by a
    // fragment's luminance reproduces the gold hue at that exact brightness.
    // The match target is biased slightly yellower than kintsugiGoldColor: the
    // correction happens in linear space before tone mapping, which skews the
    // result a few degrees toward orange, so pre-compensating here lands the
    // outer face on the SAME hue the untouched inner face already shows. The
    // bias was dialled in under ACES, whose shoulder desaturated the seam more
    // than the current PBR Neutral curve does; it is left as-is because the two
    // faces still agree, which is all this correction is for.
    const goldMatchColor = "#DDC228";
    const goldLinear = new THREE.Color(goldMatchColor).convertSRGBToLinear();
    const goldLum = 0.2126 * goldLinear.r + 0.7152 * goldLinear.g + 0.0722 * goldLinear.b;
    const goldUnit = new THREE.Vector3(
      goldLinear.r / goldLum,
      goldLinear.g / goldLum,
      goldLinear.b / goldLum,
    );

    this.goldMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uFront = this.goldFront;
      shader.uniforms.uRevealBand = this.goldRevealBand;
      shader.uniforms.uBeadAmount = this.goldBeadAmount;
      shader.uniforms.uTipRound = this.goldTipRound;
      shader.uniforms.uTipLength = this.goldTipLength;
      shader.uniforms.uWanderAmount = this.goldWanderAmount;
      shader.uniforms.uWanderScale = this.goldWanderScale;
      shader.uniforms.uGravityBias = this.goldGravityBias;
      shader.uniforms.uLeadMax = this.goldLeadMax;
      shader.uniforms.uPivotY = { value: vesselCenterY };
      // Colour-match the outer face to the inner one. A pure-metal seam takes its
      // colour entirely from what it reflects, and the concave inside vs. the
      // convex outside reflect the environment very differently, so the two faces
      // resolve to different golds (a hard seam at the rim). Here the OUTER face
      // (aInner < 0.5) has its chroma pulled toward the canonical gold while its
      // LUMINANCE is preserved — so the metallic highlights and dark recesses (the
      // dimensional shading) survive, only the hue/saturation is unified. The
      // inner face is left untouched (uMatchAmount * (1 - vInner) == 0 there).
      shader.uniforms.uGoldUnit = { value: goldUnit };
      shader.uniforms.uMatchAmount = this.goldMatchAmount;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          attribute float aReveal;
          attribute float aCoverage;
          attribute float aInner;
          attribute vec3 aOffset;
          uniform float uFront;
          uniform float uRevealBand;
          uniform float uBeadAmount;
          uniform float uTipRound;
          uniform float uTipLength;
          uniform float uWanderAmount;
          uniform float uWanderScale;
          uniform float uGravityBias;
          uniform float uLeadMax;
          uniform float uPivotY;
          varying float vAhead;
          varying float vCoverage;
          varying float vInner;

          float goldHash(vec3 p) {
            return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
          }

          // Trilinear value noise. Coherent by construction, which is the whole
          // point: neighbouring samples on a vein must shift together so the
          // front surges and stalls along its length rather than dissolving
          // into per-vertex confetti.
          float goldNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);

            return mix(
              mix(
                mix(goldHash(i + vec3(0.0, 0.0, 0.0)), goldHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                mix(goldHash(i + vec3(0.0, 1.0, 0.0)), goldHash(i + vec3(1.0, 1.0, 0.0)), f.x),
                f.y),
              mix(
                mix(goldHash(i + vec3(0.0, 0.0, 1.0)), goldHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                mix(goldHash(i + vec3(0.0, 1.0, 1.0)), goldHash(i + vec3(1.0, 1.0, 1.0)), f.x),
                f.y),
              f.z);
          }`,
        )
        .replace(
          "#include <begin_vertex>",
          // Everything that shifts WHEN a vertex fills is evaluated on the
          // centerline (position - aOffset), never on the vertex itself. Both
          // walls of a bead and every ring around its cross-section share one
          // spine point, so they fill as a unit; sampling per-vertex would tear
          // the tube open along the front.
          `vec3 spine = position - aOffset;
          float wanderLead = (goldNoise(spine * uWanderScale) - 0.5) * uWanderAmount;
          // Local Y, not world: the turntable is yaw-only, so this stays fixed
          // while the bowl spins. Taking gravity from the world matrix instead
          // would re-time a vein mid-pour and make the filled front retreat.
          float gravityLead = -(spine.y - uPivotY) * uGravityBias;
          float lead = clamp(wanderLead + gravityLead, -uLeadMax, uLeadMax);

          float rawT = clamp((uFront - (aReveal + lead)) / uRevealBand, 0.0, 1.0);
          // Surface tension: the running tip beads past full width, then
          // relaxes as the flow behind it feeds forward. Endpoints stay exactly
          // 0 and 1, so the settled bead is the same one the old curve reached.
          float settle = smoothstep(0.0, 0.55, rawT);
          // Rounded nose. sqrt opens the cross-section steeply at the very front
          // and then flattens, which is the hemispherical profile; smoothstep
          // alone opens it as t^2 and comes to a point. max() so the nose can
          // only ever round the tip out, never pull the fill back.
          float dome = sqrt(rawT);
          float nose = 1.0 - smoothstep(0.0, max(1e-4, uTipLength), rawT);
          settle = mix(settle, max(settle, dome), nose * uTipRound);
          float bead = sin(rawT * 3.14159265) * uBeadAmount * (1.0 - smoothstep(0.6, 1.0, rawT));
          float fillT = settle + bead;

          vec3 transformed = spine + aOffset * fillT;
          vAhead = uFront - (aReveal + lead);
          vCoverage = aCoverage;
          vInner = aInner;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform vec3 uGoldUnit;
          uniform float uMatchAmount;
          varying float vAhead;
          varying float vCoverage;
          varying float vInner;`,
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `if (vAhead < 0.0) discard;
          if (vCoverage < 0.0) discard;
          #include <clipping_planes_fragment>`,
        )
        .replace(
          "#include <tonemapping_fragment>",
          `{
            float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 goldified = lum * uGoldUnit;
            // Keep specular glints white-hot: fade the correction as luminance
            // rises so highlights are not forced to saturated gold.
            float hi = smoothstep(0.85, 1.7, lum);
            float amount = uMatchAmount * (1.0 - hi) * (1.0 - vInner);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, goldified, amount);
          }
          #include <tonemapping_fragment>`,
        );
    };

    this.vesselPivot = new THREE.Group();
    this.vesselPivot.position.set(0, vesselCenterY, 0);
    this.scene.add(this.vesselPivot);

    // Keep runtime canvas panning and wheel zoom from hijacking the 3D orbit
    // gesture; the orbit itself is product interaction on product output.
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("wheel", stopEventPropagation, { passive: false });

    this.tick = this.tick.bind(this);
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  applySettings(next: KintsugiSettings): void {
    const previous = this.settings;

    this.settings = { ...next };

    // Seam width now also drives the gap between shards (the gold fills a
    // proportional channel), so the fracture skins must rebuild with it.
    if (next.seamWidth !== previous.seamWidth) {
      this.fractureDirty = true;
    } else if (next.seamRelief !== previous.seamRelief) {
      this.seamDirty = true;
    }

    if (next.resetToken !== this.appliedResetToken) {
      this.appliedResetToken = next.resetToken;
      this.resetVessel();
    }

    if (next.glazePreset !== this.appliedGlazePreset) {
      this.applyGlazePreset(getGlazePreset(next.glazePreset));
      this.appliedGlazePreset = next.glazePreset;
    }

    this.applyLighting();

    if (
      next.lightSoftbox !== previous.lightSoftbox ||
      next.lightAmbientDome !== previous.lightAmbientDome
    ) {
      // Deferred to the tick so a slider drag bakes once per frame instead of
      // once per committed value.
      this.environmentDirty = true;
    }

    this.needsRender = true;
  }

  // Analytic lights and exposure are plain scalars, so they update in place with
  // no rebuild. Percent settings scale the tuned intensities from stage.ts.
  private applyLighting(): void {
    const levels = resolveStudioLighting(this.settings);

    this.studioLights.keyLight.intensity = levels.keyIntensity;
    this.studioLights.fillLight.intensity = levels.fillIntensity;
    this.renderer.toneMappingExposure = levels.exposure;
  }

  // Softbox and dome are emitters inside the PMREM-prefiltered environments, so
  // changing them means baking new maps and swapping them in. Both rigs are
  // rebaked from the same two scales: the studio cove lights the glaze and the
  // bisque, and the gold seams are metalness 1 with their own envMap, so without
  // the second bake those two controls would move the bowl and leave the seams
  // frozen. Each old texture is disposed only after its replacement is live.
  private rebuildEnvironments(): void {
    const { domeScale, softboxScale } = resolveStudioLighting(this.settings);

    // One guard covers both bakes: they read the same two scales, so if these
    // match nothing either map depends on has moved.
    if (domeScale === this.bakedDomeScale && softboxScale === this.bakedSoftboxScale) {
      return;
    }

    const previousStudioDispose = this.disposeStudioEnvironment;
    const nextStudio = createStudioEnvironment(this.renderer, { domeScale, softboxScale });

    this.scene.environment = nextStudio.texture;
    this.disposeStudioEnvironment = nextStudio.dispose;
    previousStudioDispose();

    const previousGoldDispose = this.disposeGoldEnvironment;
    const nextGold = createGoldEnvironment(this.renderer, { domeScale, softboxScale });

    this.goldMaterial.envMap = nextGold.texture;
    this.goldMaterial.needsUpdate = true;
    this.disposeGoldEnvironment = nextGold.dispose;
    previousGoldDispose();

    this.bakedDomeScale = domeScale;
    this.bakedSoftboxScale = softboxScale;
  }

  // Apply a glaze preset to the single shared glaze material. The preset is the
  // whole material identity including its finish — nothing here modulates it, so
  // what the picker selects is what the surface shows. The clearcoat rides the
  // texture's own normal (set in loadGlazeTextures) so the sheen follows the
  // relief instead of sheeting evenly over the basecolor.
  private applyGlazePreset(preset: GlazePreset): void {
    const material = this.glazeMaterial;

    material.color.set(preset.color);
    material.specularIntensity = preset.specularIntensity;
    material.roughness = preset.roughness;
    material.clearcoat = preset.clearcoat;
    material.clearcoatRoughness = preset.clearcoatRoughness;
    material.envMapIntensity = preset.envMapIntensity;
    material.normalScale.setScalar(preset.normalScale);

    if (preset.textures) {
      this.loadGlazeTextures(preset);
    } else {
      this.useProceduralGlazeMaps();
    }

    material.needsUpdate = true;
  }

  // Restore the built-in procedural detail maps and free any resident preset
  // textures (switching back to a solid/procedural glaze).
  private useProceduralGlazeMaps(): void {
    this.disposeActiveGlazeTextures();
    this.textures.glazeNormal.channel = 0;
    this.textures.glazeRoughness.channel = 0;
    this.glazeMaterial.map = null;
    this.glazeMaterial.normalMap = this.textures.glazeNormal;
    this.glazeMaterial.clearcoatNormalMap = this.textures.glazeNormal;
    this.glazeMaterial.roughnessMap = this.textures.glazeRoughness;
    this.activeGlazeTexturePreset = null;
  }

  // Lazy-load whatever PBR maps a preset actually ships and swap them onto the
  // shared material. Every map is optional: a missing basecolor keeps the solid
  // preset color, and a missing normal/roughness falls back to the built-in
  // procedural detail. The previous preset's maps are disposed first, so only
  // one glaze's textures occupy GPU memory at a time.
  private loadGlazeTextures(preset: GlazePreset): void {
    if (this.activeGlazeTexturePreset === preset.id || !preset.textures) {
      return;
    }

    this.disposeActiveGlazeTextures();
    this.activeGlazeTexturePreset = preset.id;

    const transform = glazeUvTransform(preset);
    const loaded: THREE.Texture[] = [];
    const load = (url: string, colorSpace: THREE.ColorSpace): THREE.Texture => {
      const texture = this.glazeTextureLoader.load(url, () => {
        this.needsRender = true;
      });

      texture.colorSpace = colorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.channel = transform.channel;
      texture.repeat.setScalar(transform.repeat);
      texture.offset.set(transform.offsetX, transform.offsetY);
      // Max rather than a fixed 8: the cylindrical unwrap minifies hard toward
      // the base (the texture is ~4x finer there than at the rim), so the lower
      // wall is exactly where mip blur costs the most detail.
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      loaded.push(texture);
      return texture;
    };

    const maps = preset.textures ?? {};
    // The procedural fallbacks are shared across presets, so their channel has
    // to be set every time rather than once: whichever preset last used them
    // would otherwise leave them pointing at the wrong unwrap.
    const normalTexture = maps.normal
      ? load(maps.normal, THREE.NoColorSpace)
      : this.useSharedGlazeMap(this.textures.glazeNormal, transform);

    this.glazeMaterial.map = maps.basecolor
      ? load(maps.basecolor, THREE.SRGBColorSpace)
      : null;
    this.glazeMaterial.normalMap = normalTexture;
    // The clearcoat rides the preset's own normal. On a flat normal the coat is
    // a perfectly even achromatic sheen laid over every texel of the basecolor,
    // which is exactly the "washed out" look; following the relief instead means
    // the sheen catches on the raised grain and leaves the hollows to show their
    // colour, so the coat reads as wet glaze rather than as a white veil.
    this.glazeMaterial.clearcoatNormalMap = normalTexture;
    this.glazeMaterial.roughnessMap = maps.roughness
      ? load(maps.roughness, THREE.NoColorSpace)
      : this.useSharedGlazeMap(this.textures.glazeRoughness, transform);
    this.glazeMaterial.needsUpdate = true;
    this.activeGlazeTextures = loaded;
  }

  // Point one of the shared procedural maps at this preset's unwrap. Never
  // disposed and never owned by a preset, so it is re-pointed rather than
  // recreated.
  private useSharedGlazeMap(
    texture: THREE.Texture,
    transform: GlazeUvTransform,
  ): THREE.Texture {
    texture.channel = transform.channel;

    return texture;
  }

  private disposeActiveGlazeTextures(): void {
    for (const texture of this.activeGlazeTextures) {
      texture.dispose();
    }

    this.activeGlazeTextures = [];
  }

  setViewSize(width: number, height: number, renderScale: number): void {
    const nextWidth = Math.max(2, Math.round(width));
    const nextHeight = Math.max(2, Math.round(height));
    const nextScale = Math.min(4, Math.max(1, renderScale));

    if (
      nextWidth === this.cssWidth &&
      nextHeight === this.cssHeight &&
      nextScale === this.renderScale
    ) {
      return;
    }

    this.cssWidth = nextWidth;
    this.cssHeight = nextHeight;
    this.renderScale = nextScale;
    this.applyViewSize();
  }

  notifyViewportInteraction(): void {
    this.suspendedUntilMs = performance.now() + viewportSuspendMs;
  }

  getShardCount(): number {
    return this.fracture?.shardCount ?? 0;
  }

  getSeamRevealProgress(): number {
    return this.seamReveal;
  }

  getImpactCount(): number {
    return this.impacts.length;
  }

  getVesselState(): VesselStateValue {
    return this.vesselState;
  }

  isTransitionSettled(): boolean {
    return this.transitionStartMs === null;
  }

  // Settled AND not waiting to repair itself: the vessel is standing still and
  // will accept another strike.
  isCycleIdle(): boolean {
    return this.transitionStartMs === null && this.autoRepairAtMs === null;
  }

  // Strike the vessel: break it open along fresh cracks radiating from the point
  // struck, then, after a beat, gather it back together with gold in the cracks.
  strikeVessel(impact: ImpactPoint): void {
    if (!this.isCycleIdle()) {
      return;
    }

    this.impacts.push(impact);
    // Rebuilt here rather than through fractureDirty so the new cracks exist on
    // the very frame the vessel starts flying apart. The vessel is still at rest
    // at this instant, so the rebuild's cost lands before anything is moving --
    // the least visible moment for it. The gold is deferred (see seamsDeferred):
    // it is not needed until the repair, and building it here would nearly
    // double the pause between the click and the break.
    this.rebuildFracture({ deferSeams: true });
    this.vesselState = "shattered";
    this.transitionDirection = "shattered";
    this.transitionStartMs = performance.now();
    this.autoRepairAtMs =
      this.transitionStartMs + (shatterDurationSeconds + shatterHoldSeconds) * 1000;
    // The break starts bare; gold only arrives with the repair.
    this.seamReveal = 0;
    this.revealAnchorMs = null;
    this.applySeamReveal();
    this.needsRender = true;
  }

  // Back to an unbroken, gold-free bowl, forgetting the whole strike history.
  resetVessel(): void {
    this.impacts = [];
    this.vesselState = "pristine";
    this.transitionDirection = "pristine";
    this.transitionStartMs = null;
    this.autoRepairAtMs = null;
    this.seamReveal = 0;
    this.revealAnchorMs = null;
    this.fractureDirty = true;
    this.needsRender = true;
  }

  private handlePointerDown(event: PointerEvent): void {
    stopEventPropagation(event);
    this.pressX = event.clientX;
    this.pressY = event.clientY;
    this.pressMs = performance.now();
  }

  private handlePointerUp(event: PointerEvent): void {
    const travelled = Math.hypot(event.clientX - this.pressX, event.clientY - this.pressY);

    if (
      travelled > clickMaxTravelPx ||
      performance.now() - this.pressMs > clickMaxDurationMs ||
      !this.isCycleIdle()
    ) {
      return;
    }

    const impact = this.impactAtPointer(event);

    if (impact) {
      this.strikeVessel(impact);
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    const hovering = this.isCycleIdle() && this.impactAtPointer(event) !== null;

    if (hovering !== this.hoveringVessel) {
      this.hoveringVessel = hovering;
      this.canvas.style.cursor = hovering ? "pointer" : "";
    }
  }

  // Raycast the pointer against the vessel and convert the hit into the strike
  // parameters. Returns null when the pointer is over empty space, so clicking
  // the background never breaks anything.
  private impactAtPointer(event: PointerEvent): ImpactPoint | null {
    const rect = this.canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointerNdc, this.camera);

    const meshes = this.shardEntries.map((entry) => entry.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];

    if (!hit) {
      return null;
    }

    // Into the struck mesh's own space, which is the surface space the profile
    // samplers work in -- so this stays correct whatever pose the shard is in.
    // Measured: the point recorded this way projects back to within ~10px of the
    // cursor at a 1920-wide canvas, which is under the ~15px the fracture grid
    // can resolve a junction to in the first place. The residual is the hit
    // landing on a skin while the fracture is cut on the midsurface between them.
    return nearestSurfaceParam(
      this.surfaces,
      hit.object.worldToLocal(hit.point.clone()),
    );
  }

  createExportSession(pixelWidth: number, pixelHeight: number): ExportSession {
    const exportCanvas = document.createElement("canvas");
    const exportRenderer = new THREE.WebGLRenderer({
      canvas: exportCanvas,
      context: createKintsugiWebglContext(exportCanvas),
    });

    const exportLighting = resolveStudioLighting(this.settings);

    configureKintsugiRenderer(exportRenderer);
    // configureKintsugiRenderer seeds exposure at 1; the export must match the
    // preview, so the Lighting value is reapplied to this renderer too.
    exportRenderer.toneMappingExposure = exportLighting.exposure;
    exportRenderer.setPixelRatio(1);
    exportRenderer.setSize(pixelWidth, pixelHeight, false);

    // Render-target textures cannot cross WebGL contexts, so the export
    // context builds its own environment maps (scene + gold seams) and restores
    // the live ones after. BOTH are baked with the same Softbox / Ambient dome
    // scales the preview is showing, or an export at any non-default value would
    // disagree with the preview it was taken from.
    const liveEnvironment = this.scene.environment;
    const exportEnvironment = createStudioEnvironment(exportRenderer, {
      domeScale: exportLighting.domeScale,
      softboxScale: exportLighting.softboxScale,
    });
    const liveGoldEnvironment = this.goldMaterial.envMap;
    const exportGoldEnvironment = createGoldEnvironment(exportRenderer, {
      domeScale: exportLighting.domeScale,
      softboxScale: exportLighting.softboxScale,
    });

    this.goldMaterial.envMap = exportGoldEnvironment.texture;
    this.goldMaterial.needsUpdate = true;
    const liveAspect = this.camera.aspect;

    this.exporting = true;
    this.settleTransitionImmediately();

    const renderFrame = (
      turntableTimeSeconds: number | null,
      includeBackground: boolean,
    ): HTMLCanvasElement => {
      this.scene.environment = exportEnvironment.texture;
      this.scene.background = includeBackground
        ? new THREE.Color(this.settings.background)
        : null;
      this.camera.aspect = pixelWidth / pixelHeight;
      this.camera.updateProjectionMatrix();

      // null means "whatever the preview is showing right now" (the still
      // export); the video export drives the phase explicitly per frame.
      const yawTime =
        turntableTimeSeconds === null ? this.turntableTimeSeconds : turntableTimeSeconds;

      this.applyVesselPose(yawTime);
      this.applyShardPoses(performance.now());
      this.applySeamReveal();
      exportRenderer.render(this.scene, this.camera);

      return exportCanvas;
    };

    const dispose = (): void => {
      this.scene.environment = liveEnvironment;
      this.scene.background = null;
      this.goldMaterial.envMap = liveGoldEnvironment;
      this.goldMaterial.needsUpdate = true;
      this.camera.aspect = liveAspect;
      this.camera.updateProjectionMatrix();
      exportEnvironment.dispose();
      exportGoldEnvironment.dispose();
      exportRenderer.dispose();
      this.exporting = false;
      this.needsRender = true;
    };

    return { dispose, renderFrame };
  }

  dispose(): void {
    this.disposed = true;

    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }

    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("wheel", stopEventPropagation);
    this.controls.dispose();
    this.clearVesselMeshes();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    this.disposeActiveGlazeTextures();
    this.glazeMaterial.dispose();
    this.bisqueMaterial.dispose();
    this.goldMaterial.dispose();
    this.disposeGoldEnvironment();
    this.disposeStudioEnvironment();
    this.textures.bisqueNormal.dispose();
    this.textures.glazeNormal.dispose();
    this.textures.glazeRoughness.dispose();
    this.textures.goldNormal.dispose();
    this.textures.goldRoughness.dispose();
    this.renderer.dispose();
  }

  private applyViewSize(): void {
    this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private clearVesselMeshes(): void {
    for (const entry of this.shardEntries) {
      entry.mesh.geometry.dispose();
      this.vesselPivot.remove(entry.mesh);
    }

    this.shardEntries = [];

    if (this.seamMesh) {
      this.vesselPivot.remove(this.seamMesh);
      this.seamMesh = null;
    }

    if (this.seamGeometry) {
      this.seamGeometry.dispose();
      this.seamGeometry = null;
    }
  }

  private rebuildFracture(options?: { deferSeams?: boolean }): void {
    this.clearVesselMeshes();

    this.fracture = buildFracture(this.surfaces, {
      branching: crackBranching,
      density: shardsPerStrike,
      gapHalf: seamChannelHalf,
      impacts: this.impacts,
      seed: fractureSeed,
      // Same generosity the gold uses, so the crack the shards open matches the
      // gold that fills it (see rebuildSeams' width below).
      width: this.settings.seamWidth * seamScale * 0.9,
    });

    for (const source of this.fracture.shards) {
      const geometry = new THREE.BufferGeometry();
      const glazeVertexCount = source.glazePositions.length / 3;
      const bisqueVertexCount = source.bisquePositions.length / 3;
      const positions = new Float32Array(
        source.glazePositions.length + source.bisquePositions.length,
      );
      const normals = new Float32Array(positions.length);
      const discUvs = new Float32Array((positions.length / 3) * 2);
      const cylindricalUvs = new Float32Array(discUvs.length);

      positions.set(source.glazePositions, 0);
      positions.set(source.bisquePositions, source.glazePositions.length);
      normals.set(source.glazeNormals, 0);
      normals.set(source.bisqueNormals, source.glazeNormals.length);
      discUvs.set(discUnwrapUvs(source.glazePositions), 0);
      discUvs.set(discUnwrapUvs(source.bisquePositions), glazeVertexCount * 2);
      // Unwrapped per skin rather than over the joined buffer: the cylindrical
      // unwrap walks the soup three vertices at a time, so it has to start each
      // skin on a triangle boundary.
      cylindricalUvs.set(cylindricalUnwrapUvs(source.glazePositions), 0);
      cylindricalUvs.set(cylindricalUnwrapUvs(source.bisquePositions), glazeVertexCount * 2);

      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(discUvs, 2));
      geometry.setAttribute("uv1", new THREE.BufferAttribute(cylindricalUvs, 2));
      geometry.addGroup(0, glazeVertexCount, 0);
      geometry.addGroup(glazeVertexCount, bisqueVertexCount, 1);

      const mesh = new THREE.Mesh(geometry, [this.glazeMaterial, this.bisqueMaterial]);

      mesh.position.y = -vesselCenterY;
      this.vesselPivot.add(mesh);
      this.shardEntries.push({ mesh, source });
    }

    if (options?.deferSeams) {
      // The stale seam mesh no longer matches these shards, but it is hidden
      // (a strike drops the reveal to 0) until the deferred build replaces it.
      this.seamsDeferred = true;
      return;
    }

    this.rebuildSeams();
  }

  // Build the deferred gold during the beat the shards hang at full spread:
  // nothing is moving then, so the cost is invisible, and it lands well before
  // the repair starts drawing the gold on.
  private flushDeferredSeams(): void {
    if (!this.seamsDeferred) {
      return;
    }

    this.seamsDeferred = false;
    this.rebuildSeams();
    this.needsRender = true;
  }

  private rebuildSeams(): void {
    if (!this.fracture) {
      return;
    }

    // However the gold got rebuilt -- deferred flush, a control change, or a
    // reset -- nothing is owed once it has.
    this.seamsDeferred = false;

    if (this.seamMesh) {
      this.vesselPivot.remove(this.seamMesh);
      this.seamMesh = null;
    }

    this.seamGeometry?.dispose();

    const source = buildSeamGeometry(this.surfaces, this.fracture.seamPaths, {
      gapHalf: seamChannelHalf,
      relief: this.settings.seamRelief * seamScale * 0.85,
      seed: fractureSeed,
      // Repurposed "Width" control: generosity of the repair. Scales how fat
      // the gold pools at junctions/rim; tight runs stay a hairline regardless.
      width: this.settings.seamWidth * seamScale * 0.9,
      // Shared model built by the fracture cutter: the gold fills exactly the
      // crack the shards opened (crack width == gold width, pooling at junctions).
      widthModel: this.fracture.widthModel,
    });

    this.seamTotalVertices = source.totalVertexCount;
    this.seamRevealMax = source.revealMax || 1;
    // Lead terms are fractions of the network's own extent, so a dense crack
    // web and a sparse one desync by the same proportion rather than the dense
    // one dissolving. Gravity is per world-unit of height; the bowl is roughly
    // 2 * vesselCenterY tall, so this lands in the same range as the wander.
    this.goldWanderAmount.value = this.seamRevealMax * 0.1;
    this.goldGravityBias.value = (this.seamRevealMax * 0.09) / vesselCenterY;
    this.goldLeadMax.value = this.seamRevealMax * 0.09;
    this.seamGeometry = new THREE.BufferGeometry();
    this.seamGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(source.positions, 3),
    );
    this.seamGeometry.setAttribute("normal", new THREE.BufferAttribute(source.normals, 3));
    this.seamGeometry.setAttribute("aOffset", new THREE.BufferAttribute(source.offsets, 3));
    this.seamGeometry.setAttribute("aReveal", new THREE.BufferAttribute(source.reveals, 1));
    this.seamGeometry.setAttribute("aCoverage", new THREE.BufferAttribute(source.coverages, 1));
    this.seamGeometry.setAttribute("aInner", new THREE.BufferAttribute(source.faces, 1));
    this.seamGeometry.setAttribute("uv", new THREE.BufferAttribute(source.uvs, 2));
    this.seamGeometry.setIndex(new THREE.BufferAttribute(source.index, 1));
    this.computeFrontSchedule(source);

    this.seamMesh = new THREE.Mesh(this.seamGeometry, this.goldMaterial);
    this.seamMesh.position.y = -vesselCenterY;
    this.vesselPivot.add(this.seamMesh);
    this.applySeamReveal();
  }

  // Exports capture a still, not a moment mid-tween: jump the vessel to wherever
  // the current cycle was heading. A pending auto-repair counts as heading to
  // repaired, so an export taken while the shards are still out shows the
  // finished, gold-seamed vessel rather than a frozen explosion.
  private settleTransitionImmediately(): void {
    // An export can land mid-break, before the hold beat has built the gold.
    this.flushDeferredSeams();

    if (this.autoRepairAtMs !== null) {
      this.autoRepairAtMs = null;
      this.vesselState = "kintsugi";
    }

    this.transitionStartMs = null;
    this.revealAnchorMs = null;
    this.seamReveal = this.vesselState === "kintsugi" ? 1 : 0;
    this.applySeamReveal();
  }

  private transitionElapsedSecondsAt(nowMs: number): number {
    return this.transitionStartMs === null
      ? Number.POSITIVE_INFINITY
      : (nowMs - this.transitionStartMs) / 1000;
  }

  private shardProgress(entry: ShardEntry, nowMs: number): number {
    const target = this.vesselState === "shattered" ? 1 : 0;
    const elapsed = this.transitionElapsedSecondsAt(nowMs);

    if (elapsed === Number.POSITIVE_INFINITY) {
      return target;
    }

    const delay = entry.source.scatter.delaySeconds;
    const duration =
      this.transitionDirection === "shattered"
        ? shatterDurationSeconds
        : repairDurationSeconds;
    const local = Math.min(1, Math.max(0, (elapsed - delay) / duration));

    if (this.transitionDirection === "shattered") {
      return settleEase(local);
    }

    return 1 - easeOutCubic(local);
  }

  private applyShardPoses(nowMs: number): void {
    const spreadWorld = (shatterSpread / 100) * 1.7;

    for (const entry of this.shardEntries) {
      const progress = this.shardProgress(entry, nowMs);
      const scatter = entry.source.scatter;
      const amplitude = spreadWorld * progress;

      entry.mesh.position.set(
        scatter.offsetX * amplitude,
        -vesselCenterY + scatter.offsetY * amplitude,
        scatter.offsetZ * amplitude,
      );
      entry.mesh.quaternion.setFromAxisAngle(
        axisVector.set(scatter.axisX, scatter.axisY, scatter.axisZ).normalize(),
        scatter.angleRad * progress * (0.35 + spreadWorld),
      );
    }
  }

  // Where the front has to start and finish for "no gold at 0, every vein settled
  // at 1" to hold exactly.
  //
  // This used to be the worst case: -band-leadMax to revealMax+band+leadMax. Both
  // ends were far looser than the geometry needs, and the slack is dead time —
  // the front crossing reveal coordinates no vertex occupies. The end was the
  // worse of the two. Gravity runs downhill veins first, so at the rim (the
  // highest, last-arriving gold, and the moment the eye is on) the lead is
  // strongly NEGATIVE, while the worst case padded as if it were +leadMax. The
  // pour therefore finished its visible work with a quarter of the sweep still to
  // travel, and the ease spent its whole slow landing out there on nothing —
  // which is exactly why the rim looked like it stopped dead.
  //
  // So measure it instead. Per vertex the shader fills over front in
  // [aReveal + lead, aReveal + lead + band], with lead = clamp(wander + gravity).
  // Gravity is deterministic and reproduced exactly here; wander is value noise
  // bounded by +/- uWanderAmount/2, so bounding it is tight and safe. Only
  // vertices that can actually be rasterised count: a fragment exists only inside
  // a triangle with at least one non-negative coverage, and it interpolates
  // aReveal, so every triangle touching rendered gold contributes all three of its
  // vertices and the bound stays conservative.
  private computeFrontSchedule(source: SeamGeometrySource): void {
    const { coverages, index, offsets, positions, reveals } = source;
    const rendered = new Uint8Array(reveals.length);

    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = index[t];
      const b = index[t + 1];
      const c = index[t + 2];

      if (coverages[a] >= 0 || coverages[b] >= 0 || coverages[c] >= 0) {
        rendered[a] = 1;
        rendered[b] = 1;
        rendered[c] = 1;
      }
    }

    const band = this.goldRevealBand.value;
    const leadMax = this.goldLeadMax.value;
    const wanderHalf = this.goldWanderAmount.value * 0.5;
    const bias = this.goldGravityBias.value;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < reveals.length; i += 1) {
      if (!rendered[i]) {
        continue;
      }

      // The shader samples the noise on the centerline, not the displaced vertex.
      const spineY = positions[i * 3 + 1] - offsets[i * 3 + 1];
      const gravity = -(spineY - vesselCenterY) * bias;
      const lo = Math.max(-leadMax, Math.min(leadMax, gravity - wanderHalf));
      const hi = Math.max(-leadMax, Math.min(leadMax, gravity + wanderHalf));

      first = Math.min(first, reveals[i] + lo);
      last = Math.max(last, reveals[i] + hi);
    }

    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      this.seamFrontStart = -band - leadMax;
      this.seamFrontEnd = this.seamRevealMax + band + leadMax;

      for (let j = 0; j < this.seamFrontTable.length; j += 1) {
        const u = j / (this.seamFrontTable.length - 1);

        this.seamFrontTable[j] =
          this.seamFrontStart + u * (this.seamFrontEnd - this.seamFrontStart);
      }

      return;
    }

    this.seamFrontStart = first;
    this.seamFrontEnd = last + band;

    // Tight bounds are still not enough on their own, because the front moving at
    // a constant rate through SPACE does not put gold on screen at a constant
    // rate. The crack network is not evenly distributed along its own reveal
    // coordinate: a couple of straggler tips reach much further than the bulk, so
    // the last stretch of the sweep is nearly empty. Decelerating into that empty
    // stretch is what reads as the pour stopping dead at the rim — the eased
    // landing happens after the last gold has already arrived.
    //
    // So schedule the front by gold instead of by distance. The fraction of gold
    // settled at front f is the mean over rendered vertices of
    // clamp((f - (aReveal + lead)) / band, 0, 1); its derivative is a box of width
    // band centred on each vertex's fill, smeared by the wander it may take. Bin
    // those boxes, integrate, and invert, and equal steps in seamReveal become
    // equal amounts of gold appearing. The front then hurries through the empty
    // stretches on its own and the ease lands on the last vein.
    const span = this.seamFrontEnd - this.seamFrontStart;

    if (span <= 0) {
      this.seamFrontTable.fill(this.seamFrontEnd);

      return;
    }

    const binCount = 256;
    const density = new Float64Array(binCount);
    // Width of one vertex's contribution: the reveal band it fills across, plus
    // the wander slack either side. Chosen so the integral is exactly 0 at
    // seamFrontStart and exactly 1 at seamFrontEnd — no endpoint fudging.
    const boxWidth = band + 2 * wanderHalf;

    for (let i = 0; i < reveals.length; i += 1) {
      if (!rendered[i]) {
        continue;
      }

      const spineY = positions[i * 3 + 1] - offsets[i * 3 + 1];
      const gravity = -(spineY - vesselCenterY) * bias;
      const centre = reveals[i] + Math.max(-leadMax, Math.min(leadMax, gravity));
      const lo = Math.max(0, ((centre - wanderHalf - this.seamFrontStart) / span) * binCount);
      const hi = Math.min(
        binCount,
        ((centre - wanderHalf + boxWidth - this.seamFrontStart) / span) * binCount,
      );

      if (hi <= lo) {
        continue;
      }

      // Area-correct partial bins, so a box narrower than a bin still lands
      // where it belongs instead of quantising to a spike.
      const weight = 1 / (hi - lo);

      for (let k = Math.floor(lo); k < Math.ceil(hi); k += 1) {
        density[k] += (Math.min(hi, k + 1) - Math.max(lo, k)) * weight;
      }
    }

    const cumulative = new Float64Array(binCount + 1);

    for (let k = 0; k < binCount; k += 1) {
      cumulative[k + 1] = cumulative[k] + density[k];
    }

    const total = cumulative[binCount];
    const steps = this.seamFrontTable.length - 1;

    if (total <= 0) {
      for (let j = 0; j <= steps; j += 1) {
        this.seamFrontTable[j] = this.seamFrontStart + (j / steps) * span;
      }

      return;
    }

    let bin = 0;

    for (let j = 0; j <= steps; j += 1) {
      const u = j / steps;
      const wanted = u * total;

      while (bin < binCount - 1 && cumulative[bin + 1] < wanted) {
        bin += 1;
      }

      const lo = cumulative[bin];
      const hi = cumulative[bin + 1];
      const withinBin = hi > lo ? (wanted - lo) / (hi - lo) : 0;
      const scheduled = (bin + withinBin) / binCount;
      // Full warping tracks gold arrival exactly but lets the front lurch through
      // sparse stretches; holding some of the linear sweep keeps it reading as one
      // travelling wave rather than a series of jumps.
      const eased = u + (scheduled - u) * frontScheduleWarp;

      this.seamFrontTable[j] = this.seamFrontStart + eased * span;
    }
  }

  private applySeamReveal(): void {
    if (!this.seamGeometry) {
      return;
    }

    // Sweep the flowing front across exactly the span the gold occupies, paced so
    // that equal steps put equal amounts of gold on screen — the pour curve's slow
    // landing then lands on the last vein rather than past it.
    const steps = this.seamFrontTable.length - 1;
    const at = Math.min(1, Math.max(0, this.seamReveal)) * steps;
    const cell = Math.min(steps - 1, Math.floor(at));
    const withinCell = at - cell;

    this.goldFront.value =
      this.seamFrontTable[cell] +
      (this.seamFrontTable[cell + 1] - this.seamFrontTable[cell]) * withinCell;

    if (this.seamMesh) {
      this.seamMesh.visible = this.seamReveal > 0.001;
    }
  }

  private applyVesselPose(turntableTimeSeconds: number): void {
    const yaw = this.settings.autoRotate
      ? turntableYaw(turntableTimeSeconds / turntableLoopSeconds, this.settings.easing)
      : 0;

    this.vesselPivot.rotation.set(
      (this.settings.rotXDeg * Math.PI) / 180,
      (this.settings.rotYDeg * Math.PI) / 180 + yaw,
      (this.settings.rotZDeg * Math.PI) / 180,
      "XYZ",
    );
  }

  private tick(nowMs: number): void {
    if (this.disposed) {
      return;
    }

    this.animationFrame = requestAnimationFrame(this.tick);

    const previousTickMs = this.lastTickMs;

    if (this.exporting) {
      this.lastTickMs = nowMs;
      return;
    }

    this.lastTickMs = nowMs;

    const suspended = nowMs < this.suspendedUntilMs;

    if (suspended) {
      // Viewport pan/zoom moves the canvas with CSS transforms; freeze
      // animation work and keep the last rendered frame.
      return;
    }

    // The turntable runs on its own wall clock rather than an external
    // transport, wrapping at the loop period so the yaw math stays in 0..1.
    if (this.settings.autoRotate && previousTickMs !== null) {
      const elapsedSeconds = Math.min(
        maxTurntableStepSeconds,
        Math.max(0, (nowMs - previousTickMs) / 1000),
      );

      this.turntableTimeSeconds =
        (this.turntableTimeSeconds + elapsedSeconds) % turntableLoopSeconds;
    }

    if (this.environmentDirty) {
      this.environmentDirty = false;
      this.rebuildEnvironments();
      this.needsRender = true;
    }

    if (this.fractureDirty) {
      this.fractureDirty = false;
      this.seamDirty = false;
      this.rebuildFracture();
      this.needsRender = true;
    } else if (this.seamDirty) {
      this.seamDirty = false;
      this.rebuildSeams();
      this.needsRender = true;
    }

    // Once the shards have stopped flying, the scene is momentarily static --
    // the one window where the deferred gold can be built unseen.
    if (
      this.seamsDeferred &&
      this.transitionElapsedSecondsAt(nowMs) > shatterDurationSeconds
    ) {
      this.flushDeferredSeams();
    }

    // The vessel repairs itself: once the break has flown apart and held its
    // beat, the return journey starts on its own, with no second input.
    if (this.autoRepairAtMs !== null && nowMs >= this.autoRepairAtMs) {
      this.autoRepairAtMs = null;
      this.vesselState = "kintsugi";
      this.transitionDirection = "kintsugi";
      this.transitionStartMs = nowMs;
      this.revealAnchorMs = null;
    }

    // Transitions and the seam reveal advance on wall-clock time so they
    // finish on schedule even when software rasterization drops the frame
    // rate.
    let transitionActive = false;
    const transitionElapsed = this.transitionElapsedSecondsAt(nowMs);

    if (transitionElapsed !== Number.POSITIVE_INFINITY) {
      transitionActive = true;

      const longestDuration =
        (this.transitionDirection === "shattered"
          ? shatterDurationSeconds
          : repairDurationSeconds) + 0.25;

      if (transitionElapsed > longestDuration) {
        this.transitionStartMs = null;
      }
    }

    const revealTarget = this.vesselState === "kintsugi" ? 1 : 0;
    const revealGateOpen =
      this.vesselState !== "kintsugi" ||
      this.transitionStartMs === null ||
      transitionElapsed > repairDurationSeconds * 0.85;
    let revealChanged = false;

    if (revealGateOpen && this.seamReveal !== revealTarget) {
      if (this.revealAnchorMs === null) {
        this.revealAnchorMs = nowMs;
        this.revealAnchorValue = this.seamReveal;
      }

      const revealDuration =
        revealTarget > this.revealAnchorValue
          ? seamRevealDurationSeconds
          : seamHideDurationSeconds;
      const revealProgress = Math.min(
        1,
        (nowMs - this.revealAnchorMs) / 1000 / revealDuration,
      );
      // The pour curve shapes the fill only. Hiding is a 0.3s cleanup on the
      // way to a fresh strike, not a performance, so it stays linear.
      const revealEased =
        revealTarget > this.revealAnchorValue ? pourEase(revealProgress) : revealProgress;

      this.seamReveal =
        this.revealAnchorValue + (revealTarget - this.revealAnchorValue) * revealEased;
      revealChanged = true;

      if (this.seamReveal === revealTarget) {
        this.revealAnchorMs = null;
      }
    }


    const yawNow = this.settings.autoRotate
      ? turntableYaw(this.turntableTimeSeconds / turntableLoopSeconds, this.settings.easing)
      : 0;
    const yawChanged = yawNow !== this.lastRenderedYaw;

    this.controls.update();

    if (!this.needsRender && !transitionActive && !revealChanged && !yawChanged) {
      return;
    }

    this.needsRender = false;
    this.lastRenderedYaw = yawNow;
    this.applyVesselPose(this.turntableTimeSeconds);
    this.applyShardPoses(nowMs);

    if (revealChanged) {
      this.applySeamReveal();
    }

    this.scene.background = this.settings.includeBackground
      ? backgroundColor.set(this.settings.background)
      : null;
    this.renderer.render(this.scene, this.camera);
  }
}

const axisVector = new THREE.Vector3();
const backgroundColor = new THREE.Color();
const pointerNdc = new THREE.Vector2();

// TWO unwraps are baked per shard and each preset picks one, because the two
// have opposite strengths and no single map has both (a bowl has Gaussian
// curvature, so nothing flattens it without loss):
//
//   uv  (channel 0) — DISC. Uniform feature size everywhere. This is the
//       default and what marble/speckled/terrazzo use: what matters for those
//       is that a chip stays chip-sized from rim to base.
//   uv1 (channel 1) — CONFORMAL CYLINDRICAL. Level rings, at the cost of the
//       pattern scaling down toward the pole. Only glazed-ceramic uses it,
//       because that material's identity is a horizontal pour band, and a band
//       has to ring the bowl or it isn't a band.
//
// Both are baked from object-space position at build, so they stay locked to the
// vessel as it rotates and the shards scatter, and both go through Three's
// standard UV pipeline — one texture sample per pixel, no projection blending,
// so neither can produce the "two materials ghosting" that biplanar gave.
const glazeArcRadius = 1.02; // inner profile arc radius (the interior is seen)
const glazeRimPhi = Math.asin(0.952 / glazeArcRadius); // rim arc angle

// Meridian parameter 0 (pole) -> 1 (rim) from the arc angle (~arc length).
function glazeMeridianParam(rho: number): number {
  const phi = Math.asin(Math.min(1, rho / glazeArcRadius));

  return glazeRimPhi > 0 ? phi / glazeRimPhi : 0;
}

// --- Disc unwrap (channel 0) ------------------------------------------------
// The bowl is a topological disc, so flatten it to a disc in texture space with
// the bottom POLE at the disc CENTER — a single point, not the collapsed edge a
// cylindrical map leaves there. u,v = polar(theta, meridian arc), which keeps
// feature SIZE uniform: the only distortion is the azimuthal-equidistant
// phi/sin(phi) term, exactly 1.0 at the pole and ~1.4 at the rim, and at the rim
// that is a mild squash on a curving surface rather than a smear. No pinch, no
// seam. A directional pattern reads radial about the center, like a lathe-turned
// piece, which is why the one preset built around a level band can't use this.
const glazeDiscScale = 3.0; // texture tiles from center to rim
// Spins the whole disc pattern about the bowl's axis, in radians. It cannot fix
// anything: under this unwrap the
// texture's orientation relative to the surface EQUALS the azimuth, so a band
// reads level on two opposite quadrants and vertical on the two 90 degrees away.
// Adding a constant here just rotates which quadrants are which — the good and
// bad ones stay a quarter turn apart, because that difference is what a constant
// cannot change. Baked in rather than done with texture.rotation so it does not
// interact with the re-centering offset in glazeUvTransform.
const glazeDiscRotation = 0;

function discUnwrapUvs(positions: ArrayLike<number>): Float32Array {
  const uvs = new Float32Array((positions.length / 3) * 2);

  for (let index = 0, uv = 0; index < positions.length; index += 3, uv += 2) {
    const x = positions[index];
    const z = positions[index + 2];
    const theta = Math.atan2(z, x) + glazeDiscRotation;
    const r = glazeMeridianParam(Math.hypot(x, z)) * glazeDiscScale;

    uvs[uv] = 0.5 + r * Math.cos(theta);
    uvs[uv + 1] = 0.5 + r * Math.sin(theta);
  }

  return uvs;
}

// --- Conformal cylindrical unwrap (channel 1) -------------------------------
// u follows the angle around the bowl and v follows height, so a horizontal band
// in a texture lands as a LEVEL RING.
//
// The reason a plain (angle, height) unwrap failed is that u = theta is
// radius-independent: one u tile spans 2*PI*rho world units, which collapses
// toward the pole while v keeps a fixed world scale, so texels get squeezed
// circumferentially (4:1 by the foot) and the pattern smears radially. The fix
// is to stop measuring v in arc length and measure it in TILES instead, letting
// dv track du: this is the Mercator construction, and it makes the map
// conformal — texel aspect is exactly 1:1 everywhere, no shear, no stretch, at
// any height.
//
// Conformality trades the shear for SCALE: the pattern gets finer toward the
// bottom center in proportion to rho (about 4x finer at the foot than at the
// rim), because that is how much less circumference there is to wrap around.
// That trade is only worth taking for a material whose whole identity is the
// band, which is why this channel is opt-in per preset rather than the default.
// The shrink is logarithmic, so it stays gentle until the last few percent of
// the radius, where glazePoleRadius freezes it: every point inside that (a disc
// 3% of the bowl radius, at the dead center of the base, behind the foot ring)
// shares one v. That residual pinch is the coordinate singularity every
// cylindrical map has, parked where nothing sees it.
const glazePoleRadius = 0.03; // freeze the mapping inside this radius
// Texture repeats around the full circumference. INTEGER on purpose: shards are
// unwrapped triangle-locally (below), so two triangles either side of atan2's
// branch cut get u values a full revolution apart, and only a whole number of
// repeats lets the texture still line up across that edge.
const glazeTilesAround = 6;
// The `tiling` that glazeTilesAround was chosen for: at 1.25 one tile spans
// ~0.98 world units at the rim, which is the pottery-glaze swatch at roughly its
// own scale. Cylindrical presets scale relative to this.
const glazeReferenceTiling = 1.25;

const glazeRimHalfTan = Math.tan(glazeRimPhi / 2);
const glazePolePhi = Math.asin(glazePoleRadius / glazeArcRadius);
const glazeUPerRadian = glazeTilesAround / (2 * Math.PI);

// How the vertical law is chosen, 1 = conformal (shipping) to 0 = equidistant.
//
// The HORIZONTAL scale on the wall is N / (2*PI*rho) and there is nothing here
// that can touch it: N has to be a whole number or the texture does not close up
// going around, and rho is the bowl's own radius. So the 4.28x compression from
// rim to base edge is geometry, not a setting. The only real choice is whether v
// follows that compression or not, and this dial is that choice:
//   1 — v shrinks in lockstep with u. Texels stay exactly square at every
//       height (zero shear); the pattern just gets uniformly smaller toward the
//       base. This is Mercator, and it is what ships.
//   0 — v keeps a constant world scale. Nothing shrinks vertically, so the
//       horizontal compression now shows up as SHEAR instead: 4.28:1 at the base
//       edge, i.e. the pattern arrives smeared sideways. This is the naive
//       arc-length cylindrical that was built and rejected earlier.
// Anything between splits the loss across both. Both endpoints pin v = 0 at the
// rim and agree on the derivative there, so the blend is continuous and the rim
// scale is identical whatever this is set to.
const glazeConformality = 1;

// --- Ring cut (a second island on the wall) ---------------------------------
// The compression above is N / (2*PI*rho) with N a whole number, and N only has
// to be whole WITHIN ONE ISLAND. Cutting the wall on a ring lets everything
// below the cut wrap glazeRingCutRatio times less often, which resets the
// compression partway down instead of letting it run unbroken to the foot. This
// is the horizontal seam a modeller cuts into a vase to keep texel density even,
// and it is the only thing a hand unwrap can do here that the single-island map
// cannot. Rim-to-foot goes 4.28x -> 2.14x at ratio 2, with at most ~2.1x drift
// inside either island.
//
// It is NOT free, and the cost is bigger than just u. Each island is conformal
// in its own right, so v scales by the ratio too and texels stay square — which
// means the whole pattern, INCLUDING the pour band's thickness, steps by the
// ratio as you cross the ring. The trade is one visible step in place of a
// continuous gradient, so the cut has to go BELOW the pour band, which measures
// out at rho 0.681 (61% of the meridian arc up from the pole). 0.46 is both
// clear of it and the balance point sqrt(rimRho * footRho), which leaves either
// island carrying an equal 2.07x. 0.6 was the first guess and it is wrong — it
// puts the seam directly under the band and the render shows it.
//
// Above the cut nothing changes at all, so the band does not move; a cut placed
// ABOVE it would magnify about the cut line and push it down and thicker.
//
// 0 disables it and restores the single-island map that ships.
const glazeRingCutRadius = 0;
const glazeRingCutRatio = 2;

// Height in tiles, 0 at the rim and negative below it. Conformality wants the
// world distance per unit v to match the world distance per unit u at the same
// radius, i.e. dv = du_scale * ds / (2*PI*rho); with rho = R*sin(phi) and
// ds = R*d(phi) that integrates to the classic log(tan(phi / 2)). The
// equidistant alternative is plain arc length in rim-sized tiles.
function glazeMeridianTiles(rho: number): number {
  const phi = Math.max(glazePolePhi, Math.asin(Math.min(1, rho / glazeArcRadius)));
  const conformal = Math.log(Math.tan(phi / 2) / glazeRimHalfTan);
  const equidistant = (phi - glazeRimPhi) / Math.sin(glazeRimPhi);

  return (
    glazeUPerRadian *
    (conformal * glazeConformality + equidistant * (1 - glazeConformality))
  );
}

// Where the cut sits in the outer island's tiles, so the inner one can be
// rescaled about that value and stay joined to it.
const glazeRingCutTiles =
  glazeRingCutRadius > 0 ? glazeMeridianTiles(glazeRingCutRadius) : 0;

// Shard meshes are non-indexed triangle soup, so each triangle is unwrapped
// around its own first corner: theta for the other two corners is taken as the
// nearest branch to that reference rather than raw atan2. A triangle is far
// smaller than a half-turn, so this can never wrap the wrong way, and it means
// no triangle ever straddles the branch cut with u running backwards through the
// whole texture — which is what turned the back seam into a bright band when the
// normal map's tangent frame (derived from UV screen derivatives) blew up there.
function cylindricalUnwrapUvs(positions: ArrayLike<number>): Float32Array {
  const uvs = new Float32Array((positions.length / 3) * 2);

  for (let triangle = 0; triangle < positions.length; triangle += 9) {
    const reference = Math.atan2(positions[triangle + 2], positions[triangle]);
    // Which island this triangle belongs to is decided ONCE for the triangle,
    // from its centroid, never per vertex: a triangle straddling the cut would
    // otherwise smear the entire scale step across its own face. Deciding it per
    // face puts the step on triangle edges instead, which is what a seam in a
    // hand unwrap actually is — a ragged one here, since the shards are not
    // retopologised to follow the ring.
    const centroidX = (positions[triangle] + positions[triangle + 3] + positions[triangle + 6]) / 3;
    const centroidZ =
      (positions[triangle + 2] + positions[triangle + 5] + positions[triangle + 8]) / 3;
    const inner =
      glazeRingCutRadius > 0 && Math.hypot(centroidX, centroidZ) < glazeRingCutRadius;
    // One factor drives both axes, which is what keeps the inner island
    // conformal in its own right rather than merely coarser across.
    const scale = inner ? 1 / glazeRingCutRatio : 1;

    for (let index = triangle; index < triangle + 9; index += 3) {
      const x = positions[index];
      const z = positions[index + 2];
      const delta = Math.atan2(z, x) - reference;
      const theta = reference + delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI));
      const uv = (index / 3) * 2;
      const tiles = glazeMeridianTiles(Math.hypot(x, z));

      uvs[uv] = theta * glazeUPerRadian * scale;
      uvs[uv + 1] = inner
        ? glazeRingCutTiles + (tiles - glazeRingCutTiles) * scale
        : tiles;
    }
  }

  return uvs;
}

function stopEventPropagation(event: Event): void {
  event.stopPropagation();
}

let activeSceneManager: KintsugiSceneManager | null = null;

export function setActiveKintsugiScene(manager: KintsugiSceneManager | null): void {
  activeSceneManager = manager;
}

export function getActiveKintsugiScene(): KintsugiSceneManager | null {
  return activeSceneManager;
}
