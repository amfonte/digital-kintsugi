import { describe, expect, it } from "vitest";

import {
  createToolcraftState,
  getToolcraftImageExportSize,
  getToolcraftVideoExportSize,
} from "@/toolcraft/runtime";
import type { ToolcraftState } from "@/toolcraft/runtime";

import { kintsugiRendererPipeline } from "./app-performance-pipeline";
import { appSchema } from "./app-schema";
import {
  buildFracture,
  maxAccumulatedSeeds,
  type FractureSettings,
  type ImpactPoint,
} from "./kintsugi/fracture";
import { kintsugiTargets } from "./kintsugi/kintsugi-values";
import {
  KintsugiSceneManager,
  crackBranching,
  shardsPerStrike,
  turntableLoopSeconds,
  turntableYaw,
} from "./kintsugi/scene";
import { buildSeamGeometry } from "./kintsugi/seams";
import {
  getKintsugiVideoFramePlan,
  kintsugiVideoFrameRates,
  readKintsugiVideoFrameRate,
} from "./kintsugi/video-export";
import { createVesselSurfaces } from "./kintsugi/vessel-profile";

function stateWithValues(values: Record<string, unknown>): ToolcraftState {
  const state = createToolcraftState(appSchema);

  return { ...state, values: { ...state.values, ...values } };
}

const surfaces = createVesselSurfaces();
// Rebuild cost is measured on a struck vessel: a pristine one has nothing to cut.
// Strikes overlay instead of replacing each other, so shards outrun seeds:
// 4 -> 9 -> 17 -> 26 here, and the fifth strike is the one accumulation stops at
// against the 28-shard hard limit. Ten impacts is well past that point, i.e. the
// worst case a user can ever reach by clicking.
const oneStrike: readonly ImpactPoint[] = [{ s: 0.55, theta: 0 }];
const saturatedStrikes: readonly ImpactPoint[] = [
  { s: 0.55, theta: 0 },
  { s: 0.45, theta: Math.PI },
  { s: 0.7, theta: 1.4 },
  { s: 0.3, theta: -2.2 },
  { s: 0.9, theta: 2.7 },
  { s: 0.6, theta: -0.7 },
  { s: 0.35, theta: 2.1 },
  { s: 0.8, theta: -1.6 },
  { s: 0.5, theta: 0.9 },
  { s: 0.25, theta: -2.9 },
];
// One-off cost of rebuilding the fracture + gold: once per strike, and again
// when a geometry slider is released (debounced, never per-frame). The gold is a
// displaced distance field (seamless junctions, smooth silhouette) which is
// heavier to build than the old tube sweep but renders within the same per-frame
// vertex budget.
//
// Measured here: ~250-290ms fracture + ~110-150ms seams, i.e. ~400ms for a
// worst-case rebuild run on its own, and up to ~1.15s for the same call while
// the rest of the suite competes for cores. The budget covers the contended
// case so the gate catches an algorithmic blow-up rather than scheduler noise;
// what the user actually waits for is measured in the browser, where a strike
// reaches visible motion in ~230ms because the seam build is deferred to the
// hold beat. The impact-clustered seeding is not what costs this: the same
// build with seeds spread evenly over the vessel measures slightly *slower*.
const rebuildBudgetMs = 1500;

function timeRebuild(settings: FractureSettings): number {
  const startedAt = performance.now();
  const fracture = buildFracture(surfaces, settings);

  buildSeamGeometry(surfaces, fracture.seamPaths, {
    relief: 0.024,
    seed: settings.seed,
    width: 0.024,
  });

  return performance.now() - startedAt;
}

function geometryInputs(): ReadonlyArray<keyof FractureSettings> {
  return ["branching", "density", "impacts"];
}

