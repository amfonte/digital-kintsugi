import { defineToolcraft } from "@/toolcraft/runtime";

import { defaultGlazePresetId, glazePickerItems } from "./kintsugi/glaze-library";

export const appSchema = defineToolcraft({
  canvas: {
    enabled: true,
    renderScale: { defaultValue: 2, enabled: false },
    size: { height: 1080, unit: "px", width: 1920 },
    sizing: { mode: "editable-output" },
    upload: false,
  },
  panels: {
    controls: {
      sections: [
        // The turntable is ambient presentation rather than an editable
        // animation, so its two controls belong with the runtime's own view
        // settings: placement "setup" drops them into the Setup block instead of
        // giving them a collapsible panel.
        {
          controls: {
            autoRotate: {
              defaultValue: true,
              description:
                "Spins the vessel one full revolution per turntable loop for preview and video export.",
              label: "Auto-rotate",
              performanceReason:
                "Toggles the turntable yaw; rendering work per frame is unchanged.",
              performanceRole: "responsiveness",
              target: "turntable.autoRotate",
              type: "switch",
            },
            easing: {
              defaultValue: "linear",
              description:
                "Rotation speed shape inside one revolution; the loop stays seamless.",
              label: "Easing",
              options: [
                { label: "Linear", value: "linear" },
                { label: "Smooth", value: "smooth" },
              ],
              performanceReason: "Changes a per-frame easing formula only.",
              performanceRole: "responsiveness",
              target: "turntable.easing",
              type: "select",
              visibleWhen: { equals: true, target: "turntable.autoRotate" },
            },
          },
          placement: "setup",
          title: "Turntable",
        },
        {
          controls: {
            glaze: {
              defaultValue: defaultGlazePresetId,
              items: glazePickerItems,
              label: "Glaze",
              performanceReason:
                "Swaps color and PBR map references on one material; no geometry is rebuilt and unused glaze textures are freed.",
              performanceRole: "responsiveness",
              target: "vessel.glaze",
              type: "imagePicker",
            },
          },
          // The glaze picker is a standalone gallery, so pin the section layout
          // to standalone rather than letting the resolver pick.
          layout: "standalone",
          title: "Glaze",
        },
        {
          controls: {
            vesselReset: {
              actions: [{ label: "Reset vessel", value: "reset" }],
              defaultValue: 0,
              description:
                "Click the bowl to break it; it repairs itself in gold. Reset returns it to a whole, unbroken vessel.",
              label: "Vessel",
              performanceReason:
                "Rebuilds the vessel as a single unbroken shard; one fracture pass, no shard or seam geometry to cut.",
              performanceRole: "responsiveness",
              target: "vessel.reset",
              type: "actions",
            },
          },
          title: "Fracture",
        },
        // Percentages of the tuned studio rig in stage.ts, not absolute
        // intensities: 100% is the dialed-in look, so the section's reset button
        // restores it exactly and the source file stays the single place the
        // real numbers live. Key/Fill/Exposure are live scalar updates; Softbox
        // and Ambient dome are emitters inside the PMREM environment, so they
        // re-bake that map (see KintsugiScene.rebuildStudioEnvironment).
        {
          controls: {
            keyLight: {
              defaultValue: 100,
              description:
                "Brightness of the main light above and to the right of the vessel.",
              label: "Key light",
              max: 300,
              min: 0,
              performanceReason:
                "Sets one directional light intensity; nothing is rebuilt or re-uploaded.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "lighting.key",
              type: "slider",
              unit: "%",
            },
            fillLight: {
              defaultValue: 100,
              description:
                "Brightness of the opposing light that opens up the shadow side.",
              label: "Fill light",
              max: 300,
              min: 0,
              performanceReason:
                "Sets one directional light intensity; nothing is rebuilt or re-uploaded.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "lighting.fill",
              type: "slider",
              unit: "%",
            },
            softbox: {
              defaultValue: 120,
              description:
                "Brightness of the reflected softbox panel that lights the vessel interior.",
              label: "Softbox",
              max: 200,
              min: 0,
              performanceReason:
                "Changing an environment emitter re-bakes the prefiltered reflection map, at most once per frame.",
              performanceRole: "workload",
              sliderValueKind: "continuous",
              step: 1,
              target: "lighting.softbox",
              type: "slider",
              unit: "%",
            },
            ambientDome: {
              defaultValue: 70,
              description:
                "Brightness of the surrounding studio dome, the soft light that fills every direction.",
              label: "Ambient dome",
              max: 100,
              min: 0,
              performanceReason:
                "Changing an environment emitter re-bakes the prefiltered reflection map, at most once per frame.",
              performanceRole: "workload",
              sliderValueKind: "continuous",
              step: 1,
              target: "lighting.dome",
              type: "slider",
              unit: "%",
            },
            exposure: {
              defaultValue: 100,
              description:
                "Overall image brightness after lighting, applied by the tone mapping curve.",
              label: "Exposure",
              max: 100,
              min: 25,
              performanceReason: "Sets one renderer tone-mapping scalar per change.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "lighting.exposure",
              type: "slider",
              unit: "%",
            },
          },
          title: "Lighting",
        },
        {
          controls: {
            rotX: {
              defaultValue: 0,
              label: "X",
              max: 180,
              min: -180,
              performanceReason: "Sets one group rotation component per change.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "orientation.x",
              type: "slider",
              unit: "°",
            },
            rotY: {
              defaultValue: 0,
              label: "Y",
              max: 180,
              min: -180,
              performanceReason: "Sets one group rotation component per change.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "orientation.y",
              type: "slider",
              unit: "°",
            },
            rotZ: {
              defaultValue: 0,
              label: "Z",
              max: 180,
              min: -180,
              performanceReason: "Sets one group rotation component per change.",
              performanceRole: "responsiveness",
              sliderValueKind: "continuous",
              step: 1,
              target: "orientation.z",
              type: "slider",
              unit: "°",
            },
          },
          title: "Orientation",
        },
        {
          controls: {
            backgroundColor: {
              defaultValue: "#242424",
              label: false,
              performanceReason: "Sets the scene clear color only.",
              performanceRole: "responsiveness",
              target: "scene.background",
              type: "color",
            },
            includeBackground: {
              defaultValue: true,
              label: "Include",
              performanceReason: "Toggles the scene clear color between color and transparent.",
              performanceRole: "responsiveness",
              target: "export.includeBackground",
              type: "switch",
            },
          },
          layoutGroups: [
            {
              columns: 2,
              controls: ["includeBackground", "backgroundColor"],
              layout: "inline",
            },
          ],
          title: "Background",
        },
        {
          controls: {
            imageFormat: {
              defaultValue: "png",
              label: "Format",
              options: [
                { label: "PNG", value: "png" },
                { label: "JPG", value: "jpg" },
              ],
              performanceReason: "Changes the still export encoder only.",
              performanceRole: "responsiveness",
              target: "export.image.format",
              type: "select",
            },
            imageResolution: {
              defaultValue: "4k",
              label: "Resolution",
              options: [
                { label: "2K", value: "2k" },
                { label: "4K", value: "4k" },
                { label: "8K", value: "8k" },
              ],
              performanceReason:
                "Selected resolution scales the offline still export render and encode cost up to the 8K long edge.",
              performanceRole: "workload",
              target: "export.image.resolution",
              type: "select",
            },
          },
          layoutGroups: [
            {
              columns: 2,
              controls: ["imageFormat", "imageResolution"],
              layout: "inline",
            },
          ],
          title: "Image Export",
        },
        {
          controls: {
            videoFormat: {
              defaultValue: "mp4",
              label: "Format",
              options: [
                { label: "MP4", value: "mp4" },
                { label: "WebM", value: "webm" },
              ],
              performanceReason: "Changes the offline video encoder container only.",
              performanceRole: "responsiveness",
              target: "export.video.format",
              type: "select",
            },
            videoResolution: {
              defaultValue: "current",
              label: "Resolution",
              options: [
                { label: "Current", value: "current" },
                { label: "4K", value: "4k" },
              ],
              performanceReason:
                "Selected resolution scales the offline video frame render and encode cost up to 4K.",
              performanceRole: "workload",
              target: "export.video.resolution",
              type: "select",
            },
            videoFps: {
              defaultValue: "30",
              description:
                "Frames encoded per second of video. The turntable still takes one full revolution per loop, so this trades file size and motion smoothness, not clip length.",
              label: "FPS",
              options: [
                { label: "24", value: "24" },
                { label: "30", value: "30" },
                { label: "60", value: "60" },
              ],
              performanceReason:
                "Scales the offline video frame count and encode cost linearly; 60 renders twice the frames of 30 for the same clip length.",
              performanceRole: "workload",
              target: "export.video.fps",
              type: "select",
            },
          },
          layoutGroups: [
            {
              columns: 2,
              controls: ["videoFormat", "videoResolution"],
              layout: "inline",
            },
          ],
          title: "Video Export",
        },
        {
          controls: {
            export: {
              actions: [
                {
                  icon: "upload-simple",
                  label: "Export Video",
                  role: "export-video",
                  value: "export-video",
                },
                {
                  icon: "upload-simple",
                  label: "Export PNG",
                  role: "export-image",
                  value: "export-png",
                },
              ],
              target: "panel.actions",
              type: "panelActions",
            },
          },
        },
      ],
      title: "Kintsugi",
    },
    // No timeline panel: the turntable is a fixed, self-running loop
    // (turntableLoopSeconds in scene.ts) rather than a scrubbable animation, so
    // there is no transport for the user to operate.
  },
  persistence: {
    include: ["panels", "values"],
    key: "toolcraft:kintsugi-3d:state:v1",
    storage: "localStorage",
    version: 1,
  },
  toolbar: {
    history: true,
    radar: true,
    zoom: true,
  },
});
