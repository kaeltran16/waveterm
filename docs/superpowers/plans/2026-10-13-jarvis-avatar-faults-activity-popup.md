# Jarvis avatar: faults, activity, desktop popup — Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/jarvis ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs jarvis-avatar jarvis-avatar-faults jarvis-avatar-activity attention-popup`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/avatar-ideas/project/

**Goal:** The Jarvis avatar gains two faults (link lost, run held), an activity register driven by the number of working agents, and a 96px copy of itself in the desktop attention popup. Dead memory-era PetEvent kinds are removed.

**Architecture:** The pure layers decide and the renderers draw, as today. petcondition.ts ranks the faults (link lost > run held > tired), and avatarscene.ts holds their moods and draws the activity pulses. petmotion.ts maps the working count to tempo, and petview.tsx gathers the signals and runs the loop. The connection state is a new pure module beside ws.ts. The popup gets the main window's face in its show payload and draws it with the 2D renderer (avatarcanvas.ts), never three.js.

**Tech Stack:** React 19, jotai, TypeScript (vitest), Go (wshrpc types + `task generate`), Tauri events, CDP scenarios (`scripts/cdp/scenarios.mjs`).

The design canvas named on the Prototype line is the spec. Its boards are Main (faults), Activity and Popup, and every board state must be reached by a scenario step below. Its `hologram.js` is a 2D port of avatarscene.ts. Treat the mood numbers drawn there as starting values only.

## Global Constraints

- Precedence: link lost (rank 1) > run held (rank 2) > tired (rank 3) > at-rest. Posture (review-gate / escalation / blocked-worker) is unchanged and composes with any fault.
- Run held reads `run-land-held` attention items ONLY. Never `run-unverified`.
- Link lost stands only after the socket has been down `LINK_GRACE_MS = 3000` ms, and only after the first successful connect.
- Peek lead lines, first person, worded in `conditionLine` only:
  - link lost: `I can't reach the backend — nothing here has updated since HH:MM.` (local time of the drop)
  - run held: `<run name> can't land — <hold reason>.`
- Activity: the breath period is 4.8s at 0 working, about 3.4s at 2, and 1.9s at 6 or more (`BREATH_MS` becomes 4800). Load also deepens the breath. Inbound strut pulses start at irregular offsets and their rate rises with load.
- Activity never draws a countable count or a constant rotation. Nothing changes at 0 working beyond the new 4.8s base, and reduced motion draws neither breath nor pulses.
- The 40% quiet dim stays. Working agents never make the avatar fully present (`quiet` is untouched by activity).
- Popup: a 96px avatar sits to the right of the bubble card, bottom-aligned with it. It wears the main window's expression and posture plus the voice surge, and is drawn with avatarcanvas.ts (no three.js import in the popup bundle). Clicking it does what clicking the card does, and the popup still takes no focus.
- Colours are `--color-*` token names, never literals. Pure logic lives in `.ts` files with `.test.ts` beside them (no jsdom render tests).
- Never hand-edit generated files (`frontend/types/gotypes.d.ts` etc.). Change the Go type, then run `task generate`.
- The dev-only window hooks named below are wrapped in `if (import.meta.env.DEV)`, like `__wavePetStore` in petstore.ts.

## Review Focus

1. **A reconnect blip.** wavesrv restarts or the socket closes and reopens within 3s, and the avatar never turns grey. Task 1 pins this with a `linkLostSince` test at 2,999 ms down → null.
2. **Boot before the first connect.** The socket has never opened, and that is not "link lost" (boot failure is shown elsewhere). Task 1 pins this with `everConnected: false` → null.
3. **Working count changes mid-breath.** Going from 0 to 6 working must change tempo without a jump in breath or pulse phase. Task 5 pins this with an `advancePhase` continuity test, and Task 6 makes the loop accumulate phase.
4. **A run-held reason that is empty or already ends in a period.** The line never reads `can't land — .` or ends in `..`. Task 4 tests both.
5. **The popup raised while the main window has never drawn a face** (first poll after boot), or a payload with no face. The popup still shows the card, and the avatar draws at-rest/none. Task 7 tests the payload fallback.

---

### Task 1: Connection state signal

**Depends on:** none
**Files:** `frontend/app/store/wslink.ts`, `frontend/app/store/wslink.test.ts`, `frontend/app/store/ws.ts`, `frontend/app/store/ws.test.ts`

