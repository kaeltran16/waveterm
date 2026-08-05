# The Jarvis avatar — a hologram whose faults are its form

**Date:** 2026-08-04 · **Status:** Design settled. Form and renderer chosen against a live bench.
**Type:** Design doc. It settles **what the avatar is** and **what draws it**. It supersedes six named parts of
[the pet design](2026-08-04-jarvis-pet-design.md) and leaves the rest of that document standing — the four
registers, the three-stage split, the data audit and the capability ladder are all still correct and still
load-bearing. It is not an implementation plan.

---

## 1. What this supersedes, and what survives

| Superseded in the pet design | Replaced by |
|---|---|
| §4 decision 6 — "Renderer: inline SVG components + `motion`, 2D. 3D deferred" | §4 decision 2 here |
| §4 decision 7 — "Jarvis with a face" | §4 decision 5 here, which reverses it |
| §4 "Creature form: a small eyed blob" | §3 here |
| §5 Modules table | §5 here |
| §9 "WebGL is why 3D was deferred, and the reason will not change" | §10 here. The reason did change. |
| §10 "The slit-eyed states cannot show either" | Obsolete — nothing has eyes |

**Everything else in that document stands unchanged**: the four registers and their strict precedence (§3), the
two cross-register rules, decisions 1–5 and 8, the capability ladder and the per-channel tier resolution (§6),
the audit of which signals actually exist (§7), the three-stage split and the two-track parallelism (§8), the
`PetSignals` / `PetExpression` / `PetPosture` / `PetEvent` contract, and the rejected list (§11).

**The contract is the reason this is cheap.** The pure state modules never knew what drew them, which is
exactly the property §5 of that document was written to protect. Five form directions were tried and discarded
during this design and not one of them would have touched `petcondition.ts`.

## 2. Why the blob failed, and what the reference actually is

The eyed blob was explicitly a placeholder — the pet design calls it "the least load-bearing choice in the
document." Replacing it took five rounds because the first four searched the wrong space:

| Tried | Why it failed |
|---|---|
| Flat / shaded / silhouetted / eye-depth variants of the blob | All the same form. The question was never how to paint it. |
| Core & rings; aperture; designed creature; constellation | Four thin vector marks at icon scale — one aesthetic, four skins |
| Plasma; liquid metal; crystal; figure in fog | Right to vary material, wrong subject. None reads as Jarvis. |
| Aperture, argued for on the grounds that rank 1 is about sight | A single glowing lens is **HAL 9000** — the canonical untrustworthy AI, which is the opposite of the reference |

The name is an Iron Man reference, and JARVIS's own form is documented rather than a matter of taste. From
Animal Logic's effects work on *Avengers: Age of Ultron*: his design was **"a network of connections inside a
spherical center, and audio-reactive exterior rings of data that circumscribed the hologram, evoking spinning
hard drive platters and reel to reel data tape."**

That sentence explains the four failures directly. **Two of the rejected candidates were each half of the
answer** — "core & rings" was the exterior rings without the network, "constellation" was the network without
the sphere or the rings — and neither half is Jarvis alone. The third property, that the rings answer to his
voice, was absent from all four.

Two further findings from the same research shaped §3 and §4:

- The helmet display's elements "remain small and in Tony's peripheral vision while the information is not
  needed, and become larger and more central when needed." That is nearly the rule `petview.tsx` already
  computes as `quiet` (`:392`) and currently spends only on opacity.
- JARVIS's presence is holographic interface throughout — "a visual representation of Stark's imagination."
  He conspicuously has no face, which is what forces decision 5.

## 3. What the avatar is

Three concentric parts:

- **Inner — the network.** Nodes distributed through the *volume* of a sphere, not its shell, each linked to
  its nearest neighbours, with a pulse walking the graph.
- **Middle — the shell.** Latitude and longitude arcs implying a sphere without drawing a surface.
- **Outer — the platters.** Tick-mark rings — three by default, legible anywhere between two and four — each on
  its own tilted plane, rotating at different speeds and alternating directions. Tick length is a three-partial
  waveform, so it reads as speech rather than as a sine.

Every register becomes a **physical property of the hologram**, never a facial expression:

| Register | Physical property | Why it fits |
|---|---|---|
| **Cannot see** (rank 1 — embedding index off or stale) | Links sever, nodes drift outside the sphere, ticks stutter out of phase | Degraded semantic recall **is** a broken connection network. The form and the fault are the same object, not a metaphor for one another. This is the strongest single argument for the whole direction. |
| **Tired** (rank 2 — rate-limit window depleting) | Platter rotation slows, ticks shorten, the whole form dims | A depleted window is a machine running slow, which is what a slowing platter reads as |
| **Drifting** (rank 3 — vault decay) | Rings lose coplanarity; the network loosens and spreads | Decay is loss of structure, not loss of power — a different failure needs a different tell |
| **Voice** | Ring amplitude surges on an utterance, then settles to idle | Canon, and functional: Jarvis is a voice first |
| **Posture** | A bearing marker arc holds at an angle | Kind of waiting, never a count. The de-duplication contract with the nav badge is preserved unchanged. |
| **Presence** | Small and dim at the periphery; larger, brighter and more central when it has something | Straight from the helmet-display description, and it strengthens a rule the renderer already has |

## 4. Decisions taken

| # | Decision | Taken | Reasoning |
|---|---|---|---|
| 1 | Form | **Network inside a sphere, wrapped in tilted tick-mark data rings** | §2. Built to a sourced description rather than to taste, after four rounds of taste failed. |
| 2 | Renderer | **Raw WebGL 2 — additive blending, bright-pass, separable blur, composite. Not three.js.** | A bench with both renderers over one shared scene showed WebGL's whole contribution here is *light*: bloom, additive accumulation, one draw call. Three.js's value was its GLTF loader and material system, and line-work needs neither. The pipeline is roughly eighty lines of shader. Reversible — three.js buys an existing bloom implementation if hand-rolling it proves fragile. |
| 3 | Fallback | **A canvas 2D renderer over the same scene** | The pet design's fallback was "drop to the shipped SVG renderer", which is void now that the SVG renderer is deleted. Both renderers consuming one scene builder means the fallback costs no second geometry and cannot drift from the primary. |
| 4 | Placement | **Unchanged — one avatar, on every surface, growing when it has something** | Chosen before this redesign and now better supported: the helmet-display behaviour in §2 is the same rule. |
| 5 | Face | **No face. Reverses pet-design decision 7.** | "One identity, one vocabulary" survives and is still why clicking through to the Jarvis surface is coherent. "With a face" does not: the reference has none, and a face is what made every creature candidate read as a pet rather than an intellect. |
| 6 | "Audio-reactive" | **Utterance-reactive** | There is no audio anywhere in this application. The Voice register is text bubbles (`petbubble.tsx`). The rings surge when a bubble appears — same visual behaviour, different driver. Stated explicitly because the phrase "audio-reactive" would otherwise imply a sound pipeline that does not and will not exist. |
| 7 | Colour | **Unchanged — `--color-*` tokens only** | The WebGL renderer reads the tokens through `getComputedStyle` and feeds them to a uniform, so runtime theming still works by overriding custom properties on `document.documentElement`. Built this way on the bench, but like everything else here never observed rendering (§10). |

## 5. Architecture — the scene builder is the new seam

Three layers. Only the bottom one is new.

1. **State derivation — untouched.** `petcondition.ts` maps signals to one expression by strict precedence;
   `petvoice.ts` maps events to at most one utterance; `petstore.ts` holds the atoms.
2. **Scene building — new, and pure.** Expression, posture, utterance envelope, pointer, time and size in; a
   flat list of line segments and points in screen space out. No canvas, no GPU, no React.
3. **Rendering — two interchangeable consumers** of that one scene.

| File | Kind | Role |
|---|---|---|
| `frontend/app/view/jarvis/petcondition.ts` | pure | unchanged — signals in, one expression out |
| `frontend/app/view/jarvis/petvoice.ts` | pure | unchanged — events in, at most one utterance out |
| `frontend/app/view/jarvis/petmotion.ts` | pure | **reduced** — see §6. Keeps the breath and the distance ramp; loses everything about eyes. |
| `frontend/app/view/jarvis/avatarscene.ts` | pure · new | the form. Builds segments and points for the network, shell, platters and bearing marker. |
| `frontend/app/view/jarvis/avatarscene.test.ts` | test · new | §9 |
| `frontend/app/view/jarvis/avatargl.ts` | thin · new | WebGL renderer: programs, framebuffers, the bloom chain, context-loss events |
| `frontend/app/view/jarvis/avatarcanvas.ts` | thin · new | canvas 2D renderer, the fallback |
| `frontend/app/view/jarvis/petview.tsx` | thin | **rewritten** — owns the animation loop, picks a renderer, keeps the drag/click/keyboard behaviour and the corner anchoring it already has |
| `frontend/app/view/jarvis/petbubble.tsx`, `petpeek.tsx`, `petstore.ts`, `petsources.tsx`, `petdecaypoller.tsx` | — | unchanged |

