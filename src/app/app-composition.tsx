import type { ToolcraftAppComposition } from "@/toolcraft/runtime/react";

import { appSchema } from "./app-schema";
import { KintsugiCanvas } from "./kintsugi/kintsugi-canvas";
import { kintsugiTargets } from "./kintsugi/kintsugi-values";
import { exportKintsugiImage } from "./kintsugi/png-export";
import { exportKintsugiVideo } from "./kintsugi/video-export";

export const appComposition: ToolcraftAppComposition = {
  canvasContent: <KintsugiCanvas />,
  onPanelAction: ({ action, dispatch, reportProgress, state }) => {
    switch (action.value) {
      case "reset": {
        // A rising counter rather than a state: resetting a vessel that is
        // already whole must stay a no-op, but every reset of a broken one has
        // to land, and an unchanged value would not reach the scene.
        const current = Number(state.values[kintsugiTargets.vesselReset] ?? 0);

        dispatch({
          label: "Reset vessel",
          target: kintsugiTargets.vesselReset,
          type: "controls.setValue",
          value: (Number.isFinite(current) ? current : 0) + 1,
        });
        return;
      }
      case "export-png": {
        return exportKintsugiImage(state);
      }
      case "export-video": {
        return exportKintsugiVideo(state, reportProgress);
      }
      default:
        return;
    }
  },
  schema: appSchema,
};
