# RevealNotes — Phase 1 technical feasibility report

Sources: `untitled_1.xcanvas` (sample) and the XNotes source at
`xnotes-android/` (read-only reference, not modified).

## 1. Sample file

- ZIP with a single deflated `manifest.json` (29 KB).
- `format: "xcanvas"`, `version: 1`, `writer: 47`, `dpi: 150`,
  `background {pattern: grid, pattern_color: [150,150,150,64], spacing: 64}`,
  `view {cx, cy, zoom}`.
- 8 items, all `kind: "stroke"`, `tool: "pen"`, 1,169 samples `[x, y, pressure]`.
  Every stroke also has `smooth_scale` (≈0.889 = the zoom it was drawn at).
- Content bbox ≈ x 1411–2815, y 1849–3055 (content px).

## 2. Format facts from source (`format/CanvasCodec.kt`)

- `.xcanvas` = infinite canvas, one flat `items` list. Multi-page notebooks use
  a **different** codec and extension: `.xnote` (`format/DocumentCodec.kt`),
  with `pages[]` (each `width`, `height`, `pdf_page`, `items`), optional
  `assets/source.pdf`, templates and `text` items. Not the same structure.
- ZIP entries: `manifest.json` (+ `assets/image-NNN.{png,svg}`,
  `assets/audio-NNN.*` when present). Unknown keys/kinds are skipped by XNotes.
- Item kinds on canvas: `stroke`, `image`, `audio`, `shape`, `glyphs`, `fill`,
  `tape` (no `text` on canvas). Connectors are `shape` with a `connector` object.
- Stroke tools: `pen`, `dashed`, `calligraphy`, `speed`, `taper`, `highlighter`.
- Optional stroke fields: `speed_scale`, `smooth_scale`, `straight`, `cuts`,
  `rec`/`rec_ms` (audio sync), `locked`, `group`. Speed-pen samples may carry
  a 4th (ms) and 5th (kept width factor) element.
- **Item order = z-order** (last on top).
- **No stable per-item IDs.** `id` exists only on items a connector glues to
  and is recomputed on every save. `group` is an optional integer.
- Sample coordinates are rounded to 0.01 px, pressure to 0.001, and rounding
  is idempotent, so re-saving an untouched item is byte-stable.

## 3. Rendering (`core/stroke/StrokeEngine.kt`, `core/model/Stroke.kt`)

Deterministic and portable. Pipeline per stroke:

1. Arc-length EMA low-pass of x, y and pressure, length
   `λ = 1.5 · smooth_scale` content px (skipped for x/y when `straight`).
2. Pen and highlighter hold end pressure over 4 samples (round, full ends).
3. Half-width `= base_width · (m + (1−m)·logisticEase(p, k=8)) · max(1 + ds·ty, 0.1) / 2`
   (`m = pressure_min_factor`, `ds = direction_strength`; calligraphy replaces
   `ty` with a slew-limited nib channel; taper/speed multiply extra factors).
4. Geometry = union of discs at every sample + tangent hulls between
   neighbours (filled, not stroked). Dashed pen instead strokes the smoothed
   centreline with round-capped dashes of width `base_width`.
5. Colour = `rgba`; highlighter alpha = `highlighter_alpha` with MULTIPLY
   (SCREEN if `highlighter_inverse`); translucent ink is composited once per
   stroke so self-overlaps don't darken.

Coordinates are absolute content px; `screen = (content − scroll) · zoom`,
no origin offset. Background is procedural: 1 device-px lines (or 1.4 px
dots) every `spacing`, doubling/halving by powers of two with zoom.

## 4. Feasibility

| Requirement | Verdict |
|---|---|
| Open `.xcanvas`, preserve all data | Yes. ZIP + JSON; we never write the file. |
| Accurate handwriting | Yes. The stroke engine is pure math and is ported 1:1 (pen, highlighter, dashed, calligraphy, taper, speed). Only anti-aliasing differs (Canvas 2D vs GL MSAA). |
| Other objects | Images: feasible (rect-based). Shapes/connectors/tape/audio: many sub-kinds; prototype draws them as outlined placeholders so they stay selectable. Neon glow and `cuts` clipping are drawn without the glow/clip and reported as approximate. |
| Geometry-based selection | Yes: distance to the ribbon (segment distance ≤ interpolated half-width). |
| Stable object identity | Not provided by the format. Use a **content fingerprint** per item (hash of the item JSON minus `group`, `locked`, `id`, `rec`, `rec_ms`), with an occurrence suffix for exact duplicates. Re-ordering does not break it; editing/moving an item does, and is reported. |
| Detect document change | SHA-256 of `manifest.json` stored in `reveal.json`; on mismatch, re-match by fingerprint and warn about unmatched/new items. |
| `.xnote` notebooks | Experimental reader built from `DocumentCodec`: pages stacked vertically (48 px gap), page-local items offset, lines/dots/grid paper, text boxes approximated. Tested only on a synthetic file; PDF backgrounds and custom templates are not drawn (reported). |

## 5. Technology choice

- TypeScript + React, **Canvas 2D**. Strokes are filled disc/hull unions,
  which map directly to one `Path2D` filled with the non-zero rule (no seams,
  translucent ink composited once). SVG would need thousands of nodes.
- `fflate` for ZIP. No backend, no database.
- Build with Bun's bundler (the npm registry is blocked on the corporate
  network; deps were installed from the local npm cache, Vite was not needed).
- Storage: `<name>.reveal.json` next to the untouched document. Chrome/Edge ask
  where once, then save silently; other browsers download it. Every change is
  also kept in the browser (localStorage, keyed by the document hash), so
  reopening the same `.xcanvas` restores the steps automatically.

## 6. Run

```sh
cd revealnotes
bun run dev        # http://localhost:5173
bun run typecheck
bun test
```
