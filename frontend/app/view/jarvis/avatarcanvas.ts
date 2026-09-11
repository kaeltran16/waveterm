// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The fallback renderer: the avatar's scene drawn with plain canvas strokes.
//
// Used when WebGL 2 is unavailable, when its context is lost, or when a shader fails to build. It consumes
// the same avatarscene.ts output as the WebGL renderer, which is what makes a lost context survivable
// without a second copy of the geometry that could drift from the first.
//
// It paints a radial halo the WebGL renderer does not need. That is not a stylistic difference: over there
// the glow is a bloom pass earned from the geometry, and without one the line-work reads as a diagram.

import type { AvatarScene, SceneTone } from "./avatarscene";

export interface SceneColours {
    body: string;
    /** the body colour lightened, for the pulse head and the major ticks */
    hot: string;
    marker: string | null;
}

const HOT_LIGHTEN = 0.62;

// Parses #rgb / #rrggbb into 0-255 channels, or null for anything else. One copy: lighten, blendTones and
// withAlpha all need it, and three hand-rolled hex parsers in one file is how they drift apart.
function channels(colour: string): [number, number, number] | null {
    const hex = colour.trim().replace("#", "");
    const parts =
        hex.length === 3
            ? hex.split("").map((c) => parseInt(c + c, 16))
            : hex.length === 6
              ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
              : null;
    if (parts == null || parts.some((n) => !Number.isFinite(n))) {
        return null;
    }
    return [parts[0], parts[1], parts[2]];
}

const hex2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, "0");

// Mixes toward white. Anything this cannot parse passes through unchanged, so a token that resolves to a
// colour space it does not know degrades to a flat tone rather than throwing on a frame.
function lighten(colour: string, k: number): string {
    const parts = channels(colour);
    if (parts == null) {
        return colour;
    }
    const mixed = parts.map((n) => Math.round(n + (255 - n) * k));
    return "rgb(" + mixed[0] + "," + mixed[1] + "," + mixed[2] + ")";
}

/**
 * Crossfades two theme tones, returning hex rather than rgb() on purpose: `lighten` derives the "hot"
 * tone from whatever this returns, and it only parses hex. An rgb() string here would silently flatten
 * the pulse head and the major ticks into the body tone for the length of every transition.
 *
 * A tone that cannot be parsed is not blended at all — it snaps at the halfway point. Better a hard
 * switch than a frame of mid-grey, which is what channel-wise nonsense would produce.
 */
export function blendTones(from: string, to: string, mix: number): string {
    const t = Number.isFinite(mix) ? Math.max(0, Math.min(1, mix)) : 1;
    const a = channels(from);
    const b = channels(to);
    if (a == null || b == null) {
        return t < 0.5 ? from : to;
    }
    return "#" + [0, 1, 2].map((i) => hex2(a[i] + (b[i] - a[i]) * t)).join("");
}

// `read` is injected rather than calling getComputedStyle here, so this is testable and so the theme-token
// rule cannot be broken by a literal creeping in.
export function resolveTone(scene: AvatarScene, read: (name: string) => string): SceneColours {
    // The crossfade is resolved here rather than in either renderer, so a register change eases in both
    // of them from one implementation. Both already funnel through this function for their colours.
    const to = read(scene.toneVar);
    const body = scene.toneFromVar == null ? to : blendTones(read(scene.toneFromVar), to, scene.toneMix);
    return {
        body,
        hot: lighten(body, HOT_LIGHTEN),
        marker: scene.markerVar == null ? null : read(scene.markerVar),
    };
}

function withAlpha(colour: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    const parts = channels(colour);
    if (parts != null) {
        return "rgba(" + parts[0] + "," + parts[1] + "," + parts[2] + "," + a + ")";
    }
    const rgb = colour.match(/^rgb\(([^)]+)\)$/);
    if (rgb != null) {
        return "rgba(" + rgb[1] + "," + a + ")";
    }
    return colour;
}

function toneColour(tone: SceneTone, colours: SceneColours): string {
    if (tone === "hot") {
        return colours.hot;
    }
    if (tone === "marker") {
        return colours.marker ?? colours.body;
    }
    return colours.body;
}

export function drawSceneToCanvas(
    ctx: CanvasRenderingContext2D,
    scene: AvatarScene,
    size: number,
    colours: SceneColours
): void {
    ctx.clearRect(0, 0, size, size);

    // the hand-painted halo, standing in for the bloom this renderer does not have
    if (scene.extent > 0) {
        const halo = ctx.createRadialGradient(
            scene.centreX,
            scene.centreY,
            0,
            scene.centreX,
            scene.centreY,
            scene.extent
        );
        halo.addColorStop(0, withAlpha(colours.hot, 0.3));
        halo.addColorStop(0.42, withAlpha(colours.body, 0.13));
        halo.addColorStop(1, withAlpha(colours.body, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, size, size);
    }

    ctx.lineWidth = Math.max(0.6, size * 0.003);
    for (const s of scene.segments) {
        ctx.strokeStyle = withAlpha(toneColour(s.tone, colours), s.alpha);
        ctx.beginPath();
        ctx.moveTo(s.ax, s.ay);
        ctx.lineTo(s.bx, s.by);
        ctx.stroke();
    }
    for (const p of scene.points) {
        ctx.fillStyle = withAlpha(toneColour(p.tone, colours), p.alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
    }
}
