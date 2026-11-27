# Memory tab round 1: split band text

**Verify:** `node scripts/verify.mjs ./pkg/memhygiene`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs setup-memory`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\memory-setup-fit\project\Main.dc.html

Final failed `setup-memory` step 1 on the merged result. In `SplitReview`
(`frontend/app/view/agents/setupmemory.tsx`), each `[data-memory-group]` band renders `{g.label}` then a
`<span>· {count}</span>` on the next line. JSX drops that newline whitespace, so the band's text reads
`Move here· 53`. The `gap-2` spaces it only visually. The scenario's `Move here · N` / `Copy here · N` check is
right, and so was the label as shown before the redesign: the view is what's wrong. The scenario stays as it is.

### Task 1: Split band reads "Move here · N"
**Depends on:** none
**Files:** `frontend/app/view/agents/setupmemory.tsx`

Each split group band's text content reads `<label> · <count>` with a real space before the `·` (for
example `Move here · 36`, `Copy here · 24`), as it did before the redesign, and looks the same as it does now.

- `scripts/cdp/scenarios-settings.mjs` is unchanged, and `setup-memory` passes all 13 steps under
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs setup-memory`. Step 1 is the one that shows the band.
