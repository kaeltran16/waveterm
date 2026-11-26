# Board drawings: Arc lays out graphs

## Problem

The board drawer (`pkg/boarddrawer`, prompt `drawer-prompt.md`) replies with Excalidraw element skeletons and picks
every x/y/width/height itself. The frontend converts them (`boardconvert.ts`), routes bound arrows and frames the
drawing (`boardmodel.ts`), but nothing lays shapes out or checks collisions, and the drawer never sees the render or
measured text. On 2026-11-26 the "Agent workers" board (7-state lifecycle, ~10 labeled arrows) landed with arrow
labels stacked on each other in the middle and "admit memory" wider than the ~80px gap it sat in.

## Direction

The drawer may describe a **graph** (nodes, labeled edges, direction, optional groups) and Arc computes the layout
with a real layout algorithm over measured text. The graph is an **option, not a requirement**: free-form `add`
skeletons stay first-class, and one answer may carry both. The owner was explicit (2026-11-26): "dont compromise the
flexibility of the AI agent, the point of the whiteboards is for an agent to express freely". So Arc never moves or
nudges free-form shapes the drawer placed; it lays out only what the drawer hands it as a graph.

## Decisions

### D1. Layout engine: dagre on the skeleton format, not Mermaid

Chosen: the drawer emits a JSON `graph`; the frontend lays it out with dagre and emits ordinary skeletons that go
through the existing `convertToExcalidrawElements` path.

Rejected: the drawer emits Mermaid flowchart text, converted by `@excalidraw/mermaid-to-excalidraw`. Why not:

- **Text is measured in the wrong font.** Mermaid renders an SVG and sizes boxes and edge-label slots with its own
  font; Excalidraw then draws labels in Excalifont 20px. A label wider in Excalifont than in Mermaid's font overflows
  its slot, which is the exact bug being fixed. Laying out ourselves lets us measure with Excalidraw itself.
- **Go cannot check it.** `answer.go` checks every answer in code before it lands (counts, words per label, ids,
  scope). A JSON graph is checked with `encoding/json`; Mermaid text would need a Mermaid parser in Go or a check that
  only runs after landing.
- **It loses the mix.** Free-form shapes beside a graph, an arrow from a note to a node, per-node colors: all are
  plain JSON on the skeleton route and awkward-to-impossible in flowchart syntax plus a converter we do not own.
- **Weight and fragility.** The converter renders through the DOM asynchronously, loads all of Mermaid on landing, and
  is only a transitive dependency of `@excalidraw/excalidraw` whose output shape we would have to track.

