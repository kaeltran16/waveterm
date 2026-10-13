// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar beside the desktop popup's card: the face the main window wears, drawn again in the popup
// window. Only the 2D renderer — the popup page opens no wavesrv connection and must stay light, so
// nothing here imports three, avatarthree or a cockpit store. The face arrives in the show payload.

import { POPUP_AVATAR_PX, type PopupFace } from "@/app/view/agents/attentionpopup";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { drawSceneToCanvas, resolveTone } from "./avatarcanvas";
import { buildAvatarScene, settledMood } from "./avatarscene";
import { breathPhase, idleOrbit, nextFrameDelay, utteranceEnvelope } from "./petmotion";

// same cap as the main avatar's backing store
const MAX_DPR = 2;

export function PopupAvatar({ face, shownAt, onClick }: { face: PopupFace; shownAt: number; onClick: () => void }) {
    const reduce = useReducedMotion() === true;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // the loop runs once per mount and reads the latest props through this, as petview's does
    const frameRef = useRef({ face, shownAt, reduce });
    frameRef.current = { face, shownAt, reduce };

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (canvas == null || ctx == null) {
            return;
        }
        const size = POPUP_AVATAR_PX;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // live declaration, so a theme change reads through
        const rootStyle = getComputedStyle(document.documentElement);
        const read = (name: string) => rootStyle.getPropertyValue(name).trim();

        let raf = 0;
        let sleep: ReturnType<typeof setTimeout> | undefined;
        const frame = (now: number) => {
            const { face, shownAt, reduce } = frameRef.current;
            const orbit = reduce ? { yaw: 0, pitch: 0 } : idleOrbit(now);
            // settled, not eased: the popup is raised already wearing the face, it never watched it change
            const scene = buildAvatarScene({
                expression: face.expression,
                mood: settledMood(face.expression),
                posture: face.posture,
                size,
                now,
                yaw: orbit.yaw,
                pitch: orbit.pitch,
                breath: breathPhase(now),
                utterance: utteranceEnvelope(now, shownAt),
                ripple: null,
                jolt: 0,
                quiet: false,
                still: reduce,
            });
            drawSceneToCanvas(ctx, scene, size, resolveTone(scene, read));
            if (import.meta.env.DEV) {
                (window as unknown as { __jarvisAvatarScene?: unknown }).__jarvisAvatarScene = {
                    expression: face.expression.kind,
                    posture: face.posture,
                    segments: scene.segments.length,
                    fills: scene.fills.length,
                    toneVar: scene.toneVar,
                    markerVar: scene.markerVar,
                    renderer: "canvas",
                };
            }
            // the canvas never resizes, so no frame is owed the next vsync
            const delay = nextFrameDelay(false, reduce);
            if (delay > 0) {
                sleep = setTimeout(() => {
                    raf = requestAnimationFrame(frame);
                }, delay);
            } else {
                raf = requestAnimationFrame(frame);
            }
        };
        raf = requestAnimationFrame(frame);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(sleep);
        };
    }, []);

    // a plain clickable canvas: no tabIndex or button role, so the popup still never takes focus
    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            data-attention-popup-avatar
            onClick={onClick}
            style={{ width: POPUP_AVATAR_PX, height: POPUP_AVATAR_PX }}
            className="block flex-none cursor-pointer"
        />
    );
}