Nothing in the frontend tracks the wavesrv connection today. Add a pure module and wire ws.ts to it.

**Interfaces (produced):**
- `export type WsLink = { connected: boolean; everConnected: boolean; lostAt: number | null }` (`lostAt` is epoch ms of the last drop, or null while connected)
- `export const LINK_GRACE_MS = 3000`
- `export const INITIAL_LINK: WsLink = { connected: false, everConnected: false, lostAt: null }`
- `export function linkOpened(link: WsLink): WsLink` → connected, everConnected true, lostAt null
- `export function linkClosed(link: WsLink, nowMs: number): WsLink` → not connected. `lostAt` keeps an earlier drop time if already disconnected (a failed retry must not reset "since").
- `export function linkLostSince(link: WsLink, nowMs: number): number | null` → `lostAt` only when `everConnected && !connected && nowMs - lostAt >= LINK_GRACE_MS`, else null
- `export const wsLinkAtom: PrimitiveAtom<WsLink>` (jotai, set through `globalStore` from `@/app/store/jotaiStore`)
- DEV only: `globalThis.__waveLink = { get(): WsLink; set(link: WsLink): void }` for CDP

**Decisions:**
- ws.ts writes the atom in `WSControl.onopen` (`linkOpened`) and in `onclose`. A close while neither open nor opening still counts as a failed retry and goes through `linkClosed` so `lostAt` holds.
- When ws.ts gives up after 20 retries, it leaves the link lost.
- ws.ts keeps its existing behaviour otherwise. It is the only writer apart from the DEV hook.

**Acceptance (focused tests, `npx vitest run frontend/app/store/wslink.test.ts`):**
- open → close at t → `linkLostSince` is null at t+2999 and t at t+3000
- close → close again at t+5000 (failed retry) → `lostAt` stays t
- never opened, then closed → `linkLostSince` is always null
- close then open → null, `lostAt` null
- wiring, in `frontend/app/store/ws.test.ts` (it already builds a `WSControl` with a stub socket): `onopen` sets `wsLinkAtom` connected, and a later `onclose` sets it lost with `lostAt` near now (`npx vitest run frontend/app/store/ws.test.ts`)

### Task 2: Hold reason on the attention item

