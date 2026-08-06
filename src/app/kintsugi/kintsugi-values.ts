import { shouldIncludeToolcraftPreviewBackground } from "@/toolcraft/runtime";
import type { ToolcraftState } from "@/toolcraft/runtime";

import type { KintsugiSettings } from "./scene";
import { defaultKintsugiSettings } from "./scene";

export const kintsugiTargets = {
  autoRotate: "turntable.autoRotate",
  background: "scene.background",
  easing: "turntable.easing",
  glaze: "vessel.glaze",
  includeBackground: "export.includeBackground",
  lightAmbientDome: "lighting.dome",
  lightExposure: "lighting.exposure",
  lightFill: "lighting.fill",
  lightKey: "lighting.key",
  lightSoftbox: "lighting.softbox",
  rotX: "orientation.x",
  rotY: "orientation.y",
  rotZ: "orientation.z",
  seamRelief: "seam.relief",
  seamWidth: "seam.width",
  vesselReset: "vessel.reset",
} as const;

function numberValue(raw: unknown, fallback: number): number {
  const parsed = typeof raw === "string" ? Number(raw) : raw;

  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

// Toolcraft color controls commit their value as a `{ hex }` object, while the
// schema default seeds a bare hex string. Accept both so a picked color reaches
// the scene instead of silently falling back to the default.
function colorValue(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }

  if (raw && typeof raw === "object" && "hex" in raw) {
    const hex = (raw as { hex?: unknown }).hex;

    if (typeof hex === "string" && hex.length > 0) {
      return hex;
    }
  }

  return fallback;
}

function booleanValue(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

export function readKintsugiSettings(state: ToolcraftState): KintsugiSettings {
  const values = state.values;
  const defaults = defaultKintsugiSettings;
  const easingRaw = stringValue(values[kintsugiTargets.easing], defaults.easing);

  return {
    autoRotate: booleanValue(values[kintsugiTargets.autoRotate], defaults.autoRotate),
    background: colorValue(values[kintsugiTargets.background], defaults.background),
    easing: easingRaw === "smooth" ? "smooth" : "linear",
    glazePreset: stringValue(values[kintsugiTargets.glaze], defaults.glazePreset),
    includeBackground: shouldIncludeToolcraftPreviewBackground({ state }),
    lightAmbientDome: numberValue(
      values[kintsugiTargets.lightAmbientDome],
      defaults.lightAmbientDome,
    ),
    lightExposure: numberValue(
      values[kintsugiTargets.lightExposure],
      defaults.lightExposure,
    ),
    lightFill: numberValue(values[kintsugiTargets.lightFill], defaults.lightFill),
    lightKey: numberValue(values[kintsugiTargets.lightKey], defaults.lightKey),
    lightSoftbox: numberValue(
      values[kintsugiTargets.lightSoftbox],
      defaults.lightSoftbox,
    ),
    rotXDeg: numberValue(values[kintsugiTargets.rotX], defaults.rotXDeg),
    rotYDeg: numberValue(values[kintsugiTargets.rotY], defaults.rotYDeg),
    rotZDeg: numberValue(values[kintsugiTargets.rotZ], defaults.rotZDeg),
    seamRelief: numberValue(values[kintsugiTargets.seamRelief], defaults.seamRelief),
    seamWidth: numberValue(values[kintsugiTargets.seamWidth], defaults.seamWidth),
    // The Reset action commits a rising counter; the scene resets on any change.
    resetToken: numberValue(values[kintsugiTargets.vesselReset], defaults.resetToken),
  };
}

export function readRenderScale(state: ToolcraftState): number {
  const raw = state.values["canvas.renderScale"];
  const fallback = state.schema.canvas.renderScale.enabled
    ? state.schema.canvas.renderScale.defaultValue
    : 1;

  return numberValue(raw, fallback);
}
