// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One message Arc typed into an agent's transcript (a wake, a brief, a brainstorm line), drawn as an event.

import type { ArcMessage } from "./arcmessage";
import type { TranscriptContext } from "./transcriptcontext";

export interface ArcMessageRowProps {
    message: ArcMessage;
    ts?: number;
    idleMs?: number; // the gap before it, for the Waited fold
    ctx: TranscriptContext;
    compact: boolean;
}

export function ArcMessageRow({ message }: ArcMessageRowProps) {
    return (
        <div
            data-arc-message={message.kind}
            className="mt-2 whitespace-pre-wrap font-mono text-[11.5px] text-muted [overflow-wrap:anywhere]"
        >
            {message.text}
        </div>
    );
}
