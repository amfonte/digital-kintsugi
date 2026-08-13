import { describe, expect, it } from "vitest";

import {
  createToolcraftState,
  getToolcraftImageExportSize,
  getToolcraftVideoExportSize,
  shouldIncludeToolcraftPreviewBackground,
  type ToolcraftState,
} from "@/toolcraft/runtime";

import { appSchema } from "./app-schema";
import {
  buildFracture,
  maxAccumulatedSeeds,
  nearestSurfaceParam,
  type FractureResult,
  type FractureSettings,
  type ImpactPoint,
} from "./kintsugi/fracture";
import {
  defaultGlazePresetId,
  getGlazePreset,
  glazePickerItems,
} from "./kintsugi/glaze-library";
import { kintsugiTargets, readKintsugiSettings } from "./kintsugi/kintsugi-values";
import {
  crackBranching,
  shardsPerStrike,
  turntableLoopSeconds,
  turntableYaw,
} from "./kintsugi/scene";
import { buildSeamGeometry } from "./kintsugi/seams";
import { resolveStudioLighting, studioLightBaseIntensity } from "./kintsugi/stage";
import { createVesselSurfaces } from "./kintsugi/vessel-profile";

const surfaces = createVesselSurfaces();
// A vessel only cracks where it was struck, so every fracture in these tests
// needs at least one impact. This one sits on the front wall, mid-height.
const frontStrike: ImpactPoint = { s: 0.55, theta: 0 };
const backStrike: ImpactPoint = { s: 0.45, theta: Math.PI };

function struck(
  settings: Omit<FractureSettings, "impacts">,
  impacts: readonly ImpactPoint[] = [frontStrike],
): FractureSettings {
  return { ...settings, impacts };
}

function stateWithValues(values: Record<string, unknown>): ToolcraftState {
  const state = createToolcraftState(appSchema);

  return { ...state, values: { ...state.values, ...values } };
}

function seamSourceBounds(positions: Float32Array): number {
  let maxRadial = 0;

  for (let index = 0; index < positions.length; index += 3) {
    maxRadial = Math.max(
      maxRadial,
      Math.hypot(positions[index], positions[index + 2]),
    );
  }

  return maxRadial;
}

// Area of the VISIBLE gold only. The mesh is emitted a few rows past the field=0
// contour so the fragment shader can draw a smooth sub-cell silhouette; those
// outer triangles are then discarded (vCoverage < 0) and never rendered. Weight
// each triangle's area by the fraction of its vertices with coverage >= 0 so we
// measure the gold the viewer actually sees, not the discarded skirt (whose area
// scales with seam length, not generosity).
function seamTriangleArea(
  positions: Float32Array,
  index: Uint32Array,
  coverages?: Float32Array,
): number {
  let area = 0;

  for (let k = 0; k < index.length; k += 3) {
    const ia = index[k];
    const ib = index[k + 1];
    const ic = index[k + 2];
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const triArea =
      0.5 *
      Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);

    if (coverages) {
      const visible =
        ((coverages[ia] >= 0 ? 1 : 0) +
          (coverages[ib] >= 0 ? 1 : 0) +
          (coverages[ic] >= 0 ? 1 : 0)) /
        3;

      area += triArea * visible;
    } else {
      area += triArea;
    }
  }

  return area;
}

