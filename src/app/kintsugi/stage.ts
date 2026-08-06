import * as THREE from "three";

import { createSeededRandom } from "./fracture";

// Shared studio setup for the live preview renderer and per-export renderers:
// tone mapping, the PMREM cove environment, key/fill lighting, and the baked
// contact-shadow ground disc.

export function isKintsugiWebglAvailable(): boolean {
  const probe = document.createElement("canvas");

  return probe.getContext("webgl2") !== null || probe.getContext("webgl") !== null;
}

export function createKintsugiWebglContext(
  canvas: HTMLCanvasElement,
): WebGL2RenderingContext {
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });

  if (!context) {
    throw new Error("Kintsugi rendering requires a WebGL2 context.");
  }

  return context;
}

// Khronos PBR Neutral rather than ACES Filmic. ACES routes through the AP1 /
// RRT_SAT matrices and carries a built-in `exposure / 0.6` lift, so mid-albedo
// ceramic lands in the shoulder where the curve compresses toward white AND
// desaturates: the glaze maps kept only ~40-55% of their albedo saturation
// (worst on the pale marble/cream glazes, which is most of the library). PBR
// Neutral is designed for material viewers — it preserves albedo hue and
// chroma, and at matched screen brightness returns roughly twice the colour.
export function configureKintsugiRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

// The glaze / bisque environment, replacing three's RoomEnvironment. That room
// is a uniformly bright white box, which is the flattest IBL there is: it floods
// a dielectric from every direction at once, and adding white on all sides is
// literally desaturation — the ceramic's albedo gets washed toward the light
// instead of shaded by it. This is a photographer's cove instead. A smooth
// bright-above / dark-below gradient dome supplies the diffuse irradiance so the
// glaze reads top-lit form rather than uniform flood, and a few HDR softboxes
// supply the specular. The panels are deliberately aligned with the analytic
// key/fill in addStudioLighting, so shifting the light budget from those lights
// into envMapIntensity keeps the apparent lighting direction fixed and only
// changes how much of the illumination arrives as coloured, directional IBL.
// Multipliers on the tuned emitter intensities below, driven by the Lighting
// controls. 1 is the dialed-in studio; the panel exposes them as percentages so
// a reset returns to exactly this rig. The values in this file stay the source
// of truth — the UI only scales them.
export type StudioEnvironmentOptions = {
  domeScale?: number;
  softboxScale?: number;
};