Dependency: `dagre-d3-es` 7.0.13 is already installed (Mermaid's own flowchart layout uses it). It becomes a
**direct** dependency pinned at that installed version (`"dagre-d3-es": "7.0.13"`), so nothing new is downloaded
and an import of a transitive package does not silently break when Mermaid changes. Import its layout and graphlib
from `dagre-d3-es/src/dagre/index.js` and `dagre-d3-es/src/graphlib/index.js` (the package has no exports map; it
ships `.d.ts` per file).

### D2. The reply format

A drawing reply may carry `graph` beside `add`, `update`, `remove`:

```jsonc
"graph": {
  "direction": "TB",                         // TB | LR | BT | RL; absent = TB
  "nodes":  [{"id": "idle", "label": "idle", // id required, unique; label required, <= 12 words
              "shape": "rectangle",          // rectangle | ellipse | diamond; absent = rectangle
              "group": "g1",                 // optional, names a group
              "strokeColor": "#1e1e1e", "backgroundColor": "#a5d8ff"}],   // optional strings
  "edges":  [{"from": "idle", "to": "busy",  // must name nodes
              "label": "admit memory",       // optional, <= 12 words
              "dashed": true, "strokeColor": "#e03131"}],                 // optional
  "groups": [{"id": "g1", "label": "pool"}]  // optional; label <= 12 words
}
```

- Ids are unique across graph nodes, groups and `add` entries, since `add` arrows may bind to graph node ids.
- Two edges may join the same pair (a back-edge, or two labeled transitions): the layout uses a multigraph.
- Self-loops (`from == to`) are refused by Go: dagre cannot reserve a label slot on them and Excalidraw cannot bind
  both ends of an arrow to one shape usefully.
- Counting: a graph's nodes, edges and groups each count as one added shape, so `Answer.Added` = `len(add)` + nodes +
  edges + groups, and `MaxDrawingAdds` (40) bounds the total. The turn's "added" count stays truthful.
- `graph` must have at least one node.

### D3. Where it is checked, carried and laid out

- **Go** (`answer.go`) checks the graph's shape (D2 rules) and carries it as compact JSON text in `Answer.Graph`,
  delivered as `wshrpc.BoardAnswer.Graph` (`json:"graph,omitempty"`, JSON object text, like `Add` is array text).
  `task generate` adds `graph?: string` to the TS `BoardAnswer`.
- **Frontend** lays it out at landing, because only the frontend can measure Excalifont text: a pure module
  `boardlayout.ts` turns a graph into skeletons given a text measurer; `boardconvert.ts` supplies Excalidraw's
  measurement (converting a text skeleton and reading its width/height) and merges the result with `add`.
- Nothing about the graph is persisted. The landed drawing is plain Excalidraw elements, exactly like today; board
  files keep their format, and the drawer reads a laid-out drawing back as ordinary scene lines.

### D4. Labels cannot overlap: how the layout guarantees it

- **Node size from measured text.** A node is its measured label plus padding, scaled for the shape's inner area
  (rectangle: label + padding; ellipse: x sqrt 2; diamond: x 2), so Excalidraw never wraps or overflows a node label.
- **Line breaks are decided by Arc, not by Excalidraw's wrap.** Excalidraw wraps an arrow label at
  `max(0.7 x arrow bbox width, 20px x 11 = 220px)`; a vertical arrow's bbox is ~0 wide, so any label over 220px would
  re-wrap after layout and outgrow its slot. The layout therefore breaks every label (node and edge) greedily into
  lines no wider than 220px (`LABEL_MAX_WIDTH`) before measuring, so the measured box is the box that lands.
- **Edge labels get a slot.** Each labeled edge is given the label's measured width/height plus a margin with
  `labelpos: "c"`, so dagre ranks the label as its own dummy node and nothing else is placed there.
- **The label lands in its slot.** Excalidraw anchors an arrow's label at its middle point (odd point count) or the
  middle of its middle segment, and `routeArrow` keeps interior points and re-anchors the label there. The layout
  emits each arrow as a polyline through dagre's points whose exact middle point is dagre's label center.
- Spacing (`nodesep`, `ranksep`, `edgesep`) and margins are named constants in `boardlayout.ts`, picked so the
  fixture below passes D6; no tuning knob is exposed.

### D5. Groups

A group is a transparent, dashed rectangle around its members' laid-out bounds (dagre compound graph: `compound:
true`, `setParent`), with its label as a free text element inside its top band. The layout reserves that band (the
group grows upward by the title's height plus a margin, with the title's room accounted for before neighbors are
placed, e.g. a title-sized dummy member ranked first) so the title overlaps no member, no other label and no other
shape's outline (D6). Members are drawn above the group rectangle (group first in element order).

### D6. The overlap rule, checked in code

`textOverlaps(elements)` in `boardlayout.ts` returns the offending pairs (empty when clean), over live elements:

- Every pair of text elements (free text and bound labels of boxes and arrows) has disjoint bounding boxes.
- A text element's box that intersects a shape's box (rectangle, ellipse, diamond, frame excluded) lies wholly inside
  it: text may sit in a box (its own container, or a group) or clear of it, never across its outline.
- Arrow strokes are not checked (an arrow passing near a label is legible; a label on a label is not).

It runs in the layout's unit tests on the laid-out boxes, and in the CDP scenario on the elements that actually
landed in the live app, where Excalidraw measured the text.

### D7. Mixing `graph` and `add`

In one new drawing, the graph is laid out first at the origin; the `add` shapes keep their own relative layout and
are translated as a block so their bounds sit right of the graph's bounds by `MIX_GAP`, top-aligned. Arc does not
otherwise move them. An `add` arrow bound to a graph node is routed edge to edge by the existing `routeArrows`.

### D8. Edits

- An edit without `graph` is unchanged: `add`/`update`/`remove` in board coordinates, scoped to the drawing in view.
- **An edit with `graph` redraws the drawing in view**: its live shapes (and their bound text) are deleted, the new
  layout lands with its top-left at the old content's top-left, the frame keeps its id, title and drawing number and
  refits. This is how a follow-up like "add the retry state" stays laid out instead of the drawer hand-placing a box
  into a laid-out drawing. Go refuses `update` or `remove` alongside an edit's `graph` (the redraw replaces them);
  `add` is allowed and placed per D7.
- An edit with `graph` while no drawing is in view is refused, as any edit is today.

### D9. The prompt

The prompt documents `graph` as the way to draw boxes-and-arrows (flows, lifecycles, call paths, architecture),
says Arc places and sizes graph shapes so labels cannot collide, keeps `add` for everything a graph does not fit
(free sketches, timelines, layouts, annotations) and says both combine, and explains that an edit's `graph` redraws
the drawing. Prompt tests follow AGENTS.md: they assert only the reply-format text the Go side parses (the example
reply objects carrying `graph`), no wording.

## Acceptance

- The fixture: a 7-node lifecycle with 10 labeled edges including back-edges and a branch (the "Agent workers"
  shape: idle, admitted, running, blocked, reviewing, done, failed; edges such as "admit memory", "start",
  "wait on lock", "lock freed", "submit", "approve", "reject", "crash", "retry", "give up") lands with
  `textOverlaps` empty, checked in the layout unit test and on the landed elements in the live app.
- Existing board files open unchanged; free-form answers land exactly as before; the edit path (update/remove on the
  drawing in view) keeps its tests green.
- Prompt tests assert only reply-format text.
- The `boards-ask` CDP scenario has a step that feeds the fixture graph answer through the real applier, asserts
  `textOverlaps` on the landed elements is empty, and screenshots the board.

## Not done

- No re-layout or collision fixing of free-form shapes (owner direction: the drawer expresses freely).
- No persisted graph model on the frame; the drawer re-sends a graph to redraw.
- No edge routing around free-form shapes, and no arrow-stroke-vs-label check.
