# Board drawings: Arc lays out graphs

**Spec:** `docs/superpowers/specs/2026-11-26-board-graph-layout-design.md` (decisions D1-D9 settle format, engine, overlap rule, edits)
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/boarddrawer ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask`

### Task 1: The drawer may answer with a graph (Go, wire, prompt)
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `frontend/types/gotypes.d.ts`, `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`, `pkg/boarddrawer/drawer.go`, `pkg/boarddrawer/drawer_test.go`, `pkg/boarddrawer/drawer-prompt.md`, `pkg/boarddrawer/prompt_test.go`

`CheckAnswer` accepts the optional `graph` key of spec D2, checks it, and carries it as compact JSON in `Answer.Graph`; `drawer.go` delivers it as `BoardAnswer.Graph`; `task generate` regenerates `gotypes.d.ts`. The prompt documents `graph` per D9, keeping free-form `add` first-class.

**Interfaces:** `wshrpc.BoardAnswer` gains `Graph string` with JSON tag `graph,omitempty` (JSON object text); TS `BoardAnswer.graph?: string`.

**Acceptance:**
- D2's rules refuse with an unusable reason: unknown direction or shape, a node without id or label, a duplicate id across nodes, groups and `add`, an edge naming a missing node, a self-loop, a node naming a missing group, a label over `MaxLabelWords`, a graph with no nodes; an `add` arrow binding a graph node id is accepted.
- `Answer.Added` counts `add` entries plus nodes, edges and groups, and `MaxDrawingAdds` bounds that total; a graph-only answer is a drawing (`HasDrawing`).
- An edit with `graph` and `update` or `remove` is refused; an edit with `graph` and no drawing in view is refused; an edit with `graph` delivers `DrawingId` as edits do today.
- Answers without `graph` check and deliver exactly as before (existing tests green, unchanged).
- Prompt tests assert only reply-format text (an example reply carrying `graph`), no wording (AGENTS.md).

### Task 2: Lay out a graph so no label overlaps (pure module)
**Depends on:** none
**Files:** `package.json`, `package-lock.json`, `frontend/app/view/boards/boardlayout.ts`, `frontend/app/view/boards/boardlayout.test.ts`

Add `dagre-d3-es` as a direct dependency pinned `7.0.13` (D1) by editing `package.json` and the root entry (`packages[""].dependencies`) of `package-lock.json` by hand: it is already in the lock and in `node_modules`, and an `npm install` in a tree whose `node_modules` is a junction to the main checkout rewrites main's install. `boardlayout.ts` is pure (no Excalidraw runtime): it lays a graph out with dagre over measured, Arc-broken labels (D4), draws groups (D5), places `add` beside the graph (D7), and implements the overlap rule (D6).

**Interfaces:**
```ts
export interface BoardGraph { direction?: "TB" | "LR" | "BT" | "RL"; nodes: GraphNode[]; edges?: GraphEdge[]; groups?: GraphGroup[] } // fields per spec D2
export type MeasureLabel = (text: string) => { width: number; height: number }; // one Excalifont 20px text, newlines kept
export function layoutAnswer(graph: BoardGraph | null, add: readonly ExcalidrawElementSkeleton[], measure: MeasureLabel): ExcalidrawElementSkeleton[];
export function textOverlaps(elements: readonly ExcalidrawElement[]): [string, string][]; // offending id pairs, [] when clean
```

**Acceptance:**
- `layoutAnswer(null, add, m)` returns `add` unchanged.
- The spec's fixture (7 nodes, 10 labeled edges with back-edges and a branch) in each of TB and LR, and a grouped variant, lay out with node skeleton ids equal to node ids and every label box (node labels centered in their node, edge labels centered on the arrow's middle point, group titles) passing `textOverlaps`, using a deterministic test measurer.
- No label line measures over `LABEL_MAX_WIDTH` (220); each labeled arrow's middle point is its label center (odd point count).
- With `add`, the add block keeps its relative layout and sits right of the graph's bounds, top-aligned.
- `textOverlaps` flags two intersecting texts and a text straddling a shape's outline, and passes text wholly inside a box or wholly outside it.

### Task 3: Land laid-out drawings and redraw on edit
**Depends on:** Task 1 (the generated `BoardAnswer.graph` field), Task 2 (uses `layoutAnswer` and `textOverlaps`)
**Files:** `frontend/app/view/boards/boardconvert.ts`, `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`, `scripts/cdp/scenarios-boards-ask.mjs`

`landAnswer` parses `answer.graph`, measures labels with Excalidraw (converting a text skeleton and reading its size), and converts `layoutAnswer`'s skeletons. `applyAnswer` redraws on an edit with `graph` (D8): the frame's live shapes and their bound text are deleted, the added shapes land with their top-left at the old content's top-left, and the frame keeps its id, title and number and refits.

**Acceptance:**
- `applyAnswer` on an edit with `graph`: old shapes of that drawing deleted, other drawings untouched, new shapes joined to the same frame at the old top-left, frame refit; without `graph` an edit behaves as before (existing tests green).
- Board files on disk open unchanged; a free-form answer lands as before.
- `boards-ask` gains a step that feeds the spec's fixture as a graph answer through the real applier (the existing `feedAnswer` path, extended to send `graph`), asserts `textOverlaps` on the landed elements of the new frame is empty (in the page, importing `boardlayout.ts`), and screenshots the board with the laid-out drawing.