**What this fixes.** The blob's geometry lived inside `petview.tsx` as JSX attributes, so the only way to check
it was to screenshot the running app. Making the form a pure function makes the *form* unit-testable for the
first time, which is what §9 spends.

**Naming.** The `pet*` prefix is now actively wrong — this is not a pet. Renaming is deliberately **not** part
of this design: it is twelve files, it is pure churn against a working tree that other sessions edit, and
`git mv` on frontend modules blanks the running dev app until a full reload. New files take the `avatar*`
prefix; the rename is recorded here as a follow-up worth doing in isolation.

## 6. What the aliveness pass loses

Stated as an explicit cost rather than left to be discovered in a diff. `petmotion.ts` and its fifteen tests
were built to serve eyes:

| Export | Fate |
|---|---|
| `eyeRoom` | **Deleted.** It clamps pupil travel inside an eyelid. There is no lid. |
| `nextBlinkDelay` | **Deleted.** A hologram does not blink. |
| `gazeOffset` | **Replaced.** The distance-saturation ramp survives and is reused to turn the whole form toward the pointer, as yaw and pitch, instead of sliding a pupil inside an eye. |
| the counter-phased breath | **Survives**, as a scale pulse on the whole assembly |
| the contact pool | **Deleted.** A hologram does not rest on a surface. |

Roughly nine of the fifteen tests in `petmotion.test.ts` go with the deletions. The magnitude-clamp test that
guards against per-axis clamping has no successor because there is no lid to escape; the bounded-irregular-delay
tests move to the utterance envelope, which needs the same guarantees.

## 7. Data flow

**The utterance envelope.** The effect in `petview.tsx` that writes `petBubbleAtom` also records `spokeAt` as a
timestamp in `petstore.ts`. The render loop computes the envelope each frame from `performance.now() - spokeAt`
through a pure bounded function.

The envelope is deliberately **not** React state. A sixty-times-a-second state update in a window running live
terminals is the thing to avoid, and the same discipline already governs pointer tracking, which rides motion
values rather than triggering renders. The existing `nowAtom` ticks once a second and drives the *condition*;
it must not be coupled to the envelope.

**Gaze.** Pointer distance ramps to a capped yaw and pitch on the whole hologram. Same saturation constant,
different output space.

## 8. Failure paths

| Condition | Behaviour |
|---|---|
| WebGL 2 unavailable at boot | Canvas renderer; do not retry. `termwrap.ts`'s `detectWebGLSupport` (`:57`) already establishes the pattern of probing once at module load. |
| `webglcontextlost` at runtime | Cancel the default, switch to canvas immediately. Because both renderers consume the same scene, only glow quality changes. |
| `webglcontextrestored` | Rebuild programs and framebuffers, switch back. |
| Reduced motion | No rotation, no platter spin, no breath, no surge. Bloom stays — it is not motion. |
| Signals absent at boot | Unchanged: every field optional, absent means "no signal", expression falls to at rest. |
| A shader fails to compile or link | Log and fall back to canvas. A blank avatar must never be a silent failure. |

## 9. Verification

**Unit — the scene builder.** These assert the *design*, not the drawing:

- **Severing:** network link count at rank 1 is strictly below the count at rest.
- **Coplanarity:** ring plane normals converge as alignment rises and diverge as it falls, which is the
  drifting register's whole tell.
- **Amplitude:** tick length rises monotonically with the utterance envelope.
- **The de-duplication contract:** the bearing marker is emitted only for a non-`none` posture. That the avatar
  never draws a count is guaranteed more strongly than a test can: the scene's only primitive types are
  segments and points, so a number is structurally unrepresentable. Assert the marker; the type does the rest.
- **Presence:** the largest primitive radius from the scene's centre is strictly smaller at rest than when
  there is something to say.

**Unit — the envelope and the gaze.** Bounded to their ranges, monotonic in their inputs, and a non-finite
input yields zero rather than a NaN transform. Same shape as the `nextBlinkDelay` tests being retired.

