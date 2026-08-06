import {
  createToolcraftRuntimeSetupSection,
} from "./runtime-setup-section";
import { normalizeControlsPanelLayout } from "./controls-panel-normalization";
import { resolveToolcraftTimelinePanel } from "./schema-resolvers";
import type {
  ResolvedToolcraftAppSchema,
  ResolvedToolcraftPanelsSchema,
  ResolvedToolcraftSettingsTransferSchema,
  ToolcraftAppSchema,
} from "./types";
export function normalizeToolcraftPanels({
  canvas,
  panels,
  settingsTransfer,
}: {
  canvas: ResolvedToolcraftAppSchema["canvas"];
  panels: ToolcraftAppSchema["panels"];
  settingsTransfer: ResolvedToolcraftSettingsTransferSchema;
}): ResolvedToolcraftPanelsSchema {
  const normalizedTimeline = resolveToolcraftTimelinePanel(panels.timeline);
  const normalizedPanels: ResolvedToolcraftPanelsSchema = {
    ...(panels.controls ? { controls: panels.controls } : {}),
    ...(panels.layers ? { layers: panels.layers } : {}),
    ...(normalizedTimeline ? { timeline: normalizedTimeline } : {}),
  };

  if (!panels.controls) {
    return normalizedPanels;
  }

  const controls = { ...panels.controls };
  const runtimeSetupSection = createToolcraftRuntimeSetupSection({
    canvas,
    settingsTransfer,
    timeline: normalizedTimeline,
  });
  // Sections that opted into Setup placement lose their own header and trail the
  // runtime's own setup controls, so app-authored view settings can sit in the
  // same uncollapsible block as Resolution scale.
  const setupPlacedSections = controls.sections.filter(
    (section) => section.placement === "setup",
  );
  const bodySections = controls.sections.filter(
    (section) => section.placement !== "setup",
  );
  const setupSection = {
    ...runtimeSetupSection,
    controls: setupPlacedSections.reduce(
      (merged, section) => ({ ...merged, ...section.controls }),
      runtimeSetupSection.controls,
    ),
    layoutGroups: [
      ...(runtimeSetupSection.layoutGroups ?? []),
      ...setupPlacedSections.flatMap((section) => section.layoutGroups ?? []),
    ],
  };

  return {
    ...normalizedPanels,
    controls: normalizeControlsPanelLayout({
      ...controls,
      sections: [
        setupSection,
        ...bodySections,
      ],
    }),
  };
}
