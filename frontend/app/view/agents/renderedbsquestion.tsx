// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's question card: the talk question, the judge's states, answering. A stub until its slice
// lands.

import type { JSX, ReactNode } from "react";
import type { AnswerOption } from "./brainstormmodel";
import type { CardProps } from "./renderedbrainstormmodel";

export function QuestionCard(_p: CardProps & { judging: boolean }): JSX.Element | null {
    return null;
}

export function OptionRows(_p: {
    options: AnswerOption[];
    onPick: (label: string) => void;
    locked: string | null;
    badge?: (i: number) => string | null;
    chip?: (i: number) => ReactNode | null;
    compact: boolean;
}): JSX.Element | null {
    return null;
}