export function createStudioEnvironment(
  renderer: THREE.WebGLRenderer,
  options: StudioEnvironmentOptions = {},
): {
  dispose: () => void;
  texture: THREE.Texture;
} {
  const domeScale = options.domeScale ?? 1;
  const softboxScale = options.softboxScale ?? 1;
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];

  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);

    return item;
  };

  // Gradient dome: bright at the zenith falling to a deep grey at the floor,
  // neutral the whole way down. emissiveIntensity lifts the top of the ramp
  // above 1 so the bright sky is genuine HDR and behaves like a source, not like
  // grey paint.
  const domeGeo = track(new THREE.SphereGeometry(10, 32, 24));
  const domeMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color("#ffffff"),
      emissiveIntensity: 2 * domeScale,
      emissiveMap: track(createStudioGradientTexture()),
      metalness: 0,
      roughness: 1,
      side: THREE.BackSide,
    }),
  );

  scene.add(new THREE.Mesh(domeGeo, domeMat));

  // [x,y,z, sx,sy,sz, hex, intensity]. The first entry is the key softbox and
  // sits over keyLight's direction; the second is the fill over fillLight's; the
  // third is a back bounce.
  //
  // ALL THREE ARE TRUE NEUTRALS, and so is every other emitter in the rig. An
  // earlier version ran a warm softbox (#fff4e4) against a cool fill (#e2ecff)
  // sized so the PAIR cancelled: the energy-weighted illuminant measured R/B
  // 0.999, which looked correct on paper and was still visibly cream on the
  // bowl. Cancellation only holds for the whole-scene average — the softbox is
  // the dominant directional source over the lit face, so that face rendered
  // warm regardless of what the far side was doing. A whole-region mean hides
  // exactly that. Neutral shaping now comes from the dome's value ramp and the
  // dark flag, not from hue. Keep these R=G=B.
  //
  // A panel is an opaque box standing between the capture origin and the bright
  // upper dome, so dimming emissiveIntensity alone does NOT fade it out: at zero
  // it is a black card that OCCLUDES the dome and reads as a dark patch on the
  // bowl, darker than having no softbox at all. Opacity has to come down with
  // the intensity so the panel dissolves back into the dome behind it. Trailing
  // element is that opacity; it stays 1 at and above 100%, so the tuned rig and
  // every brighter setting render exactly as before.
  const panels: Array<
    [number, number, number, number, number, number, string, number, number]
  > = [
    [2.6, 5.2, 2.4, 5, 0.2, 4.5, "#ffffff", 3.2 * softboxScale, Math.min(1, softboxScale)],
    [-4.4, 2.4, -1.6, 0.2, 4, 4.5, "#ebebeb", 1.15, 1],
    [0, 2.2, -5.6, 6, 4, 0.2, "#f7f7f7", 0.85, 1],
  ];

  for (const [x, y, z, sx, sy, sz, hex, intensity, opacity] of panels) {
    const geo = track(new THREE.BoxGeometry(sx, sy, sz));
    const mat = track(
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: new THREE.Color(hex),
        emissiveIntensity: intensity,
        metalness: 0,
        opacity,
        roughness: 1,
        transparent: opacity < 1,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);

    mesh.position.set(x, y, z);
    scene.add(mesh);
  }

  // Negative fill opposite the key. Without something genuinely dark to reflect,
  // the shadow side has no falloff to shade the albedo against.
  const flagGeo = track(new THREE.BoxGeometry(0.2, 4.5, 4.5));
  const flagMat = track(new THREE.MeshBasicMaterial({ color: 0x131313 }));
  const flag = new THREE.Mesh(flagGeo, flagMat);

  flag.position.set(-3.8, 0.4, 3.2);
  scene.add(flag);

  const generator = new THREE.PMREMGenerator(renderer);
  // Softer than the gold's 0.03: ceramic is rough, so the environment should
  // arrive as a broad gradient rather than as readable panel shapes.
  const target = generator.fromScene(scene, 0.06);

  for (const item of disposables) {
    item.dispose();
  }

  return {
    dispose: () => {
      target.texture.dispose();
      generator.dispose();
    },
    texture: target.texture,
  };
}

// Vertical ramp for the cove dome. SphereGeometry runs uv.y from 0 at the south
// pole to 1 at the north, and the default flipY maps canvas row 0 to uv.y 1, so
// the first row drawn here is the zenith.
function createStudioGradientTexture(): THREE.CanvasTexture {
  const height = 256;
  const canvas = document.createElement("canvas");

  canvas.width = 2;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, height);

    // The floor end stays a lifted grey rather than going near-black. The lower
    // hemisphere is most of what the vessel's outer wall sees, so crushing it
    // costs the wall the light it needs for its normal map to read at all.
    //
    // The stops are TRUE NEUTRALS, luminance-matched to an earlier warm-tinted
    // ramp. The dome is the bulk of the diffuse irradiance, so any tint here is
    // a tint on every dielectric in the scene; a neutral basecolor must render
    // neutral, and the warm/cool shaping belongs to the panels below, not to the
    // white point. Keep these R=G=B when adjusting the ramp.
    gradient.addColorStop(0, "#f9f9f9");
    gradient.addColorStop(0.42, "#e0e0e0");
    gradient.addColorStop(0.62, "#9f9f9f");
    gradient.addColorStop(1, "#484848");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 2, height);
  }

  const texture = new THREE.CanvasTexture(canvas);

  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

