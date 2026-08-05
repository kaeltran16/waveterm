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

// Parses #rgb / #rrggbb and mixes toward white. Anything else passes through unchanged, so a token that
// resolves to a colour space this does not parse degrades to a flat tone rather than throwing on a frame.
function lighten(colour: string, k: number): string {
    const hex = colour.trim().replace("#", "");
    const parts =
        hex.length === 3
            ? hex.split("").map((c) => parseInt(c + c, 16))
            : hex.length === 6
              ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
              : null;
    if (parts == null || parts.some((n) => !Number.isFinite(n))) {
        return colour;
    }
    const mixed = parts.map((n) => Math.round(n + (255 - n) * k));
    return "rgb(" + mixed[0] + "," + mixed[1] + "," + mixed[2] + ")";
}

// `read` is injected rather than calling getComputedStyle here, so this is testable and so the theme-token
// rule cannot be broken by a literal creeping in.
export function resolveTone(scene: AvatarScene, read: (name: string) => string): SceneColours {
    const body = read(scene.toneVar);
    return {
        body,
        hot: lighten(body, HOT_LIGHTEN),
        marker: scene.markerVar == null ? null : read(scene.markerVar),
    };
}

function withAlpha(colour: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    const hex = colour.trim().replace("#", "");
    const parts =
        hex.length === 3
            ? hex.split("").map((c) => parseInt(c + c, 16))
            : hex.length === 6
              ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
              : null;
    if (parts != null && parts.every((n) => Number.isFinite(n))) {
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
