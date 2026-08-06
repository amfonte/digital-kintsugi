import {
  createToolcraftPngExportCanvas,
  shouldIncludeToolcraftPreviewBackground,
} from "@/toolcraft/runtime";
import type { ToolcraftState } from "@/toolcraft/runtime";

import { canvasToBlob, downloadBlob } from "./export-download";
import { readKintsugiSettings } from "./kintsugi-values";
import { getActiveKintsugiScene } from "./scene";

export async function exportKintsugiImage(state: ToolcraftState): Promise<void> {
  const scene = getActiveKintsugiScene();

  if (!scene) {
    throw new Error("Kintsugi scene is not ready for image export.");
  }

  const settings = readKintsugiSettings(state);
  const formatRaw = state.values["export.image.format"];
  const format = formatRaw === "jpg" ? "jpg" : "png";
  const resolutionRaw = state.values["export.image.resolution"];
  const resolution = typeof resolutionRaw === "string" ? resolutionRaw : "4k";
  const includeBackground = shouldIncludeToolcraftPreviewBackground({ state });

  const exportCanvas = createToolcraftPngExportCanvas({
    background: settings.background,
    includeBackground,
    render: ({ context, cssHeight, cssWidth, pixelHeight, pixelWidth }) => {
      const session = scene.createExportSession(pixelWidth, pixelHeight);

      try {
        // The Toolcraft helper draws the background fill itself, so the WebGL
        // frame renders with a transparent clear.
        const frame = session.renderFrame(null, false);

        context.drawImage(frame, 0, 0, cssWidth, cssHeight);
      } finally {
        session.dispose();
      }
    },
    resolution,
    state,
  });

  if (format === "jpg") {
    // JPEG has no alpha channel; flatten transparent exports onto white so
    // the encoder does not fill them with black.
    const flattened = document.createElement("canvas");

    flattened.width = exportCanvas.width;
    flattened.height = exportCanvas.height;

    const context = flattened.getContext("2d");

    if (!context) {
      throw new Error("Kintsugi JPG export requires a 2D canvas context.");
    }

    if (!includeBackground) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, flattened.width, flattened.height);
    }

    context.drawImage(exportCanvas, 0, 0);
    downloadBlob(await canvasToBlob(flattened, "image/jpeg", 0.92), "kintsugi-vessel.jpg");
    return;
  }

  downloadBlob(await canvasToBlob(exportCanvas, "image/png"), "kintsugi-vessel.png");
}