**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_channels.go`, `pkg/jarvis/attention.go`, `pkg/jarvis/attention_test.go`, `frontend/types/gotypes.d.ts`

The run-held lead line needs the bare hold reason. Do not parse it out of `text`, which carries the prefix `"The run's branch was not merged back: "`.

**Decisions / interfaces (produced):**
- Add a `Reason` string field (json tag `reason,omitempty`) to `wshrpc.AttentionItem`, with a one-line comment saying it is set only for `run-land-held`.
- `pkg/jarvis/attention.go` (the run-land-held builder, around `Kind: AttentionRunLandHeld`) sets `Reason: run.Land.Reason`. `Text` stays unchanged.
- Run `task generate` so `AttentionItem` in `frontend/types/gotypes.d.ts` gains `reason?: string`. Commit only the generated files that changed.

**Acceptance:**
- Extend the existing run-land-held assertions in `pkg/jarvis/attention_test.go` (`TestBuildAttentionFindsAHeldLandInANonActiveChannel`, `TestHeldLandSaysWhy`) so `got.Reason` equals the land's reason. In `TestUnverifiedRunNamesEachReasonUntilAcknowledged`, check that a `run-unverified` item has an empty `Reason`. Run: `go test ./pkg/jarvis -run '^(TestBuildAttentionFindsAHeldLandInANonActiveChannel|TestHeldLandSaysWhy|TestUnverifiedRunNamesEachReasonUntilAcknowledged)$' -v`, and confirm all three show in the output as run.

### Task 3: Activity tempo (pure motion)

**Depends on:** none
**Files:** `frontend/app/view/jarvis/petmotion.ts`, `frontend/app/view/jarvis/petmotion.test.ts`

**Interfaces (produced):**
- `BREATH_MS` becomes `4_800` (approved: the canvas specimens breathe at 4.8s)
- `export const BREATH_MIN_MS = 1_900`, `export const ACTIVITY_FULL = 6`
- `export function activityLevel(working: number): number`: 0..1 load, 0 at 0, 1 at ≥6, concave. Use `(min(working, 6) / 6) ** 0.66`, which puts 2 working near 0.48. Non-finite or negative input gives 0.
- `export function breathPeriodMs(working: number): number` = `BREATH_MS - (BREATH_MS - BREATH_MIN_MS) * activityLevel(working)`, so 4800 at 0, about 3400 at 2 (±100), and 1900 at 6 and at 20
- `export function pulseRate(level: number): number`: pulse-clock speed in cycles per second, 0 at level 0, rising with level (the canvas uses `0.25 + level * 0.75` when level > 0)
- `export function advancePhase(phase: number, dtMs: number, periodMs: number): number`: accumulates a 0..1 phase (`(phase + dt/period) mod 1`). dt is clamped to 0..1000 like `approachMood`. A non-finite or non-positive period leaves the phase unchanged.
- `breathPhase` keeps its raised-cosine shape. Add `export function breathFromPhase(phase: number): number` (the same `(1 - cos(2π·phase)) / 2`), so the loop can feed an accumulated phase. Keep `breathPhase(now, period)` for existing callers.

**Acceptance (`npx vitest run frontend/app/view/jarvis/petmotion.test.ts`):**
- the `breathPeriodMs` anchors above, and monotone non-increasing over 0..10
- `activityLevel(0) === 0` and `pulseRate(0) === 0`, so nothing new at rest
- continuity: switching the period from 4800 to 1900 mid-breath, `advancePhase` output differs from the previous phase by at most `dt / 1900`, so there is no jump
- `advancePhase` with dt 5000 (a backgrounded tab) advances by at most 1000/period

### Task 4: Faults — conditions, moods, peek, signals, faults scenario

**Depends on:** Task 1, Task 2
**Files:** `frontend/app/view/jarvis/petcondition.ts`, `frontend/app/view/jarvis/petcondition.test.ts`, `frontend/app/view/jarvis/avatarscene.ts`, `frontend/app/view/jarvis/avatarscene.test.ts`, `frontend/app/view/jarvis/petpeekmodel.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`, `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/petview.tsx`, `scripts/cdp/scenarios.mjs`

**Interfaces (consumed):** `wsLinkAtom`, `linkLostSince` (Task 1); `AttentionItem.reason` (Task 2).

**Interfaces (produced):**
- `PetSignals` gains `link?: { lostAt: number }` (present only when `linkLostSince` is non-null) and `heldLand?: { runName: string; reason: string }` (the first `run-land-held` item in `attentionAtom` rank order: `runName` = item.source, `reason` = item.reason ?? "")
- `PetExpression` gains `{ kind: "link-lost"; lostAt: number }` and `{ kind: "run-held"; runName: string; reason: string }`
- `EXPRESSION_RANK`: `"link-lost": 1, "run-held": 2, tired: 3, "at-rest": 4`. Update the header comment's precedence list (canvas "Precedence" card wording).
- `conditionsFor` emits link-lost, then run-held, then tired. That is one condition per kind, since the peek keys condition rows by kind.
- `conditionLine` adds the two lines from Global Constraints. HH:MM is local 24h, zero-padded (from `lostAt`). For run held: with an empty reason the line is `<run name> can't land.`, and a reason that already ends in `.` adds no second period.
- `MOODS` in avatarscene.ts starts from the canvas:
  - `"link-lost": { toneVar: "--color-muted", energy: 0.4, align: 0.92, jitter: 0.9, spin: 0.2 }`
  - `"run-held": { toneVar: "--color-error", energy: 0.72, align: 0.35, jitter: 0.06, spin: 0.55 }`
  - Tune these numbers from this task's scenario screenshots at 132px until the four faces (at rest, tired, link lost, run held) read apart. Record the final values with a one-line "why" comment each.
- petpeekmodel.ts `READOUT_KINDS` adds `"link-lost"` (no remedy). Run held is not a readout, because its Retry land / Dismiss acts live on that item's own peek row.
- petpeek.tsx `conditionDot`: link-lost → `bg-muted`, run-held → `bg-error`.
- petview.tsx `usePetSignals` reads `wsLinkAtom` and `model.nowAtom` (already read) and `attentionAtom` to fill `link` and `heldLand`. `quiet` needs no change, because a fault is not at-rest.

**Decisions:** Do not touch `postureFor` or `run-unverified`. In the faults scenario, the link-lost state is held through `__waveLink.set` because a real ws drop reconnects in 0s. Restore the saved link in teardown.