**Live — and this recovers something a canvas would otherwise cost.** A `<canvas>` cannot be asserted by
reading DOM attributes, which was a real objection to leaving SVG. The fix is to expose the last built scene on
`window` in development builds only; the Chrome DevTools Protocol harness then asserts on primitive counts and
colours rather than pixels. That is **stronger** than what the SVG version allowed, because it can assert the
whole scene at once instead of one element's transform. A screenshot still goes to the contact sheet for
eyeballing.

## 10. Constraints and traps

**Everything visual in this design was authored blind.** No specimen built during this brainstorm was ever
observed rendering — not the five form directions, not the bloom chain. The *form* is settled against a sourced
description and against the user's judgement of the bench; the *numbers* are not. Bloom strength, threshold and
radius, ring count, ring density, node count, and the rest and active sizes are all **provisional** and want
tuning against the live dev app over the Chrome DevTools Protocol as the first task after the renderer works.

**The permanent WebGL context is now survivable, which is what changed since the pet design.** The terminal
attaches `@xterm/addon-webgl` per instance and Chromium caps concurrent contexts, dropping the oldest past the
cap. The pet design concluded from this that a permanent 3D avatar was unacceptable and that "the reason will
not change." It changed: `termwrap.ts` handles its own loss through `onContextLoss` by falling back to a DOM
renderer, and the avatar does the same thing through §8. Whichever context the browser drops, something correct
happens. **Do not lean on eviction order** — the claim that Chromium drops the oldest context first, which
would mean a boot-time avatar dies before any terminal does, is unverified in WebView2 and the design must be
correct without it.

**Colours must come from `@theme` tokens** in `frontend/tailwindsetup.css`. A shader uniform fed from
`getComputedStyle` satisfies this; a hardcoded `vec3` silently opts the avatar out of every theme.

**Occlusion must be re-measured.** The pet design's corner analysis was taken at 44px and concluded that at
least one bottom corner is clear on all five surfaces tested. Growing to roughly 112px invalidates that
arithmetic. `PET_CORNERS` stays bottom-left and bottom-right; the insets need re-measuring before this ships,
against an active size of roughly 112px — the size chosen when placement was settled — and a resting size that
is smaller still and not yet decided.

**The Escape guard still applies.** The peek overlay's open atom must keep gating `surface:back-home` in
`frontend/app/store/keybindings/bindings.ts`, because the keybinding dispatcher runs on window capture and
floating-ui's own Escape handling cannot pre-empt it. Nothing here changes that, and nothing here may break it.

**Accessible naming is already settled and must not regress.** The avatar is labelled "Jarvis condition"; the
nav rail's entry-two button owns "Jarvis", and the CDP harness navigates by that label.

## 11. Rejected, and why

- **All four blob renderings** — flat, shaded, silhouetted, eye-depth. Right technique, wrong subject: the
  form was the problem.
- **Core & rings alone** and **constellation alone** — each is half of the documented form. Shipping either
  would have been shipping half a reference by accident.
- **The aperture / single lens.** Strong conceptual fit with rank 1 being about sight, and initially
  recommended on that basis. Rejected: under an Iron Man framing a solitary glowing lens reads as HAL 9000, and
  an untrustworthy-AI association is expensive to spend on a component whose entire job is to be believed.
- **A designed creature with brows and a mouth.** The most expressive candidate and the best at "identify
  with". Rejected because a butler-intellect is not a pet, and because it needs a face the reference does not
  have.
- **Plasma, liquid metal, crystal, figure in fog.** Correct instinct to vary material rather than outline;
  none of them is Jarvis.
- **three.js** (§4 decision 2). Its bloom implementation is a genuine convenience and the reason to revisit;
  its loader and material system are irrelevant to line-work.
- **A sprite sheet or pre-rendered frames** — carried unchanged from the pet design. Colours bake into the
  asset, breaking the theme-token rule hardest.
- **A modeled GLB asset.** Considered at length before the form was settled. Moot now: there is no surface to
  texture, and generated meshes arrive unrigged with baked albedo maps, which is the wrong half of the problem.
- **Real audio.** No sound pipeline exists, none is wanted, and the visual behaviour does not need one
  (§4 decision 6).

## 12. Out of scope

- **Renaming the `pet*` modules** (§5). Worth doing, worth doing alone.
- **Tuning the provisional numbers** (§10). First task after the renderer runs, not part of the design.
- **The capability ladder above the Concierge floor.** Designed in the pet design §6, still unscheduled.
- **Everything else the pet design puts out of scope**, unchanged — git-history capture, a second always-on-top
  Tauri window, and product-polish concerns.
