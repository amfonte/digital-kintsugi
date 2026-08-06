import type { ToolcraftImagePickerItemSchema } from "@/toolcraft/runtime";

// A glaze is a full material identity, not a tint: each preset is a real
// seamless PBR set under public/textures/glaze/<id>/, lazy-loaded only while
// that glaze is selected. Color stays white and roughness stays 1 so the
// basecolor and roughness maps show at face value; normalScale exaggerates the
// authored relief so the surface detail actually reads on the bowl.
//
// Finish (gloss vs matte) is a property of the preset, not a separate control.
// There used to be a Glossy/Matte toggle that multiplied roughness by 0.82 in
// glossy and dimmed envMapIntensity by 0.8 in matte; it was removed because the
// numbers did not support the labels. The shipped roughness maps are very nearly
// constants, so each preset's finish is already one scalar:
//
//   preset             map mean   std
//   glazed-ceramic       0.406    0.032
//   speckled-ceramic     0.432    0.003
//   marble               0.350    0.002   (flat: varies 0.002 over 2048px)
//   terrazzo             0.420    0.024
//
// The toggle therefore spanned only ~0.33 to ~0.41 — all satin, never reaching
// gloss (~0.1-0.2) or matte (~0.7-0.9), and narrower than the spread between two
// presets in the picker. Its one clearly visible effect was the envMapIntensity
// dimming, which is a lighting change, not a finish change. To make a glaze read
// wetter or drier now, set roughness on THAT preset (it multiplies the map, so
// values below 1 wet it and the map means above are the baseline) rather than
// applying a blanket offset to every material at once.
//
// Two values here are lighting balance rather than material identity, and both
// exist to keep the basecolor from being washed out:
//   envMapIntensity scales the DIFFUSE IBL as well as the reflections
//     (getIBLIrradiance returns PI * envColor * envMapIntensity), so it is the
//     share of illumination that arrives from the graded cove environment
//     instead of from the flat white analytic key. It is high on purpose.
//   clearcoat lays an achromatic specular layer OVER the basecolor, so every
//     point of it is that much white spread across the map. Kept low, and given
//     the preset's own normal map in loadGlazeTextures so what remains breaks up
//     over the relief instead of sheeting evenly.
//
// Every map is optional: provide whatever a given glaze ships with. A missing
// basecolor keeps the solid color, and a missing normal/roughness falls back to
// the built-in procedural detail. Metallic/height/AO maps are intentionally
// unsupported — ceramic glaze is a non-metal and the relief is carried by the
// normal map.
export type GlazePresetTextures = {
  basecolor?: string;
  normal?: string;
  roughness?: string;
};

export type GlazePreset = {
  clearcoat: number;
  clearcoatRoughness: number;
  color: string;
  envMapIntensity: number;
  id: string;
  label: string;
  normalScale: number;
  roughness: number;
  specularIntensity: number;
  swatch: string;
  textures?: GlazePresetTextures;
  // How many times the texture tiles across the bowl's radius. It is per-preset
  // because the right feature size is a property of the material, not of the
  // geometry: a marble vein has to run the length of a shard to read as a vein,
  // while terrazzo chips have to stay chip-sized. Lower = bigger features.
  // Read against whichever `unwrap` the preset uses, since the two bake
  // different default tilings; tiling scales both UV axes together either way,
  // so it never introduces stretch of its own.
  tiling?: number;
  // Which baked unwrap this preset's maps read (scene.ts bakes both).
  //
  //   "disc" (default) — uniform feature size everywhere on the bowl. Correct
  //     for anything whose pattern is made of discrete elements that have a
  //     real-world size: chips, speckle, veining.
  //   "cylindrical" — level rings, at the cost of the pattern scaling down as
  //     it approaches the pole. Worth that ONLY for a material whose identity
  //     is a horizontal band, because a band that isn't level isn't a band.
  //
  // A bowl has Gaussian curvature, so no unwrap gives both; this is the choice
  // of which loss the material can afford, and it belongs to the material.
  unwrap?: "disc" | "cylindrical";
  // Cylindrical only: rolls the texture up or down the wall, measured in tiles.
  // The unwrap pins v = 0 at the rim and runs negative downward, so a NEGATIVE
  // offset lifts the pattern toward the rim. This is how a specific feature —
  // for a poured glaze, its pour line — gets parked at a specific height, and it
  // is a pure translation, so it costs no distortion at all.
  unwrapOffset?: number;
};

// Public URL for an uploaded glaze map. Files under public/ are served at the
// site root and are not bundled, so they lazy-load on demand.
function texture(id: string, file: string): string {
  return `/textures/glaze/${id}/${file}`;
}

