# Glaze texture presets

Drop one folder per glaze here. Files in `public/` are served at the site root
and **lazy-loaded on demand** — only the selected glaze's textures are ever
resident in GPU memory, so adding more presets does not cost render performance.

## Which files do I need?

Every map is optional and falls back automatically, so provide whatever a given
glaze actually has:

| File            | Needed?      | Fallback if missing                     |
| --------------- | ------------ | --------------------------------------- |
| `basecolor.jpg` | minimum      | the preset's solid color                |
| `normal.png`    | recommended  | built-in procedural ceramic normal      |
| `roughness.jpg` | recommended  | built-in procedural roughness           |

- **Bare minimum:** just `basecolor.jpg`.
- **Sweet spot:** `basecolor` + `normal` + `roughness`.
- **Ignore** `metallic` (glaze is a non-metal), `height`/`displacement` (the
  normal map carries the relief), and `ao` (this mesh has no second UV set).

## Folder convention

```
public/textures/glaze/<preset-id>/
  basecolor.jpg   ← albedo / diffuse (sRGB)
  normal.png      ← tangent-space, OpenGL / Y+ green (linear)
  roughness.jpg   ← linear grayscale (white = rough)
  thumb.jpg       ← ~96x72 swatch for the picker (optional; a solid swatch is
                    generated automatically if omitted)
```

- `<preset-id>` is lowercase-kebab, e.g. `celadon-crackle`, `tenmoku`, `raku-white`.
- Maps **must be seamless / tileable** — the bowl uses cylindrical world-space
  UVs with a seam at the back, so a unique-unwrap bake would show that seam.
- 1K–2K is plenty. Larger just costs load time and memory for no visible gain.

## Registering a preset

After adding a folder, add a matching entry to
`src/app/kintsugi/glaze-library.ts` (`glazePresets`) with its `id` set to the
folder name and a `textures` block pointing at the files above. Tell me the
folder name and I'll wire it in.