**Acceptance:**
- `npx vitest run frontend/app/view/jarvis/petcondition.test.ts frontend/app/view/jarvis/avatarscene.test.ts frontend/app/view/jarvis/petpeekmodel.test.ts`:
  - precedence: with all three signals present `expressionFor` is link-lost, and `conditionsFor` lists [link-lost, run-held, tired]. With link and held, run-held is second.
  - a `run-unverified` item never yields run-held. Test this through the pure helper that picks `heldLand` from an `AttentionItem[]`, exported from petcondition.ts as `heldLandFrom(items: AttentionItem[]): PetSignals["heldLand"]`.
  - the posture still composes: `postureFor` with a gate and a held land → review-gate while `expressionFor` → run-held
  - both new lines, including the empty-reason and trailing-period cases
  - `moodFor` returns a `--color-*` toneVar for every kind, and the four moods differ pairwise in tone or in (align, jitter) by a clear margin (assert align differs ≥ 0.3 or jitter ≥ 0.3 or tone differs)
  - `peekConditions` marks link-lost readout and run-held not
- New CDP scenario `jarvis-avatar-faults` (surface cockpit) in `scripts/cdp/scenarios.mjs`, registered like `jarvisAvatar`. Each step asserts `window.__jarvisAvatarScene.expression` / `.posture` and takes a screenshot `cdp-shots/jarvis-avatar-fault-<state>.png`:
  1. at rest: `__wavePetStore.setAttention([])` and a link that is up → expression at-rest, posture none
  2. tired: set `localStorage['wave:ratelimits']` the way the usage scenarios do (`usageRateLimits()`), then reload → expression tired
  3. link lost: `__waveLink.set({ connected: false, everConnected: true, lostAt: Date.now() - 10_000 })` → expression link-lost, and the open peek's `[data-pet-condition="link-lost"]` text starts `I can't reach the backend`
  4. run held: `setAttention([<run-land-held item with source and reason>])` → expression run-held, and the peek lead line names the run and the reason
  5. run held + gate waiting: `setAttention([run-land-held, dag-gate])` → expression run-held, posture review-gate
  - take each shot promptly, since the 10s attention poll overwrites `setAttention`
  - teardown restores ratelimits, the link (saved via `__waveLink.get()`), attention, and closes the peek

### Task 5: Cleanup — memory-era PetEvent kinds

**Depends on:** Task 4
**Files:** `frontend/app/view/jarvis/petvoice.ts`, `frontend/app/view/jarvis/petvoice.test.ts`, `frontend/app/view/jarvis/petstore.test.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`

Nothing has produced these since the memory removal on 2026-09-22.

**Decisions:**
- petvoice.ts: remove `"sweep"` and `"distill-batch"` from `PetEvent["kind"]` and from `KIND_LABEL`. Remove `reportedAsCondition`, the `speakable` filter in `nextUtterance` (`utterance` becomes the newest unseen, and `heard` filters only `transient`), and the header comment's "Report each thing once" rule.
- Rewrite the `sources` comment's "a distillation pass carries the notes it wrote" clause, which describes a removed producer. Check `petjoin.ts` for the same reference and leave it if it is not about these kinds.
- petvoice.test.ts: delete the report-once tests (the ones building `reportedAsCondition: true`) and switch the `ev()` helper's default kind from `"sweep"` to `"bg-agent-done"`.
- petstore.test.ts and petpeekmodel.test.ts: their `"sweep"` fixtures become `"bg-agent-done"`. Keep each test's intent and change only the kind.
- Before deleting, grep `frontend` and `scripts/cdp` for `reportedAsCondition`, `"sweep"` and `distill-batch` as PetEvent kinds. The Go `"sweep"` strings in `pkg/agentobserve` and `pkg/jarvisvolunteer` are unrelated and stay.

**Acceptance:** `npx vitest run frontend/app/view/jarvis/petvoice.test.ts frontend/app/view/jarvis/petstore.test.ts frontend/app/view/jarvis/petpeekmodel.test.ts` passes, the Check line's tsc is clean, and the grep above finds none left.

### Task 6: Activity in the scene and the loop, activity scenario

**Depends on:** Task 3, Task 4
**Files:** `frontend/app/view/jarvis/avatarscene.ts`, `frontend/app/view/jarvis/avatarscene.test.ts`, `frontend/app/view/jarvis/petview.tsx`, `frontend/app/view/jarvis/petstore.ts`, `scripts/cdp/scenarios.mjs`

**Interfaces (consumed):** `activityLevel`, `breathPeriodMs`, `pulseRate`, `advancePhase`, `breathFromPhase` (Task 3).

**Interfaces (produced):**
- `SceneInput` gains `activity?: number` (0..1, from `activityLevel`) and `pulseClock?: number` (accumulated pulse cycles, unbounded float). Both are OPTIONAL and default to 0, so the existing callers need no change and an omitted field means "no activity": the `sceneOf` helpers in `avatarcanvas.test.ts` / `avatarthree.test.ts` and Task 7's `popupavatar.tsx`, which runs concurrently. Both are ignored when `still`.
- `buildAvatarScene`:
  - the breath depth term (today `0.16` in `glow`) rises with activity, to 0.26 at activity 1 (the canvas: "quickens and deepens")
  - when `activity > 0 && !still`, draw inbound strut pulses as in hologram.js: per strut a short `"hot"`, `STROKE.heavy` segment from the strut's outer end toward the core (radius 0.42, z -0.25). Its phase is `(pulseClock + PULSE_SEEDS[i] * 3.1) % 1.6`, drawn only while `< 1`, alpha a sine bell over the phase times glow, with `PULSE_SEEDS = [0, 0.53, 0.21, 0.77, 0.38, 0.91]`.
  - Pulses are ordinary segments, so avatarthree and avatarcanvas need no change.
  - `quiet` still applies `QUIET_DIM`. Activity never clears quiet.
- petview.tsx:
  - counts `agents.filter(a => a.state === "working").length` from `model.agentsAtom`
  - in the frame loop, holds breath phase and pulse clock in refs and advances them per frame with `advancePhase(…, breathPeriodMs(working))` and `pulseClock += dt/1000 * pulseRate(level)`
  - passes `breath: breathFromPhase(phase)`, `activity`, `pulseClock`
  - adds `working`, `breathMs` and `pulses` (the number of pulse segments drawn this frame) to the DEV `__jarvisAvatarScene` object
- petstore.ts DEV hook `__wavePetStore.setWorking(n: number | null)`: a dev-only override of the working count (null = live), held in an atom petview reads.

**Acceptance:**
- `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`:
  - activity 0 → the same segment count as the current at-rest scene and no pulse segments
  - activity 1 with `still: true` → no pulse segments and breath ignored
  - activity 1 → over a sweep of `pulseClock` values the number of pulse segments varies (some frames have none, some several), so it is never a steady countable ring
  - quiet with activity 1 still dims (alpha ≤ the non-quiet scene's)
  - the scene contains no rotation term driven by activity alone (assert the mid-plane geometry is identical at activity 0 and 1 for the same now/yaw)
- New CDP scenario `jarvis-avatar-activity` (surface cockpit). Each step asserts `__jarvisAvatarScene` and takes a screenshot `cdp-shots/jarvis-avatar-activity-<row>-<n>.png`:
  1. at rest, `setWorking(0)` → breathMs 4800, `pulses === 0` across ~10 samples
  2. `setWorking(2)` → breathMs in 3300..3500, pulses > 0 in some sample, posture none. The wrapper is still at 40% opacity (`quiet`): read the computed opacity of `[aria-label="Jarvis condition"]` ≈ 0.4.
  3. `setWorking(6)` → breathMs 1900
  4. while a worker waits: `setAttention([<ask item>])` with `setWorking(0|2|6)` → posture blocked-worker, full opacity, pulses > 0 at 2 and 6. The 10s attention poll overwrites `setAttention`, so call it again right before each working count's samples and take each shot promptly.
  5. reduced motion: `Emulation.setEmulatedMedia` with `prefers-reduced-motion: reduce` and `setWorking(6)` → `pulses === 0` across samples
  - teardown: `setWorking(null)`, `setAttention([])`, clear the media emulation

### Task 7: The avatar on the popup page

**Depends on:** none
**Files:** `frontend/app/view/agents/attentionpopup.ts`, `frontend/app/view/agents/attentionpopup.test.ts`, `frontend/app/view/jarvis/popupavatar.tsx`, `frontend/tauri/popup.tsx`

**Interfaces (produced):**
- attentionpopup.ts: `export type PopupFace = { expression: PetExpression; posture: PetPosture }` (type-only imports from `@/app/view/jarvis/petcondition`, so the popup bundle stays cockpit-free)
- `PopupBubble` gains `face?: PopupFace`, and `popupBubble(prev, next, focused, face?: PopupFace)` passes it through
- `export const POPUP_AT_REST: PopupFace = { expression: { kind: "at-rest" }, posture: "none" }` and `export function popupFace(bubble: PopupBubble): PopupFace` → `bubble.face ?? POPUP_AT_REST`
- `export const POPUP_AVATAR_PX = 96`
- popupavatar.tsx: `export function PopupAvatar({ face, shownAt, onClick }: { face: PopupFace; shownAt: number; onClick: () => void })` renders a 96px `<canvas aria-hidden>`. Its 2D loop runs `buildAvatarScene` (settled mood, `quiet: false`, `utterance: utteranceEnvelope(now, shownAt)`, `idleOrbit`, `breathPhase(now)`, reduced motion → `still`), then `resolveTone` and `drawSceneToCanvas`, paced by `nextFrameDelay`, with dpr capped at 2.
  - It must not import avatarthree, three, or any cockpit store.
  - In DEV it publishes `window.__jarvisAvatarScene = { expression, posture, segments, fills, toneVar, markerVar, renderer: "canvas" }`.

**Decisions:**
- popup.tsx lays out `[BubbleCard][PopupAvatar]` in a row: `flex items-end gap-2`, as on the Popup board. The whole row is what `placeWindow` puts in the work-area corner (pass the row element where it passes the card today), so the avatar's right edge sits `POPUP_MARGIN` from the corner.
- `shownAt` is `performance.now()` when a show payload arrives, so the voice surge plays while the card is up.
- Clicking the avatar calls the same `open` as the card. The wrapper is not focusable (no tabIndex, no button role), and `show()` stays focus-free as today.

**Acceptance:**
- `npx vitest run frontend/app/view/agents/attentionpopup.test.ts`: `popupBubble` carries the given face. Without a face, `popupFace` returns at-rest/none. `popupPlacement` is unchanged.
- In the Check line's tsc, nothing in `frontend/tauri/popup.tsx`'s import graph pulls in three: grep `popupavatar.tsx` and its imports for `avatarthree|three`.
- The rendered result is proven by Task 8's popup steps.

### Task 8: Main window sends the face; popup scenario steps

**Depends on:** Task 6, Task 7
**Files:** `frontend/app/view/jarvis/petstore.ts`, `frontend/app/view/jarvis/petview.tsx`, `frontend/app/view/agents/attentionpoller.tsx`, `scripts/cdp/scenarios.mjs`

**Interfaces (consumed):** `PopupFace`, the `popupBubble(prev, next, focused, face)` signature (Task 7).

**Decisions / interfaces (produced):**
- petstore.ts: `export const petFaceAtom: PrimitiveAtom<PopupFace>` (initial `POPUP_AT_REST`). petview.tsx writes `{ expression, posture }` to it in an effect when either changes, so it is the single source of the face the main window wears.
- attentionpoller.tsx reads `globalStore.get(petFaceAtom)` at emit time and passes it as `popupBubble`'s `face`.

**Acceptance — extend the existing `attention-popup` scenario (do not fork it):**
- after the gate popup is raised (its existing step 2), read the popup page's `__jarvisAvatarScene` via `popup.ev`. Its `expression` and `posture` equal the main page's `__jarvisAvatarScene.expression` / `.posture` (review-gate while the gate stands), and its `renderer` is `"canvas"`.
- geometry: the popup canvas is 96 css px, its left edge is right of the card's right edge, and the bottom edges are within 1px. The existing corner-placement assertion now measures the row (card + avatar).
- clicking the avatar canvas (a fresh popup, the way the scenario raises its later ones) lands the main window on the same item a card click does, and the popup hides, reusing the card-click step's checks.
- screenshot `cdp-shots/attention-popup-avatar.png` from the popup page
- the Popup board's own state, an "Asking you" card with the avatar in blocked-worker posture: at the existing ask popup step (the one that shoots `attention-popup-ask.png`), also read the popup page's `__jarvisAvatarScene`. Assert its `expression` and `posture` equal the main page's `__jarvisAvatarScene` (posture blocked-worker when the ask is the only waiting kind, otherwise whatever the main page wears) and that `renderer` is `"canvas"`, then take `cdp-shots/attention-popup-avatar-ask.png`
