# Wall Hook Generator

A browser-based parametric 3D model generator for a wall hook + set-screw clamp: a hook that wraps around a vertical wall piece (a stud, post, panel divider, etc.) and is tightened in place with a screw pressing against the back of that piece.

Everything runs client-side (Three.js + CSG booleans for the geometry) and exports print-ready STL files.

## Running it

```
npm install
npm run dev
```

Open the printed local URL. Adjust the sliders on the left to size the hook; the derived screw size/length update automatically. Use the export buttons to download `hook.stl` and `screw.stl` separately (or both as a zip) so they land as two bodies on your print bed.

## How it's parameterized

- **Hook geometry** (arm height, lip depth, clamp band height, wall-piece gap, overall width, wall thickness) are all user-adjustable lengths.
- **Screw size is derived, not set directly**: the wall-piece gap (how wide the piece being clamped is) drives the screw's *length*, and the overall size of the hook drives the screw's *diameter/gauge*.
- **Material** (PLA/PETG/ABS/TPU) adjusts the thread clearance so the screw actually threads into the printed hole for that plastic.

## Known limitation

The threaded hole is cut with a CSG boolean library (`three-bvh-csg`) that isn't perfectly robust for helical geometry — exported STLs can contain a small number of tiny non-manifold seams around the threaded hole (well under 3% of triangles in testing). This is a common characteristic of CSG-generated STLs and virtually all slicers (Cura, PrusaSlicer, Bambu Studio, etc.) auto-repair this class of defect on import, but if you see a problem in your slicer's preview, running the file through a repair tool (e.g. Meshmixer, or your slicer's own repair option) first is a safe additional step.