// A dedicated reflection environment for the gold seams. A pure metal has no
// color of its own — it shows only what it reflects. Lit by the neutral studio
// room, the gold reads as dimensional metal only on the concave inside, which
// faces the room's bright light panels; a convex (outside) face reflects the
// flat, cool, dark directions and goes muted and flat.
//
// This is a warm "light box": a DARK warm room (so recesses read as deep gold)
// studded with BRIGHT HDR warm-white panels distributed over the FULL sphere —
// above, around, AND below. The metal therefore catches a hot warm highlight no
// matter which way a seam faces, giving the same white-hot-crest / dark-channel
// tonal contrast that makes the inside look metallic, on the outside too, while
// staying fully metallic (metalness 1). HDR emissive intensities (well above 1)
// are what produce the crisp specular glints; an LDR gradient cannot.
//
// The Softbox and Ambient dome controls scale this rig too, so the seams answer
// to the same lighting the bowl does rather than sitting frozen while the rest
// of the scene changes. They are MULTIPLIERS on the tuned intensities below and
// both arrive as 1 at the 100% default, so the dialed-in gold renders exactly as
// this file specifies it — the numbers here stay the source of truth.
export type GoldEnvironmentOptions = {
  domeScale?: number;
  softboxScale?: number;
};

export function createGoldEnvironment(
  renderer: THREE.WebGLRenderer,
  options: GoldEnvironmentOptions = {},
): {
  dispose: () => void;
  texture: THREE.Texture;
} {
  const domeScale = options.domeScale ?? 1;
  const softboxScale = options.softboxScale ?? 1;
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];

  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);

    return item;
  };

  // Mid NEUTRAL shell. This fills most reflection directions and gives the gold
  // its BODY. It is deliberately near-neutral (a faintly warm grey), NOT gold —
  // the seam's hue must come from the gold material's own colour (#d4a437). A
  // gold-tinted environment would double-tint the metal and push it orange and
  // oversaturated. It is also not bright, or the metal washes toward white.
  //
  // Ambient dome scales the shell because this is the gold's equivalent of the
  // cove's dome: the broad, every-direction term that gives the metal its BODY.
  const shellGeo = track(new THREE.BoxGeometry(12, 12, 12));
  const shellMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color("#6d6a64"),
      emissiveIntensity: 2 * domeScale,
      metalness: 0,
      roughness: 1,
      side: THREE.BackSide,
    }),
  );

  scene.add(new THREE.Mesh(shellGeo, shellMat));

  // Emissive helpers: bright near-white panels are the specular GLINTS (bright
  // crests); dark boxes are DIM reflection patches that become the deep-gold
  // recesses. Together with the mid shell they give the tonal spread that reads
  // as dimensional metal instead of flat paint. Colours are kept near-neutral
  // (a whisper of warmth only) so the gold's own hue is preserved.
  //
  // Softbox scales these because they are the gold's specular sources, the same
  // job the cove's key panel does for the glaze. Unlike that panel these need no
  // opacity coupling: a cove panel is an opaque box standing in front of a BRIGHT
  // dome, so dimming it alone leaves a black card that occludes the dome. These
  // sit against a DARK shell, so at zero emissive they simply blend into it and
  // the seams lose their glints, which is the correct reading of "no softbox".
  // [x,y,z, sx,sy,sz, hex, intensity].
  const bright: Array<[number, number, number, number, number, number, string, number]> = [
    [0, 5, 0, 3, 0.2, 3, "#f7f5f0", 6.5], // key glint above
    [3, 3, 2, 1.8, 0.2, 1.8, "#f6f3ec", 4.5],
    [1.2, 0.5, 4.3, 2, 2, 0.2, "#f7f5f0", 4], // side glints
    [-3.3, 1.4, -1, 0.2, 2.2, 2.2, "#f4f0e8", 3.5],
    [0, -4.6, 0, 3, 0.2, 3, "#f4f0e8", 4.5], // key glint below (underside)
    [2.6, -3, 2.4, 1.6, 0.2, 1.6, "#f7f5f0", 3.5],
  ];
  // Dark patches (no emissive → render near-black) scattered around every axis
  // so recessed / grazing reflections fall into deep gold no matter the facing.
  const dark: Array<[number, number, number, number, number, number]> = [
    [-3.2, 0.5, 2.6, 2.4, 3.2, 0.2],
    [3.4, -0.5, -2.2, 0.2, 3.2, 3.2],
    [-1, 3.4, -3, 3, 3, 0.2],
    [1.4, -3.2, -2.8, 2.6, 2.6, 0.2],
  ];

  for (const [x, y, z, sx, sy, sz, hex, intensity] of bright) {
    const geo = track(new THREE.BoxGeometry(sx, sy, sz));
    const mat = track(
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: new THREE.Color(hex),
        emissiveIntensity: intensity * softboxScale,
        metalness: 0,
        roughness: 1,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);

    mesh.position.set(x, y, z);
    scene.add(mesh);
  }

  for (const [x, y, z, sx, sy, sz] of dark) {
    const geo = track(new THREE.BoxGeometry(sx, sy, sz));
    const mat = track(
      new THREE.MeshBasicMaterial({ color: 0x0e0e10 }),
    );
    const mesh = new THREE.Mesh(geo, mat);

    mesh.position.set(x, y, z);
    scene.add(mesh);
  }

  const generator = new THREE.PMREMGenerator(renderer);
  // Low sigma keeps the panels crisp so their reflections stay sharp specular
  // glints (shiny metal) rather than soft smears.
  const target = generator.fromScene(scene, 0.03);

  for (const item of disposables) {
    item.dispose();
  }

  return {
    dispose: () => {
      target.texture.dispose();
      generator.dispose();
    },
    texture: target.texture,
  };
}

