# Project: RevealNotes — XNotes Companion Tool

## 1. Objective

Build a lightweight application that works with existing XNotes/XCanvas documents and converts handwritten notes into interactive, progressively revealed lessons.

The user creates all handwritten content in the existing XNotes application using an Android tablet and stylus.

Our application should add only the missing functionality: selecting handwritten elements, assigning reveal stages, and presenting the lesson progressively.

**Do not build another handwriting application. Do not fork or modify XNotes initially.**

## 2. Existing Input File

A sample file is available:

`untitled_1.xcanvas`

Location: supplied project attachment.

Initial inspection indicates:

- The file is a ZIP archive.
- It contains `manifest.json`.
- Format: `xcanvas`.
- Version: 1.
- Drawing objects are stored as individual strokes.
- Each stroke contains:
  - Tool type.
  - Pen configuration.
  - RGBA colour.
  - Base width.
  - Pressure information.
  - Individual coordinate samples.
  - Smoothness information.

Example structure:

```json
{
  "format": "xcanvas",
  "version": 1,
  "items": [
    {
      "kind": "stroke",
      "tool": "pen",
      "config": {
        "base_width": 5.83,
        "pressure_enabled": true,
        "rgba": [0, 196, 255, 255]
      },
      "samples": [
        [1935.29, 2707.72, 0.378],
        [1936.09, 2707.54, 0.363]
      ]
    }
  ]
}
```

This is preliminary inspection, not a complete specification of the format.

Preserve all original document information.

## 3. Phase 1: Investigate Before Coding

First investigate:

1. Actual XCanvas file structure.
2. XNotes source code and document serialization.
3. Stroke rendering and pressure calculations.
4. Coordinate transformations and canvas positioning.
5. Support for shapes, images, text and other drawing objects.
6. Multi-page `.xnotes` notebook structure.
7. Whether the format contains stable identifiers for drawing objects.

Do not assume that `.xcanvas` and `.xnotes` have identical structures.

Inspect the official repository:

https://github.com/shardulvs/xnotes-android

Use its source code as a reference, but do not modify it.

Produce a short technical feasibility report before implementation.

## 4. Phase 2: Build a Working Viewer

Create a lightweight application that:

- Opens `.xcanvas` documents.
- Extracts the manifest.
- Renders the original handwriting accurately.
- Preserves original coordinates, colours, thickness and pressure appearance.
- Supports zooming and panning.
- Supports multiple drawing object types wherever feasible.

Compare the rendered output against the original XNotes document.

Do not proceed until rendering is sufficiently accurate.

## 5. Phase 3: Selection and Reveal Assignment

Implement a selection tool.

The user should be able to:

1. Select individual strokes.
2. Select multiple strokes.
3. Drag a selection rectangle around strokes.
4. Assign selected objects to a reveal stage.
5. Change their assigned stage.
6. Set objects as permanently visible.

Example:

| Content | Reveal stage |
|---|---|
| Problem statement | Always visible |
| Example | Stage 1 |
| Manual reasoning | Stage 2 |
| Brute-force code | Stage 3 |
| Frequency visualization | Stage 4 |
| Optimization | Stage 5 |

Selection must work using actual stroke geometry, not just approximate bounding boxes where avoidable.

## 6. Phase 4: Non-destructive Storage

Never modify the original XNotes document.

Store reveal information separately.

Suggested structure:

```text
SetMismatch/
    original.xcanvas
    reveal.json
```

Example metadata:

```json
{
  "version": 1,
  "document": "original.xcanvas",
  "objects": {
    "stroke_1": {
      "stage": 0
    },
    "stroke_2": {
      "stage": 1
    },
    "stroke_3": {
      "stage": 2
    }
  }
}
```

Important:

- Establish stable object identification.
- Do not rely solely on array indices if object ordering can change.
- Preserve metadata when editing reveal assignments.
- Detect when the original document has changed.
- Provide a warning rather than silently applying potentially incorrect assignments.

## 7. Phase 5: Presentation Mode

Create a clean, distraction-free presentation interface.

Features:

- Initially show always-visible objects.
- Next reveals the next stage.
- Previous hides the previous stage.
- Reveal All.
- Restart lesson.
- Full-screen mode.
- Page navigation.
- Keyboard shortcuts.

Suggested shortcuts:

| Key | Action |
|---|---|
| Right Arrow | Next stage |
| Left Arrow | Previous stage |
| Space | Next stage |
| A | Reveal all |
| R | Restart |
| F | Full screen |

Use the original handwriting appearance.

Do not introduce unnecessary animations initially.

## 8. Phase 6: Export

Eventually support standalone HTML export.

The exported lesson should:

- Work offline.
- Require no application installation.
- Work on Windows, macOS, Android and iPad browsers.
- Preserve handwriting quality.
- Preserve reveal stages.
- Support presentation controls.

Do not make HTML export a dependency for completing the first prototype.

## 9. Technology

Prefer a lightweight web application initially.

Suggested stack:

- TypeScript.
- React.
- SVG or Canvas rendering.
- ZIP extraction library.
- JSON metadata.
- Local file storage.

Choose the rendering technology after inspecting the source format.

Avoid building a backend, authentication, cloud storage or database.

## 10. Development Milestones

Milestone 1:
Open and accurately render the supplied `.xcanvas` file.

Milestone 2:
Select individual strokes and assign reveal stages.

Milestone 3:
Present the document progressively.

Milestone 4:
Save and reopen reveal metadata without modifying the original file.

Milestone 5:
Test multiple documents and investigate `.xnotes` notebook support.

Milestone 6:
Export standalone interactive HTML.

## 11. Important Constraints

- Do not recreate XNotes.
- Do not fork XNotes initially.
- Do not flatten handwriting into a single image.
- Do not modify original documents.
- Do not introduce unnecessary features.
- Do not assume undocumented file-format behaviour.
- Do not claim compatibility with `.xnotes` until tested.
- Keep the application local-first and offline-capable.

## 12. Definition of Success

The first prototype is successful when I can:

1. Open my actual XCanvas document.
2. See my handwriting accurately.
3. Select three different groups of strokes.
4. Assign them to three different reveal stages.
5. Save the lesson.
6. Reopen it.
7. Press Next and watch each group appear progressively.

Prioritise this complete working workflow over visual polish.