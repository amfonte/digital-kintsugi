import { type ToolcraftRendererPipeline } from "@/toolcraft/runtime";

// Renderer pass graph for the kintsugi WebGL scene: fracture geometry and seam
// ribbons are rebuilt only by their own inputs, the scene render is the single
// GPU pass, and exports render offline without touching the preview passes.
export const kintsugiRendererPipeline: ToolcraftRendererPipeline = {
  interactionInvalidation: [
    {
      interaction: "control-drag",
      invalidates: ["scene-render"],
      mustNotInvalidate: ["fracture-build", "seam-build"],
      targets: [
        "orientation.x",
        "orientation.y",
        "orientation.z",
      ],
    },
    // Key/Fill/Exposure are scalar writes on an existing light or on the
    // renderer, so they must not touch the environment bake either.
    {
      interaction: "control-drag",
      invalidates: ["scene-render"],
      mustNotInvalidate: ["fracture-build", "seam-build", "environment-bake"],
      targets: ["lighting.key", "lighting.fill", "lighting.exposure"],
    },
    // Softbox and Ambient dome change emitters inside the prefiltered
    // environment, so they re-bake it — but the geometry it lights is untouched.
    {
      interaction: "control-drag",
      invalidates: ["environment-bake", "scene-render"],
      mustNotInvalidate: ["fracture-build", "seam-build"],
      targets: ["lighting.softbox", "lighting.dome"],
    },
    // Reset drops the vessel's whole break history, so the fracture it feeds and
    // the gold that follows it are both rebuilt from scratch.
    {
      interaction: "control-change",
      invalidates: ["fracture-build", "seam-build", "scene-render"],
      targets: ["vessel.reset"],
    },
    {
      interaction: "control-change",
      invalidates: ["scene-render"],
      mustNotInvalidate: ["fracture-build", "seam-build"],
      targets: [
        "vessel.glaze",
        "turntable.autoRotate",
        "turntable.easing",
        "scene.background",
        "export.includeBackground",
      ],
    },
    {
      interaction: "control-change",
      invalidates: ["export-render"],
      mustNotInvalidate: ["fracture-build", "seam-build", "scene-render"],
      targets: [
        "export.image.format",
        "export.image.resolution",
        "export.video.format",
        "export.video.fps",
        "export.video.resolution",
      ],
    },
    {
      interaction: "animation-frame",
      invalidates: [],
      mustNotInvalidate: ["fracture-build", "seam-build", "scene-render"],
      targets: ["turntable.phase"],
    },
    {
      interaction: "viewport-drag",
      invalidates: [],
      mustNotInvalidate: ["fracture-build", "seam-build", "scene-render"],
      targets: ["canvas.viewport.offset"],
    },
    {
      interaction: "viewport-zoom",
      invalidates: [],
      mustNotInvalidate: ["fracture-build", "seam-build", "scene-render"],
      targets: ["canvas.viewport.zoom"],
    },
    {
      interaction: "export",
      invalidates: ["export-render"],
      mustNotInvalidate: ["fracture-build", "seam-build"],
      targets: ["export.image.resolution", "export.video.resolution"],
    },
  ],
  passes: [
    {
      cacheKey: ["vessel.reset"],
      id: "fracture-build",
      inputs: ["vessel-profile-surfaces"],
      invalidatedBy: ["vessel.reset"],
      kind: "preprocess",
      output: "intermediate",
      quality: "full",
      runsOn: "main",
    },
    {
      // Seam width/relief are now baked constants, so the ribbons only rebuild
      // when the fracture they follow changes.
      cacheKey: ["vessel.reset"],
      id: "seam-build",
      inputs: ["fracture-build"],
      invalidatedBy: ["vessel.reset"],
      kind: "vector-build",
      output: "intermediate",
      quality: "full",
      runsOn: "main",
    },
    {
      // PMREM prefilter of BOTH reflection rigs: the studio cove that lights the
      // glaze and bisque, and the gold seams' own light box. The seams are
      // metalness 1 with an explicit envMap, so they take no light from the cove
      // and need their own bake for the same two controls to reach them. Baked
      // once at startup and again only when a Lighting control changes an emitter
      // inside them, coalesced to one bake of the pair per frame during a drag.
      cacheKey: ["lighting.softbox", "lighting.dome"],
      id: "environment-bake",
      inputs: ["studio-cove-emitters", "gold-light-box-emitters"],
      invalidatedBy: ["lighting.softbox", "lighting.dome"],
      kind: "preprocess",
      output: "intermediate",
      quality: "full",
      runsOn: "gpu",
    },
    {
      cacheKey: [
        "vessel.glaze",
        "vessel.reset",
        "scene.background",
        "export.includeBackground",
        "orientation.x",
        "orientation.y",
        "orientation.z",
        "lighting.key",
        "lighting.fill",
        "lighting.exposure",
      ],
      id: "scene-render",
      inputs: ["fracture-build", "seam-build", "environment-bake"],
      invalidatedBy: [
        "vessel.glaze",
        "vessel.reset",
        "scene.background",
        "export.includeBackground",
        "orientation.x",
        "orientation.y",
        "orientation.z",
        "lighting.key",
        "lighting.fill",
        "lighting.exposure",
      ],
      kind: "pixel-transform",
      output: "preview",
      quality: "full",
      runsOn: "gpu",
    },
    {
      id: "export-render",
      inputs: ["fracture-build", "seam-build", "environment-bake"],
      invalidatedBy: [
        "export.image.format",
        "export.image.resolution",
        "export.video.format",
        "export.video.fps",
        "export.video.resolution",
      ],
      kind: "export",
      output: "export",
      quality: "export",
      runsOn: "export-only",
    },
  ],
};