// Analytic lights carry only part of the illumination now. Previously a single
// hard key at 2.3 supplied ~79% of it, which is why the glaze looked bleached:
// one white directional term dominating the shading leaves the albedo little say
// in the final colour, and it drove lit values high enough to sit in the tone
// curve's shoulder. The key and fill are cut roughly in half and the difference
// is handed to the glaze's envMapIntensity, where the cove environment supplies
// the same directions with tonal falloff instead.
//
// Both lights are pure white, matching the panels in createStudioEnvironment.
// The key is the single largest energy term in the rig, so tinting it tints
// everything: at 0xfff1e0 it was pushing the net illuminant to R/B 1.19 and
// rendering neutral glazes as cream. The fill was cool (0xdfe8ff) to oppose it;
// with nothing warm left to cancel, a cool fill just casts the shadow side blue,
// so it is neutral too. Every emitter in the scene is now achromatic, which is
// the only way a neutral basecolor renders as the swatch shows it.
// The tuned intensities the Lighting controls scale. Exported so the scene can
// recompute an absolute intensity from a percentage without duplicating the
// numbers, and so a 100% slider is exactly this rig.
export const studioLightBaseIntensity = {
  fill: 0.35,
  hemisphere: 0.1,
  key: 1.3,
} as const;

export type StudioLights = {
  fillLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
  keyLight: THREE.DirectionalLight;
};

// The one place the Lighting controls' percentages become the absolute numbers
// the renderer writes, so the preview, the export renderer, and the tests all
// read the same mapping. 100 is the tuned rig above.
export type StudioLightingPercents = {
  lightAmbientDome: number;
  lightExposure: number;
  lightFill: number;
  lightKey: number;
  lightSoftbox: number;
};

export type StudioLightingLevels = {
  domeScale: number;
  exposure: number;
  fillIntensity: number;
  keyIntensity: number;
  softboxScale: number;
};

export function resolveStudioLighting(
  percents: StudioLightingPercents,
): StudioLightingLevels {
  return {
    domeScale: percents.lightAmbientDome / 100,
    exposure: percents.lightExposure / 100,
    fillIntensity: studioLightBaseIntensity.fill * (percents.lightFill / 100),
    keyIntensity: studioLightBaseIntensity.key * (percents.lightKey / 100),
    softboxScale: percents.lightSoftbox / 100,
  };
}