describe("kintsugi product acceptance", () => {
  it("kintsugi acceptance: glaze preset maps to the glaze material", () => {
    const settings = readKintsugiSettings(
      stateWithValues({ [kintsugiTargets.glaze]: "marble" }),
    );

    expect(settings.glazePreset).toBe("marble");
    expect(readKintsugiSettings(stateWithValues({})).glazePreset).toBe(
      defaultGlazePresetId,
    );
  });

  it("kintsugi acceptance: every glaze swatch resolves to a defined preset", () => {
    // The picker items and the material library must stay in lockstep: each
    // selectable swatch has to map to a real preset the scene can apply.
    for (const item of glazePickerItems) {
      expect(getGlazePreset(item.value).id).toBe(item.value);
    }
  });

  it("kintsugi acceptance: background color control commits a { hex } object", () => {
    // The Toolcraft color control commits its value as `{ hex }`, not a bare
    // string; the reader must unwrap it or the picked color silently falls back.
    expect(
      readKintsugiSettings(
        stateWithValues({ [kintsugiTargets.background]: { hex: "#101014" } }),
      ).background,
    ).toBe("#101014");
  });

  it("kintsugi acceptance: one strike opens a few readable pieces", () => {
    // Shard count per strike is baked, not exposed: a strike has to read as a
    // break with a handful of convincing pieces, and the whole point of baking
    // it was that higher counts shattered the bowl into confetti. Guard the
    // window the look depends on, and the branching share it is tuned against.
    const once = buildFracture(
      surfaces,
      struck({ branching: crackBranching, density: shardsPerStrike, seed: 21 }),
    );

    expect(shardsPerStrike).toBe(4);
    expect(once.shardCount).toBeGreaterThan(2);
    expect(once.shardCount).toBeLessThanOrEqual(shardsPerStrike);
    // Branching spends part of a strike's seed budget on forks instead of the
    // rosette ring; at this few shards the ring must keep the majority or the
    // radial star collapses into a single line.
    expect(crackBranching).toBeLessThan(50);
  });

  it("kintsugi acceptance: striking the bowl breaks it and gold repairs it", () => {
    const strike = (impacts: readonly ImpactPoint[]): FractureResult =>
      buildFracture(surfaces, struck({ branching: crackBranching, density: shardsPerStrike, seed: 21 }, impacts));
    const worldDistance = (
      a: { s: number; theta: number },
      b: { s: number; theta: number },
    ): number => {
      const pa = surfaces.midpointAt(a.theta, a.s);
      const pb = surfaces.midpointAt(b.theta, b.s);

      return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
    };

    // Load state: whole vessel. One Voronoi seed means uniform ownership, so
    // there is nothing to cut and nothing for the gold to follow.
    const whole = strike([]);

    expect(whole.shardCount).toBe(1);
    expect(whole.seamPaths).toHaveLength(0);

    // First strike: cracks exist, and the point that was struck is a JUNCTION of
    // them -- not merely somewhere near one. This is the whole promise of
    // click-to-shatter, and the bar is deliberately tight because a loose one hid
    // the opposite behaviour for a while: seeding a cell centre on the impact
    // buried every click mid-shard with the cracks ringing it 0.11-0.21 world
    // units out, which read as each click producing arbitrary shards. Two
    // measurements pin it down.
    const once = strike([frontStrike]);
    const nearestToImpact = Math.min(
      ...once.seamPaths.flatMap((path) =>
        path.points.map((point) => worldDistance(point, frontStrike)),
      ),
    );
    // Runs that END at the strike, within one fracture grid cell (~0.031 world
    // units) of it -- the resolution the crack network is cut at, so it is the
    // floor on how exactly any junction can be placed.
    const runsMeetingAtImpact = once.seamPaths.filter((path) =>
      [path.points[0], path.points[path.points.length - 1]].some(
        (end) => worldDistance(end, frontStrike) < 0.031,
      ),
    );

    expect(once.shardCount).toBeGreaterThan(1);
    expect(once.seamPaths.length).toBeGreaterThan(0);
    // A crack passes through the click itself, a fifth of a grid cell away.
    expect(nearestToImpact).toBeLessThan(0.0062);
    // And three of them meet there, which is what makes it a junction rather than
    // a single crack line that happens to run across the clicked point.
    expect(runsMeetingAtImpact.length).toBeGreaterThanOrEqual(3);

    for (const path of runsMeetingAtImpact) {
      const startsAtImpact = worldDistance(path.points[0], frontStrike) < 0.031;

      // The seam builder has to agree it is a junction, because that is what
      // pools the gold wide where the cracks meet instead of tapering it off as
      // a dying tip.
      expect(startsAtImpact ? path.startKind : path.endKind).toBe("junction");
    }

    // The break beat itself: every shard flies outward far enough to read as a
    // shatter, and none of them launches out of frame before the gold pulls the
    // vessel back together.
    for (const shard of once.shards) {
      const radial = Math.hypot(shard.scatter.offsetX, shard.scatter.offsetZ);

      expect(radial).toBeGreaterThan(0.05);
      expect(Math.abs(shard.scatter.offsetY)).toBeLessThan(0.6);
    }

    // Second strike on the far side: damage accumulates into the same network
    // rather than replacing it. This is the property the whole overlay model
    // exists for, so assert it at full strength -- EVERY crack line the first
    // strike cut is still on the bowl afterwards, no matter how close the new
    // impact landed. Resolving one flat Voronoi diagram over the accumulated
    // seeds could not do this: a later seed that won a patch of surface took
    // the older boundaries inside that patch with it, silently erasing about a
    // third of the first strike's crack length. (Recorded here because that
    // failure was invisible to a survivorship check that only looked far away
    // from the new impact.)
    const twice = strike([frontStrike, backStrike]);
    const twicePoints = twice.seamPaths.flatMap((path) => path.points);
    const twiceKeys = new Set(
      twicePoints.map((point) => `${point.theta.toFixed(5)}:${point.s.toFixed(5)}`),
    );
    const oncePoints = once.seamPaths.flatMap((path) => path.points);
    // Most points come back byte-identical; the rest are the handful right at a
    // new junction, where the old crack bends a hair to meet the crack that now
    // runs into it. "A hair" is the bar: the fracture grid pitch is ~0.031 world
    // units, so nothing may move a quarter of one cell. (The bar was a fifth of a
    // cell while a later strike contributed a seed pair; a three-ray star cuts one
    // more line into the existing network, so one more old point gets bent to meet
    // a new junction. Still one cell corner's worth of movement, not a redraw.)
    const identical = oncePoints.filter((point) =>
      twiceKeys.has(`${point.theta.toFixed(5)}:${point.s.toFixed(5)}`),
    );
    const worstDrift = Math.max(
      ...oncePoints.map((point) =>
        Math.min(...twicePoints.map((candidate) => worldDistance(point, candidate))),
      ),
    );

    expect(twice.shardCount).toBeGreaterThan(once.shardCount);
    expect(oncePoints.length).toBeGreaterThan(100);
    expect(worstDrift).toBeLessThan(0.0078);
    // Recorded at 89.9%. It was 90.4% while a later strike contributed a seed
    // pair: a three-ray star cuts three lines out through the existing network
    // instead of two, so half again as many old crack points sit at a crossing
    // that has to be re-solved. The point of the bar is that the old network
    // SURVIVES -- nine in ten of its points identical to the digit, and the rest
    // moved by a fraction of a grid cell (asserted above).
    expect(identical.length / oncePoints.length).toBeGreaterThan(0.88);

    // Accumulation is bounded: it can grow toward the shard hard limit but never
    // past it, so repeated strikes cannot walk the scene out of its geometry
    // budget. (The saturating ten-strike case is timed in the perf suite.)
    expect(twice.shardCount).toBeLessThanOrEqual(maxAccumulatedSeeds);
  });

  it("kintsugi acceptance: a canvas hit maps to the surface point it struck", () => {
    // Click -> crack origin runs through nearestSurfaceParam, so a point taken
    // from the surface has to come back as (roughly) the parameters it was
    // built from; otherwise cracks would open somewhere the user did not click.
    for (const sample of [frontStrike, backStrike, { s: 0.2, theta: -1.1 }]) {
      const point = surfaces.midpointAt(sample.theta, sample.s);
      const recovered = nearestSurfaceParam(surfaces, point);
      const drift = Math.hypot(
        surfaces.midpointAt(recovered.theta, recovered.s).x - point.x,
        surfaces.midpointAt(recovered.theta, recovered.s).y - point.y,
        surfaces.midpointAt(recovered.theta, recovered.s).z - point.z,
      );

      expect(drift).toBeLessThan(0.01);
    }
  });

  it("kintsugi acceptance: reset returns the vessel to whole", () => {
    // Reset is a token bump: the scene treats any change as "drop the impacts",
    // so the reader has to surface a fresh number for every click.
    expect(readKintsugiSettings(stateWithValues({})).resetToken).toBe(0);
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.vesselReset]: 3 })).resetToken,
    ).toBe(3);

    // And a vessel with no impacts is the whole bowl: no cracks, no gold.
    const reset = buildFracture(
      surfaces,
      struck({ branching: crackBranching, density: shardsPerStrike, seed: 21 }, []),
    );

    expect(reset.shardCount).toBe(1);
    expect(reset.seamPaths).toHaveLength(0);
  });

  it("kintsugi acceptance: key light scales the key intensity", () => {
    const base = studioLightBaseIntensity.key;

    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightKey]: 200 })),
      ).keyIntensity,
    ).toBeCloseTo(base * 2, 6);
    // 100% must reproduce the tuned rig exactly, or the section's reset button
    // no longer restores the dialed-in look.
    expect(
      resolveStudioLighting(readKintsugiSettings(stateWithValues({}))).keyIntensity,
    ).toBeCloseTo(base, 6);
    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightKey]: 0 })),
      ).keyIntensity,
    ).toBe(0);
  });

  it("kintsugi acceptance: fill light scales the fill intensity", () => {
    const base = studioLightBaseIntensity.fill;

    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightFill]: 300 })),
      ).fillIntensity,
    ).toBeCloseTo(base * 3, 6);
    expect(
      resolveStudioLighting(readKintsugiSettings(stateWithValues({}))).fillIntensity,
    ).toBeCloseTo(base, 6);
    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightFill]: 0 })),
      ).fillIntensity,
    ).toBe(0);
  });

  it("kintsugi acceptance: softbox scales the environment key panel", () => {
    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightSoftbox]: 200 })),
      ).softboxScale,
    ).toBeCloseTo(2, 6);
    expect(
      resolveStudioLighting(readKintsugiSettings(stateWithValues({}))).softboxScale,
    ).toBeCloseTo(1.2, 6);
  });

  it("kintsugi acceptance: ambient dome scales the environment dome", () => {
    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightAmbientDome]: 50 })),
      ).domeScale,
    ).toBeCloseTo(0.5, 6);
    expect(
      resolveStudioLighting(readKintsugiSettings(stateWithValues({}))).domeScale,
    ).toBeCloseTo(0.7, 6);
  });

  it("kintsugi acceptance: exposure maps to tone mapping exposure", () => {
    expect(
      resolveStudioLighting(
        readKintsugiSettings(stateWithValues({ [kintsugiTargets.lightExposure]: 25 })),
      ).exposure,
    ).toBeCloseTo(0.25, 6);
    // configureKintsugiRenderer seeds exposure at 1, so the default must agree
    // with it or the first frame would jump.
    expect(
      resolveStudioLighting(readKintsugiSettings(stateWithValues({}))).exposure,
    ).toBe(1);
  });

  it("kintsugi acceptance: seam generosity pools more gold at structural hotspots", () => {
    // "width" is the repurposed generosity control: runs stay a hairline that
    // covers the channel regardless of the value, while junctions and the rim
    // pool fatter as generosity climbs. So a large generosity increase adds a
    // clear but sub-linear amount of gold area (the hairline baseline persists),
    // rather than uniformly scaling every cross section.
    // Generosity now flows through the shared width model the fracture cutter
    // builds (the crack the shards open == the gold that fills it), so exercise
    // the production path: one fracture per generosity, each with its own model.
    const restrainedFracture = buildFracture(
      surfaces,
      struck({ branching: crackBranching, density: shardsPerStrike, seed: 21, width: 0.006 }),
    );
    const generousFracture = buildFracture(
      surfaces,
      struck({ branching: crackBranching, density: shardsPerStrike, seed: 21, width: 0.06 }),
    );
    const restrained = buildSeamGeometry(surfaces, restrainedFracture.seamPaths, {
      relief: 0.024,
      seed: 21,
      width: 0.006,
      widthModel: restrainedFracture.widthModel,
    });
    const generous = buildSeamGeometry(surfaces, generousFracture.seamPaths, {
      relief: 0.024,
      seed: 21,
      width: 0.06,
      widthModel: generousFracture.widthModel,
    });

    expect(
      seamTriangleArea(generous.positions, generous.index, generous.coverages),
    ).toBeGreaterThan(
      seamTriangleArea(restrained.positions, restrained.index, restrained.coverages) * 1.3,
    );
  });

  it("kintsugi acceptance: seam relief raises the bead profile", () => {
    const fracture = buildFracture(surfaces, struck({ branching: crackBranching, density: shardsPerStrike, seed: 21 }));
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

    expect(seamSourceBounds(proud.positions)).toBeGreaterThan(
      seamSourceBounds(flat.positions),
    );
  });

  it("kintsugi acceptance: auto-rotate gates the turntable yaw", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.autoRotate]: false }))
        .autoRotate,
    ).toBe(false);
    expect(readKintsugiSettings(stateWithValues({})).autoRotate).toBe(true);
  });

  it("kintsugi acceptance: easing reshapes revolution timing", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.easing]: "smooth" })).easing,
    ).toBe("smooth");
    expect(turntableYaw(0.25, "linear")).toBeCloseTo(Math.PI / 2, 6);
    expect(turntableYaw(0.25, "smooth")).toBeCloseTo(0.15625 * Math.PI * 2, 6);
    expect(turntableYaw(0.25, "smooth")).not.toBeCloseTo(turntableYaw(0.25, "linear"), 3);
  });

  it("kintsugi acceptance: orientation x maps to pivot rotation", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.rotX]: -45 })).rotXDeg,
    ).toBe(-45);
  });

  it("kintsugi acceptance: orientation y maps to pivot rotation", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.rotY]: 90 })).rotYDeg,
    ).toBe(90);
  });

  it("kintsugi acceptance: orientation z maps to pivot rotation", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.rotZ]: 180 })).rotZDeg,
    ).toBe(180);
  });

  it("kintsugi acceptance: background color reaches the scene clear color", () => {
    expect(
      readKintsugiSettings(stateWithValues({ [kintsugiTargets.background]: "#112233" }))
        .background,
    ).toBe("#112233");
  });

  it("kintsugi acceptance: include background gates preview and exports", () => {
    const excluded = stateWithValues({ [kintsugiTargets.includeBackground]: false });

    expect(shouldIncludeToolcraftPreviewBackground({ state: excluded })).toBe(false);
    expect(readKintsugiSettings(excluded).includeBackground).toBe(false);
    expect(readKintsugiSettings(stateWithValues({})).includeBackground).toBe(true);
  });

  it("kintsugi acceptance: image format selects the still encoder", () => {
    const section = appSchema.panels.controls?.sections.find(
      (candidate) => candidate.title === "Image Export",
    );
    const format = Object.values(section?.controls ?? {}).find(
      (control) => control.target === "export.image.format",
    );

    expect(format?.defaultValue).toBe("png");
    expect(format?.options?.map((option) => option.value)).toEqual(["png", "jpg"]);
  });

  it("kintsugi acceptance: image resolution selects the export long edge", () => {
    const state = stateWithValues({});

    expect(getToolcraftImageExportSize({ resolution: "2k", state }).width).toBe(2048);
    expect(getToolcraftImageExportSize({ resolution: "4k", state }).width).toBe(4096);
    expect(getToolcraftImageExportSize({ resolution: "8k", state }).width).toBe(8192);
  });

  it("kintsugi acceptance: video format chooses a supported container", () => {
    const section = appSchema.panels.controls?.sections.find(
      (candidate) => candidate.title === "Video Export",
    );
    const format = Object.values(section?.controls ?? {}).find(
      (control) => control.target === "export.video.format",
    );

    expect(format?.defaultValue).toBe("mp4");
    expect(format?.options?.map((option) => option.value)).toEqual(["mp4", "webm"]);
  });

  it("kintsugi acceptance: video resolution uses encoder-safe sizes", () => {
    const state = stateWithValues({});
    const current = getToolcraftVideoExportSize({ resolution: "current", state });
    const fourK = getToolcraftVideoExportSize({ resolution: "4k", state });

    expect(current).toMatchObject({ height: 1080, width: 1920 });
    expect(fourK.width).toBeLessThanOrEqual(3840);
    expect(fourK.height).toBeLessThanOrEqual(2160);
    expect(fourK.width % 2).toBe(0);
    expect(fourK.height % 2).toBe(0);
    expect(fourK.width / fourK.height).toBeCloseTo(1920 / 1080, 2);
  });

  it("kintsugi acceptance: export actions deliver final product output", () => {
    const stickySection = (appSchema.panels.controls?.sections ?? []).find((section) =>
      Object.values(section.controls).some((control) => control.type === "panelActions"),
    );
    const actions = Object.values(stickySection?.controls ?? {})
      .flatMap((control) => [...(control.actions ?? [])])
      .map((action) => (typeof action === "string" ? { value: action } : action));

    expect(actions.map((action) => action.value)).toEqual(["export-video", "export-png"]);

    for (const action of actions) {
      expect("icon" in action ? action.icon : undefined).toBe("upload-simple");
    }
  });

  it("kintsugi acceptance: persistence includes values and panels", () => {
    expect(appSchema.persistence).toMatchObject({
      include: ["panels", "values"],
      key: "toolcraft:kintsugi-3d:state:v1",
      storage: "localStorage",
      version: 1,
    });
  });

  it("kintsugi acceptance: the turntable loop is one revolution", () => {
    expect(turntableLoopSeconds).toBe(16);

    // One loop is exactly one revolution: the seam pose at phase 0 and phase 1
    // is identical for both easings, and motion is forward-only inside a loop.
    for (const easing of ["linear", "smooth"] as const) {
      expect(turntableYaw(1, easing)).toBeCloseTo(turntableYaw(0, easing), 9);

      let previous = -1;

      for (let step = 0; step <= 20; step += 1) {
        const yaw = turntableYaw(step / 21, easing);

        expect(yaw).toBeGreaterThanOrEqual(previous);
        previous = yaw;
      }
    }
  });

  it("kintsugi acceptance: orbit camera state stays out of exports", () => {
    // The orbit camera is transient view state: no schema target feeds it and
    // no camera field leaves the settings mapper, so exports and settings
    // transfer cannot capture it.
    expect(
      Object.values(kintsugiTargets).some((target) => target.includes("camera")),
    ).toBe(false);
    expect(Object.keys(readKintsugiSettings(stateWithValues({})))).not.toContain(
      "cameraPosition",
    );
  });
});
