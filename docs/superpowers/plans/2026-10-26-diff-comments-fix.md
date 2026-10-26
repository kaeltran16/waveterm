# Diff comments: fix round

**Spec:** `docs/superpowers/specs/2026-10-26-diff-comments-design.md` (the "send clears the batch" rule and the builder decisions on `sendBatch`).

One defect left by the first round (t-2's "Found not fixed"): `sendBatch` clears the whole batch with `discardBatch(key)` after the hand-over, so a comment added while `io.prompt` or `io.launch` is still pending is deleted without ever being sent. The window is the length of a `launchAgent` call, a few seconds, and the composer stays usable while the bar shows sending.

### Task 1: Clear only the sent comments after a send

**Depends on:** none

**Files:** `frontend/app/view/agents/diffcomments.ts`, `frontend/app/view/agents/diffcomments.test.ts`, `frontend/app/view/agents/commentsend.ts`, `frontend/app/view/agents/commentsend.test.ts`

**Interfaces:**
- Produces: `removeComments(key: string, ids: string[]): void` in `diffcomments.ts`. It removes from batch `key` the comments whose id is in `ids` and keeps every other comment. When none remain it deletes the batch, as `discardBatch` does. When the batch is missing or no id matches it writes nothing (neither `commentStoreAtom` nor localStorage), as `deleteComment` does. A batch that keeps comments is written like `deleteComment` writes one.
- `sendBatch(batch, r, io)` keeps its signature. On a successful hand-over, live or new, it calls `removeComments(key, batch.comments.map((c) => c.id))` in place of `discardBatch(key)`. A failed hand-over still removes nothing. The sent note's `count` stays `batch.comments.length`, the number actually sent.
- `discardBatch` is unchanged: the bar's Discard still drops the whole batch.

**Decisions:**
- The ids come from the `batch` argument, the snapshot the prompt was built from, so "sent" means exactly what went into the prompt. A comment deleted from the store during the send was still sent; removing a missing id is a no-op.

- [ ] **Step 1: Write the failing tests**

In `diffcomments.test.ts`:
- `removeComments keeps a comment that is not in ids`: a batch with comments a, b, c; `removeComments(key, [a.id, b.id])` leaves the batch with only c, and localStorage holds the same.
- `removeComments deletes the batch when every comment is removed`: `store[key]` is undefined afterwards.
- `removeComments writes nothing when no id matches`: the atom value is the same object (`toBe`) and `setItem` was not called; the same for a missing key.

In `commentsend.test.ts`:
- `sendBatch keeps a comment added while a live send is in flight`: `io.prompt` returns a promise the test resolves by hand; before resolving it, `addComment` adds a comment to the same source; after `sendBatch` resolves, the stored batch holds only the added comment, and the sent note's count is the original batch's length.
- `sendBatch keeps a comment added while a new agent is starting`: the same with `io.launch` and a `new` recipient.
- The existing tests that expect the batch gone after a successful send still pass unchanged.

- [ ] **Step 2: Run the tests and see the new ones fail**

Run: `npx vitest run frontend/app/view/agents/diffcomments.test.ts frontend/app/view/agents/commentsend.test.ts`
Expected: the new tests fail (`removeComments` is not exported; the added comment is gone).

- [ ] **Step 3: Implement `removeComments` and switch `sendBatch` to it**

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run frontend/app/view/agents/diffcomments.test.ts frontend/app/view/agents/commentsend.test.ts`
Expected: all pass. Then `task check:ts` exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/diffcomments.ts frontend/app/view/agents/diffcomments.test.ts frontend/app/view/agents/commentsend.ts frontend/app/view/agents/commentsend.test.ts
git commit -m "fix(diff): keep a comment added while its batch is being sent"
```