export function addStudioLighting(scene: THREE.Scene): StudioLights {
  const keyLight = new THREE.DirectionalLight(0xffffff, studioLightBaseIntensity.key);

  keyLight.position.set(2.6, 3.6, 1.8);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xe8e8e8, studioLightBaseIntensity.fill);

  fillLight.position.set(-3, 1.7, -1);
  scene.add(fillLight);

  // Kept faint: a hemisphere term is another flat achromatic wash, and the cove
  // dome now does this job with an actual gradient.
  const hemisphereLight = new THREE.HemisphereLight(
    0xffffff,
    0x858585,
    studioLightBaseIntensity.hemisphere,
  );

  scene.add(hemisphereLight);

  return { fillLight, hemisphereLight, keyLight };
}

export function createGroundShadowDisc(): THREE.Mesh {
  // Baked contact-shadow disc: a real shadow-map pass plus per-fragment PCF
  // costs a full extra scene raster on software WebGL for the same visual.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 48),
    new THREE.MeshBasicMaterial({
      depthWrite: false,
      map: createContactShadowTexture(),
      transparent: true,
    }),
  );

  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.015;
  ground.renderOrder = -1;

  return ground;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");

  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.08,
      size / 2,
      size / 2,
      size / 2,
    );

    gradient.addColorStop(0, "rgba(0, 0, 0, 0.42)");
    gradient.addColorStop(0.55, "rgba(0, 0, 0, 0.18)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);

  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

export function createGoldBumpTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");

  if (context) {
    const image = context.createImageData(size, size);
    const random = createSeededRandom(977);
    const base = new Array<number>(size * size);

    for (let index = 0; index < base.length; index += 1) {
      base[index] = random();
    }

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Cheap blur of white noise so the bump reads as hammered metal grain
        // instead of per-pixel static.
        let sum = 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            sum += base[((y + dy + size) % size) * size + ((x + dx + size) % size)];
          }
        }

        const value = Math.round((sum / 9) * 255);
        const offset = (y * size + x) * 4;

        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
        image.data[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
  }

  const texture = new THREE.CanvasTexture(canvas);

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;

  return texture;
}

// Tileable heightfield: white noise smoothed by repeated box blur, then
// normalized. blurPasses controls feature size (more passes = larger, softer
// bumps).
function createNoiseHeight(size: number, blurPasses: number, seed: number): Float32Array {
  const random = createSeededRandom(seed);
  let field = new Float32Array(size * size);

  for (let index = 0; index < field.length; index += 1) {
    field[index] = random();
  }

  for (let pass = 0; pass < blurPasses; pass += 1) {
    const next = new Float32Array(size * size);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let sum = 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            sum += field[((y + dy + size) % size) * size + ((x + dx + size) % size)];
          }
        }

        next[y * size + x] = sum / 9;
      }
    }

    field = next;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of field) {
    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }
  }

  const range = max - min || 1;

  for (let index = 0; index < field.length; index += 1) {
    field[index] = (field[index] - min) / range;
  }

  return field;
}

// Bilinear wrap-sample of a small tileable field, used to stretch a coarse
// noise octave across a larger tile.
function sampleBilinear(
  field: Float32Array,
  fieldSize: number,
  x: number,
  y: number,
): number {
  const fx = ((x % fieldSize) + fieldSize) % fieldSize;
  const fy = ((y % fieldSize) + fieldSize) % fieldSize;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % fieldSize;
  const y1 = (y0 + 1) % fieldSize;
  const tx = fx - x0;
  const ty = fy - y0;
  const top = field[y0 * fieldSize + x0] * (1 - tx) + field[y0 * fieldSize + x1] * tx;
  const bottom = field[y1 * fieldSize + x0] * (1 - tx) + field[y1 * fieldSize + x1] * tx;

  return top * (1 - ty) + bottom * ty;
}

