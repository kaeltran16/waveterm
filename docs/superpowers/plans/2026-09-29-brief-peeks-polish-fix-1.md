# Brief Peeks Polish, Fix Round 1

**Verify:** `node scripts/verify.mjs ./pkg/jarvisdossier/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-peeks-polish brief-contextual-map`

> **For agentic workers:** implement your one task in your worktree. Steps use checkbox (`- [ ]`) syntax. Do not spawn
> subagents or forks. Never write a `Co-Authored-By` or any other attribution trailer into a commit message.

**Goal:** Make the graph peek show records created after its first open, so `brief-peeks-polish` step 5 passes.

**Architecture:** `graphpeek.tsx` fetched the vault graph only while `graphLoadedAtom` was false, which happens once per
app session. Final round 1 ran `brief-contextual-map` first; that scenario opened the graph and loaded 11 nodes. Then
`brief-peeks-polish` seeded a long record through a deferred `createrun`. The seeded record had no node, so the map
button's `focusDossier` selected an id that `merged.nodes` does not contain. The side panel showed the empty hint, and
the "Open record" button never appeared. The human chose the product fix: refetch on every open.

**Tech Stack:** React 19, jotai, raw-CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-29-brief-peeks-polish-design.md`. See "Fix round 1" under Unchanged, and
Verification.

## Global Constraints

- Frontend only: no Go or wire-type change.
- Do not touch `frontend/app/view/jarvis/pet*`, `briefsurface.tsx`, `jarvisgraphstore.ts`, `jarvisgraph.tsx`, or
  `.superpowers/design/brief-peeks-polish`.
- `npx tsc` stack-overflows here: typecheck with the Check command above (about 2 minutes; give it a long timeout).
- Never run prettier on `scripts/*.mjs`.

## Review Focus

- The first open, with nothing loaded, still shows `GraphSkeleton` until the fetch lands. A reopen keeps the cached
  graph on screen: `graphLoadedAtom` must not flip back to false.
- A failed refetch after a good load sets `graphErrorAtom` (existing `loadGraph` behaviour). This round changes only
  when the fetch runs.

---

### Task 1: Refetch the vault graph on every graph-peek open

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/graphpeek.tsx` (the `loaded` effect, about lines 89-93)
- Modify: `scripts/cdp/scenarios.mjs` (the `brief-peeks-polish` step 5 detail)

- [ ] **Step 1: Refetch on mount.** In `graphpeek.tsx`, replace

```tsx
    useEffect(() => {
        if (!loaded) {
            fireAndForget(loadGraph);
        }
    }, [loaded]);
```

with

```tsx
    // refetch on every open, not only the first: a record captured since (every new run makes one) has no node
    // in a cached graph, so its map button would land on an empty panel. The cached graph stays on screen
    // until the refetch lands, and the canvas seeds positions from its cache, so known nodes do not move.
    useEffect(() => {
        fireAndForget(loadGraph);
    }, []);
```

`loaded` is still read for the skeleton branch; keep the `graphLoadedAtom` read. `loadGraph` in
`jarvisgraphstore.ts` is unchanged.

- [ ] **Step 2: Make step 5 say why it failed.** In `scripts/cdp/scenarios.mjs`, `briefPeeksPolish.assert`, replace

```js
        rec("5. the map button opens the graph peek with the record selected", focused, "");
```

with

```js
        const panel = focused
            ? ""
            : await h.ev(`(${PEEKS_GRAPH}?.innerText ?? 'no graph peek').replace(/\\s+/g, ' ').slice(0, 160)`);
        rec("5. the map button opens the graph peek with the record selected", focused, panel);
```

- [ ] **Step 3: Typecheck.** Run the Check command. Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/jarvis/graphpeek.tsx scripts/cdp/scenarios.mjs
git commit -m "fix(jarvis): graph peek refetches the vault on every open"
```
