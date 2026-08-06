import { describe, expect, it } from "vitest";

import { appSchema } from "./app-schema";

describe("appSchema", () => {
  it("publishes the kintsugi product canvas and runtime surfaces", () => {
    expect(appSchema.canvas.enabled).toBe(true);
    expect(appSchema.canvas.upload).toBe(false);
    expect(appSchema.canvas.sizing).toEqual({ mode: "editable-output" });
    expect(appSchema.canvas.size).toEqual({ height: 1080, unit: "px", width: 1920 });
    expect(appSchema.canvas.renderScale.enabled).toBe(false);
    expect(appSchema.canvas.renderScale.defaultValue).toBe(2);
    // The turntable runs on the renderer's own clock, so there is no timeline
    // panel and no transport surface for the user to operate.
    expect(appSchema.panels.timeline).toBeUndefined();
    expect(appSchema.panels.layers).toBeUndefined();
    expect(appSchema.persistence).toMatchObject({
      include: ["panels", "values"],
      storage: "localStorage",
    });
    expect(appSchema.assembly.capabilities).toEqual(
      expect.arrayContaining(["canvas.editableSize"]),
    );
    expect(appSchema.assembly.capabilities).not.toContain("timeline.playback");
  });

  it("orders product sections with background and export sections before sticky actions", () => {
    const titles = (appSchema.panels.controls?.sections ?? [])
      .map((section) => section.title)
      .filter((title): title is string => typeof title === "string");

    const backgroundIndex = titles.indexOf("Background");
    const imageExportIndex = titles.indexOf("Image Export");
    const videoExportIndex = titles.indexOf("Video Export");

    expect(titles).toEqual(
      expect.arrayContaining([
        "Glaze",
        "Fracture",
        "Lighting",
        "Orientation",
        "Background",
        "Image Export",
        "Video Export",
      ]),
    );
    // Fracture sits between the glaze picker and the lighting rig, and the
    // turntable controls fold into the runtime Setup block instead of keeping a
    // section of their own.
    expect(titles.indexOf("Fracture")).toBe(titles.indexOf("Glaze") + 1);
    expect(titles.indexOf("Lighting")).toBe(titles.indexOf("Fracture") + 1);
    expect(backgroundIndex).toBeGreaterThan(-1);
    expect(imageExportIndex).toBe(backgroundIndex + 1);
    expect(videoExportIndex).toBe(imageExportIndex + 1);
  });

  it("binds every product control to a target with a resettable default", () => {
    const sections = appSchema.panels.controls?.sections ?? [];

    for (const section of sections) {
      for (const [controlId, control] of Object.entries(section.controls)) {
        expect(control.target, `${controlId} must declare a target`).toBeTruthy();

        const runtimeOwned =
          control.type === "settingsTransfer" ||
          control.target.startsWith("canvas.") ||
          control.target.startsWith("runtime.") ||
          control.target.startsWith("panels.");

        if (control.type !== "panelActions" && !runtimeOwned) {
          expect(
            control.defaultValue,
            `${controlId} must declare a defaultValue for reset`,
          ).toBeDefined();
        }
      }
    }
  });

  it("exposes sticky export actions for the animated product", () => {
    const stickySection = (appSchema.panels.controls?.sections ?? []).find((section) =>
      Object.values(section.controls).some((control) => control.type === "panelActions"),
    );
    const actionsControl = Object.values(stickySection?.controls ?? {}).find(
      (control) => control.type === "panelActions",
    );
    const values = (actionsControl?.actions ?? []).map((action) =>
      typeof action === "string" ? action : action.value,
    );

    expect(values).toEqual(["export-video", "export-png"]);
  });
});