// Handmade-ceramic heightfield: gentle wheel-throwing undulation (coarse,
// stretched horizontally so it reads as faint concentric ridges) plus fine
// orange-peel glaze grain. The low octave is what breaks the big mirror-blob
// reflections that make a perfect surface read as metal.
function createCeramicHeight(size: number, seed: number): Float32Array {
  const coarse = createNoiseHeight(64, 5, seed);
  const fine = createNoiseHeight(size, 4, seed + 17);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Integer cycle counts keep the composite tileable; 1 cycle across u,
      // 3 across v elongates features into throwing rings. The undulation
      // dominates; the orange-peel grain stays a whisper so gloss reads as
      // fired glaze rather than frosted glass.
      const low = sampleBilinear(coarse, 64, (x / size) * 64, (y / size) * 64 * 3);

      height[y * size + x] = low * 0.78 + fine[y * size + x] * 0.22;
    }
  }

  return height;
}

// Tangent-space normal map from a heightfield. strength scales the slope;
// higher reads as deeper surface relief.
function normalTextureFromHeight(
  height: Float32Array,
  size: number,
  strength: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");

  if (context) {
    const image = context.createImageData(size, size);
    const at = (x: number, y: number): number =>
      height[((y + size) % size) * size + ((x + size) % size)];

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const nx = -dx;
        const ny = -dy;
        const nz = 1;
        const length = Math.hypot(nx, ny, nz) || 1;
        const offset = (y * size + x) * 4;

        image.data[offset] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
        image.data[offset + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
        image.data[offset + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
        image.data[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
  }

  const texture = new THREE.CanvasTexture(canvas);

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;

  return texture;
}

// Tileable grayscale data map (roughness / variation) from a heightfield,
// remapped into [low, high].
function createScalarTexture(
  size: number,
  blurPasses: number,
  low: number,
  high: number,
  seed: number,
): THREE.CanvasTexture {
  const height = createNoiseHeight(size, blurPasses, seed);
  const canvas = document.createElement("canvas");

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");

  if (context) {
    const image = context.createImageData(size, size);

    for (let index = 0; index < height.length; index += 1) {
      const value = Math.round((low + (high - low) * height[index]) * 255);
      const offset = index * 4;

      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }

    context.putImageData(image, 0, 0);
  }

  const texture = new THREE.CanvasTexture(canvas);

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;

  return texture;
}

export type KintsugiSurfaceTextures = {
  bisqueNormal: THREE.CanvasTexture;
  glazeNormal: THREE.CanvasTexture;
  glazeRoughness: THREE.CanvasTexture;
  goldNormal: THREE.CanvasTexture;
  goldRoughness: THREE.CanvasTexture;
};

// Procedural PBR detail maps shared by the live and export renderers:
// throwing-ring undulation plus orange-peel for the glaze (with a matching
// roughness break-up so highlights streak like fired ceramic, not metal),
// hammered grain and roughness break-up for the gold, coarse grain for the
// raw bisque body.
export function createKintsugiSurfaceTextures(): KintsugiSurfaceTextures {
  const glazeNormal = normalTextureFromHeight(createCeramicHeight(256, 421), 256, 1.8);
  const glazeRoughness = createScalarTexture(256, 4, 0.55, 1, 733);
  const goldNormal = normalTextureFromHeight(createNoiseHeight(256, 3, 977), 256, 3.2);
  const goldRoughness = createScalarTexture(256, 3, 0.22, 0.46, 1201);
  const bisqueNormal = normalTextureFromHeight(createNoiseHeight(256, 1, 53), 256, 2.4);

  glazeNormal.repeat.set(8, 3);
  glazeRoughness.repeat.set(8, 3);
  goldNormal.repeat.set(6, 1);
  goldRoughness.repeat.set(6, 1);
  bisqueNormal.repeat.set(20, 8);

  return { bisqueNormal, glazeNormal, glazeRoughness, goldNormal, goldRoughness };
}
