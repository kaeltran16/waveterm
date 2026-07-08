# Memory graph improvements — design + implementation

2026-07-08. User request: "improve the memory graph, now it is too clanky and doesnt work great.
Do whatever you think is neccessary, including changing the library if you want to."
Full autonomy granted; brainstorming ran self-directed (no user Q&A available mid-task).

## Diagnosis — why it feels clanky

All root causes are in how the library is driven, not in the library itself:

1. **Every Graph↔List toggle re-simulates from scratch.** `MemorySurface` crossfades views with
   `AnimatePresence key={view}`, unmounting `MemGraph`. Node x/y live only inside the mounted sim,
   so each toggle replays the full phyllotaxis explosion + ~3s fly-in + snap `zoomToFit`.
2. **Search restarts the sim.** Filtered-out notes are *removed* from the graph data; any keystroke
   that changes the match set changes `graphSignature` → data rebuild → sim restart mid-typing.
3. **Blank, unframed start.** Labels are gated on engine-stop *and* (zoom > 1.2 or hover); the
   camera only frames on engine-stop. For the first ~3s the user watches unlabeled dots drift.
4. **No labels at rest.** The post-fit zoom is usually below the 1.2 label threshold, so the
   settled graph is a wall of anonymous dots until you hover one at a time.
5. **Physics gaps.** No collision force (nodes overlap in clusters); no gravity (disconnected
   components drift apart, forcing a tiny fit zoom).
6. **No controls.** No zoom in/out/fit affordance; selecting a related note from the detail rail
   doesn't reveal it in the graph; no pointer cursor on hoverable nodes.
7. **Hover churn.** Every mousemove over the background allocates fresh empty Sets via `setHover`,
   re-rendering the component.

## Decision: keep react-force-graph-2d

Swapping libraries (sigma.js, cytoscape, cosmograph) was considered and rejected: at vault scale
(~200 nodes, canvas 2D) the library is not the bottleneck — the restart-happy usage is. A swap
re-risks everything already working (theme-token canvas painting, drag, pointer mapping) for zero
addressable gain. `d3-force-3d` (force-graph's own physics engine, already in node_modules) is
promoted to a direct dependency to add the missing forces.

## Design

1. **Persistent layout + camera.** Module-level position cache (`Map<id, {x,y}>`) written on
   engine-stop and unmount; camera (zoom + center) saved on unmount. On mount, nodes seed from the
   cache and the camera restores — reopening the graph is instant and exactly where you left it.
   New nodes seed near a cached linked neighbor (deterministic jitter) so structural changes wobble
   locally instead of re-exploding.
2. **Search dims, never removes.** `MemGraph` receives the full note set plus a `filteredIds` set
   (null = no query). Non-matching nodes paint at ~0.06 alpha with no label; links dim unless both
   endpoints match; matches keep full color and are force-labeled when few (≤ 40). The sim is never
   touched while typing.
3. **Partial warmup + framed live settle.** Forces are configured *before* data is handed to the
   sim (render with empty data → configure forces in an effect → then feed real data). A partial
   warmup (~50 ticks) roughs the layout in off-screen, the camera restores or fits on the FIRST
   live tick, and the remaining ~1.5s of cooling plays as a short, framed organic settle. The
   settled-gate on labels is removed (labels ride along); the settle pulse (`useSettle`) stays.
   REVISED after user feedback: the first cut fully pre-warmed (200 ticks) which killed all motion
   — "it is worse, all the animation is gone". The clank was never the motion; it was motion
   playing unframed with a late snap-fit. Keep the life, frame it from tick one.
4. **Map-style tiered labels.** Label reveal threshold is a function of degree — hubs label at any
   zoom, mid-degree nodes from moderate zoom, leaves when zoomed in — like city labels on a map.
   The existing greedy de-collision keeps them overlap-free. Hover/selection/neighborhood always label.
5. **Physics: collide + gravity + tuned charge/link.** `forceCollide(radius+3)` stops overlap,
   weak `forceX/forceY` gravity keeps disconnected components in frame, charge distance-capped.
   Imported dynamically from `d3-force-3d` so it stays off the boot path with the graph chunk.
6. **Controls + selection reveal.** Overlay cluster (zoom in / zoom out / fit, lucide icons,
   surface-token styling); when `selectedId` changes to an offscreen node, the camera gently
   centers on it; pointer cursor over nodes.
7. **Hover guard.** Skip `setHover` when the hovered node id is unchanged.

## Implementation

1. `package.json`: add `d3-force-3d ^3.0.6` (already vendored transitively; zero new weight).
2. `memgraphlayout.ts`: add pure helpers — `labelZoomThreshold(deg)`, `seedPosition(id, edges,
   cache)` with deterministic id-hash jitter. Unit tests in `memgraphlayout.test.ts`.
3. `memgraph.tsx`: rework per design (cache, ready-gate force config, dim-based filtering, tiered
   labels, controls, selection reveal, hover guard, drop `useSettle`).
4. `memorysurface.tsx`: pass full `notes` + memoized `filteredIds` to `MemGraph`.
5. Verify: vitest (agents suite), typecheck via `node --stack-size=4000 .../tsc.js --noEmit`,
   visual pass over CDP against the live dev app if available.

Not in scope: minimap, node context menus, cluster coloring, WebGL renderer.