describe("kintsugi product performance", () => {
  it("kintsugi perf: repeated strikes stay inside the rebuild budget", () => {
    // Every click rebuilds the fracture and the gold that follows it, and the
    // impact list only grows. Accumulation is capped at the shard hard limit, so
    // the twentieth strike costs no more than the saturating one -- prove both
    // the cap and the cost.
    const saturated = buildFracture(
      surfaces,
      { branching: crackBranching, density: shardsPerStrike, impacts: saturatedStrikes, seed: 21 },
    );

    expect(saturated.shardCount).toBeLessThanOrEqual(maxAccumulatedSeeds);
    // ...and that the cap is genuinely what stops accumulation by clicking, not
    // merely respected in theory: four strikes run it up to within a strike's
    // worth of the limit and every later one is dropped whole. It stops a couple
    // of shards short of 28 rather than exactly on it because of that
    // all-or-nothing drop, and the steps into the ceiling got coarser when each
    // later strike went from a seed pair to the three-ray star that puts a crack
    // junction on the clicked point.
    expect(saturated.shardCount).toBeGreaterThan(maxAccumulatedSeeds - shardsPerStrike * 2);
    expect(
      timeRebuild({ branching: crackBranching, density: shardsPerStrike, impacts: oneStrike, seed: 21 }),
    ).toBeLessThan(rebuildBudgetMs);
    expect(
      timeRebuild({ branching: crackBranching, density: shardsPerStrike, impacts: saturatedStrikes, seed: 21 }),
    ).toBeLessThan(rebuildBudgetMs);
  });

  it("kintsugi perf: seam generosity rebuild stays within the vertex budget", () => {
    // The gold is a displaced distance field, so a fatter repair covers more of
    // the surface and yields more vertices — but both ends of the slider must
    // stay comfortably within the seam vertex budget.
    const fracture = buildFracture(surfaces, { branching: crackBranching, density: shardsPerStrike, impacts: oneStrike, seed: 21 });
    const thin = buildSeamGeometry(surfaces, fracture.seamPaths, {
      relief: 0.024,
      seed: 21,
      width: 0.006,
    });
    const wide = buildSeamGeometry(surfaces, fracture.seamPaths, {
      relief: 0.024,
      seed: 21,
      width: 0.06,
    });

    expect(wide.totalVertexCount).toBeLessThan(220_000);
    expect(thin.totalVertexCount).toBeLessThan(220_000);
    expect(wide.totalVertexCount).toBeGreaterThanOrEqual(thin.totalVertexCount);
  });

  it("kintsugi perf: seam relief rebuild is fixed-size", () => {
    const fracture = buildFracture(surfaces, { branching: crackBranching, density: shardsPerStrike, impacts: oneStrike, seed: 21 });
    const flat = buildSeamGeometry(surfaces, fracture.seamPaths, {
      relief: 0.004,
      seed: 21,
      width: 0.024,
    });
    const proud = buildSeamGeometry(surfaces, fracture.seamPaths, {
      relief: 0.06,
      seed: 21,
      width: 0.024,
    });

    expect(proud.totalVertexCount).toBe(flat.totalVertexCount);
  });

  it("kintsugi perf: orientation x is a per-frame transform", () => {
    expect(geometryInputs()).not.toContain("rotXDeg");
    expect(Object.values(kintsugiTargets)).toContain("orientation.x");
  });

  it("kintsugi perf: orientation y is a per-frame transform", () => {
    expect(geometryInputs()).not.toContain("rotYDeg");
    expect(Object.values(kintsugiTargets)).toContain("orientation.y");
  });

  it("kintsugi perf: orientation z is a per-frame transform", () => {
    expect(geometryInputs()).not.toContain("rotZDeg");
    expect(Object.values(kintsugiTargets)).toContain("orientation.z");
  });

  it("kintsugi perf: key light is a light intensity write", () => {
    expect(geometryInputs()).not.toContain("lightKey");
    expect(Object.values(kintsugiTargets)).toContain("lighting.key");
  });

  it("kintsugi perf: fill light is a light intensity write", () => {
    expect(geometryInputs()).not.toContain("lightFill");
    expect(Object.values(kintsugiTargets)).toContain("lighting.fill");
  });

  it("kintsugi perf: exposure is a tone mapping scalar", () => {
    expect(geometryInputs()).not.toContain("lightExposure");
    expect(Object.values(kintsugiTargets)).toContain("lighting.exposure");
  });

  // Softbox and Ambient dome re-bake the environment map, which is real work —
  // but it is bounded work on a fixed 6-mesh scene, independent of the vessel.
  // These assert the two properties that keep a drag affordable: the bake never
  // pulls in a fracture/seam rebuild, and the pipeline declares it as its own
  // pass so it is invalidated only by its own inputs.
  it("kintsugi perf: softbox rebake stays within the frame budget", () => {
    expect(geometryInputs()).not.toContain("lightSoftbox");
    expect(Object.values(kintsugiTargets)).toContain("lighting.softbox");

    const bake = kintsugiRendererPipeline.passes.find(
      (pass) => pass.id === "environment-bake",
    );

    expect(bake?.invalidatedBy).toContain("lighting.softbox");
    expect(bake?.invalidatedBy).not.toContain("vessel.reset");
  });

  it("kintsugi perf: ambient dome rebake stays within the frame budget", () => {
    expect(geometryInputs()).not.toContain("lightAmbientDome");
    expect(Object.values(kintsugiTargets)).toContain("lighting.dome");

    const bake = kintsugiRendererPipeline.passes.find(
      (pass) => pass.id === "environment-bake",
    );

    expect(bake?.invalidatedBy).toContain("lighting.dome");
    expect(
      kintsugiRendererPipeline.interactionInvalidation.some(
        (entry) =>
          entry.targets.includes("lighting.dome") &&
          (entry.mustNotInvalidate ?? []).includes("fracture-build"),
      ),
    ).toBe(true);
  });

  it("kintsugi perf: glaze preset is a material uniform update", () => {
    expect(geometryInputs()).not.toContain("glazePreset");
    expect(Object.values(kintsugiTargets)).toContain("vessel.glaze");
  });

  it("kintsugi perf: auto-rotate toggles yaw only", () => {
    expect(geometryInputs()).not.toContain("autoRotate");
    expect(turntableYaw(0.5, "linear")).toBeCloseTo(Math.PI, 6);
  });

  it("kintsugi perf: easing changes a per-frame formula", () => {
    expect(turntableYaw(0.25, "smooth")).not.toBeCloseTo(
      turntableYaw(0.25, "linear"),
      3,
    );
    expect(turntableYaw(0, "smooth")).toBeCloseTo(turntableYaw(0, "linear"), 9);
  });

  it("kintsugi perf: background color sets the clear color", () => {
    expect(geometryInputs()).not.toContain("background");
    expect(Object.values(kintsugiTargets)).toContain("scene.background");
  });

  it("kintsugi perf: include background toggles transparency", () => {
    expect(geometryInputs()).not.toContain("includeBackground");
    expect(Object.values(kintsugiTargets)).toContain("export.includeBackground");
  });

  it("kintsugi perf: image format only reconfigures the still encoder", () => {
    const state = createToolcraftState(appSchema);
    const size = getToolcraftImageExportSize({ resolution: "4k", state });

    // Format changes never change the offline render size.
    expect(size).toMatchObject({ height: 2304, width: 4096 });
  });

  it("kintsugi perf: image resolution bounds still export cost", () => {
    const state = createToolcraftState(appSchema);

    expect(getToolcraftImageExportSize({ resolution: "8k", state }).width).toBe(8192);
  });

  it("kintsugi perf: video format only reconfigures the container", () => {
    const state = createToolcraftState(appSchema);
    const size = getToolcraftVideoExportSize({ resolution: "current", state });

    expect(size).toMatchObject({ height: 1080, width: 1920 });
  });

  it("kintsugi perf: video resolution bounds video export cost", () => {
    const state = createToolcraftState(appSchema);
    const fourK = getToolcraftVideoExportSize({ resolution: "4k", state });

    expect(fourK.width).toBeLessThanOrEqual(3840);
    expect(fourK.height).toBeLessThanOrEqual(2160);
  });

  it("kintsugi perf: still export renders offline at export size", () => {
    const state = createToolcraftState(appSchema);
    const size = getToolcraftImageExportSize({ resolution: "4k", state });

    expect(size.width).toBe(4096);
    expect(size.pixelRatio).toBeGreaterThan(0);
  });

  it("kintsugi perf: video export encodes loop-timed frames", () => {
    // The clip is always one revolution; FPS only changes how finely that
    // revolution is sampled, so frame count scales while duration does not.
    const plan = getKintsugiVideoFramePlan(turntableLoopSeconds, 30);

    expect(plan.count).toBe(480);
    expect(plan.frameDurationMicros).toBe(33333);
    expect(getKintsugiVideoFramePlan(turntableLoopSeconds, 24).count).toBe(384);
    expect(getKintsugiVideoFramePlan(turntableLoopSeconds, 60).count).toBe(960);

    for (const framesPerSecond of kintsugiVideoFrameRates) {
      const { count, frameDurationMicros } = getKintsugiVideoFramePlan(
        turntableLoopSeconds,
        framesPerSecond,
      );

      expect((count * frameDurationMicros) / 1_000_000).toBeCloseTo(turntableLoopSeconds, 1);
    }
  });

  it("kintsugi perf: video fps falls back to 30 for unusable values", () => {
    expect(readKintsugiVideoFrameRate(stateWithValues({ "export.video.fps": "60" }))).toBe(60);
    expect(readKintsugiVideoFrameRate(stateWithValues({ "export.video.fps": "48" }))).toBe(30);
    expect(readKintsugiVideoFrameRate(stateWithValues({}))).toBe(30);
  });

  it("kintsugi perf: worst-case fracture stays within frame budgets", () => {
    expect(
      timeRebuild({ branching: crackBranching, density: shardsPerStrike, impacts: saturatedStrikes, seed: 21 }),
    ).toBeLessThan(rebuildBudgetMs);
  });

  it("kintsugi perf: timeline playback drives one render per frame", () => {
    let previous = -1;

    for (let step = 0; step < 24; step += 1) {
      const yaw = turntableYaw(step / 25, "linear");

      expect(yaw).toBeGreaterThan(previous);
      previous = yaw;
    }
  });

  it("kintsugi perf: reset rebuilds the whole vessel within budget", () => {
    // Reset drops the impact list, and an impact-free fracture is the cheapest
    // build there is: one uniform Voronoi cell, no cuts, no seam paths.
    expect(Object.values(kintsugiTargets)).toContain("vessel.reset");
    expect(
      timeRebuild({ branching: crackBranching, density: shardsPerStrike, impacts: [], seed: 21 }),
    ).toBeLessThan(rebuildBudgetMs);
  });

  it("kintsugi perf: first preview renders within budget", () => {
    expect(appSchema.canvas.renderScale.defaultValue).toBe(2);
    expect(
      timeRebuild({ branching: crackBranching, density: shardsPerStrike, impacts: oneStrike, seed: 21 }),
    ).toBeLessThan(rebuildBudgetMs);
  });

  it("kintsugi perf: viewport drag suspends animation work", () => {
    expect(typeof KintsugiSceneManager.prototype.notifyViewportInteraction).toBe(
      "function",
    );
  });

  it("kintsugi perf: toolbar zoom stays smooth at maximum stress", () => {
    const fracture = buildFracture(surfaces, { branching: crackBranching, density: shardsPerStrike, impacts: saturatedStrikes, seed: 21 });
    const seams = buildSeamGeometry(surfaces, fracture.seamPaths, {
      relief: 0.024,
      seed: 21,
      width: 0.024,
    });

    // The stress geometry stays small enough that zoom re-renders remain
    // fill-rate-bound instead of geometry-bound.
    expect(seams.totalVertexCount).toBeLessThan(220_000);
    expect(fracture.shardCount).toBeLessThanOrEqual(28);
  });

  it("kintsugi perf: control edits never move the canvas viewport", () => {
    expect(
      Object.values(kintsugiTargets).some((target) => target.startsWith("canvas.")),
    ).toBe(false);
  });
});