export const glazePresets: readonly GlazePreset[] = [
  {
    clearcoat: 0.1,
    clearcoatRoughness: 0.28,
    color: "#ffffff",
    envMapIntensity: 0.8,
    id: "glazed-ceramic",
    label: "Glazed",
    normalScale: 1.4,
    roughness: 1,
    specularIntensity: 0.58,
    // 0.8333 snaps to 4 repeats around the bowl, one tile spanning ~1.50 world
    // units at the rim (150% of the swatch's own scale). Sized that way because
    // the wall is 1.75 tiles tall at 6 repeats, so the texture's pour band and
    // the bright zone above it BOTH came round a second time and landed squeezed
    // into the bottom ~15% of the wall — that doubled-up repeat, not shear, is
    // what read as pinching. At 4 repeats the wall is 1.16 tiles, so the pattern
    // plays through once from rim to base and there is nothing left to crowd.
    tiling: 0.8333,
    // Puts the pour band at 40% of the wall height. Without it the band sits at
    // 25%, which is where "too low" came from.
    unwrapOffset: -0.426,
    // The one preset on the cylindrical unwrap: this material's dark pour band
    // is its defining feature, and only a cylindrical map keeps a band level.
    unwrap: "cylindrical",
    swatch: texture("glazed-ceramic", "Poliigon_CeramicPotteryGlazed_10828_BaseColor.jpg"),
    textures: {
      basecolor: texture(
        "glazed-ceramic",
        "Poliigon_CeramicPotteryGlazed_10828_BaseColor.jpg",
      ),
      normal: texture("glazed-ceramic", "Poliigon_CeramicPotteryGlazed_10828_Normal.png"),
      roughness: texture(
        "glazed-ceramic",
        "Poliigon_CeramicPotteryGlazed_10828_Roughness.jpg",
      ),
    },
  },
  {
    clearcoat: 0.09,
    clearcoatRoughness: 0.28,
    color: "#ffffff",
    envMapIntensity: 0.8,
    id: "speckled-ceramic",
    label: "Speckled",
    normalScale: 1.5,
    roughness: 1,
    specularIntensity: 0.56,
    // The speckle is fine grain to begin with; tiled small it lands near texel
    // size and filters away into flat noise, so it goes near 1:1.
    tiling: 1.25,
    swatch: texture(
      "speckled-ceramic",
      "Poliigon_CeramicPotteryGlazed_10861_BaseColor.jpg",
    ),
    textures: {
      basecolor: texture(
        "speckled-ceramic",
        "Poliigon_CeramicPotteryGlazed_10861_BaseColor.jpg",
      ),
      normal: texture(
        "speckled-ceramic",
        "Poliigon_CeramicPotteryGlazed_10861_Normal.png",
      ),
      roughness: texture(
        "speckled-ceramic",
        "Poliigon_CeramicPotteryGlazed_10861_Roughness.jpg",
      ),
    },
  },
  {
    clearcoat: 0.12,
    clearcoatRoughness: 0.26,
    color: "#ffffff",
    envMapIntensity: 0.75,
    id: "marble",
    label: "Marble",
    normalScale: 1.2,
    roughness: 1,
    specularIntensity: 0.5,
    // Veining is the whole material: one tile across the radius so a vein runs
    // the length of a shard instead of reading as speckle.
    tiling: 1,
    swatch: texture("marble", "marble_113_basecolor-2K.png"),
    textures: {
      basecolor: texture("marble", "marble_113_basecolor-2K.png"),
      normal: texture("marble", "marble_113_normal-2K.png"),
      roughness: texture("marble", "marble_113_roughness-2K.png"),
    },
  },
  {
    clearcoat: 0.06,
    clearcoatRoughness: 0.4,
    color: "#ffffff",
    envMapIntensity: 0.62,
    id: "terrazzo",
    label: "Terrazzo",
    normalScale: 1.4,
    roughness: 1,
    specularIntensity: 0.46,
    // Chips have a real-world size, so terrazzo stays denser than marble — but
    // the chips still have to read as chips rather than as grit.
    tiling: 1.5,
    swatch: texture("terrazzo", "Terrazo_01_2k_BaseColor.png"),
    textures: {
      basecolor: texture("terrazzo", "Terrazo_01_2k_BaseColor.png"),
      normal: texture("terrazzo", "Terrazo_01_2k_Normal.png"),
      roughness: texture("terrazzo", "Terrazo_01_2k_Roughness.png"),
    },
  },
];

export const defaultGlazePresetId = "speckled-ceramic";

export const glazePickerItems: readonly ToolcraftImagePickerItemSchema[] =
  glazePresets.map((preset) => ({
    alt: preset.label,
    src: preset.swatch,
    value: preset.id,
  }));

export function getGlazePreset(id: string): GlazePreset {
  return (
    glazePresets.find((preset) => preset.id === id) ??
    glazePresets.find((preset) => preset.id === defaultGlazePresetId) ??
    glazePresets[0]
  );
}
