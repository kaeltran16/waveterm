// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, makeIconClass } from "@/util/util";

export const EmojiButton = ({
    emoji,
    icon,
    isClicked,
    onClick,
    className,
}: {
    emoji?: string;
    icon?: string;
    isClicked: boolean;
    onClick: () => void;
    className?: string;
}) => {
    const content = icon ? <i className={makeIconClass(icon, false)} /> : emoji;

    return (
        <div className="inline-block">
            <button
                onClick={onClick}
                className={cn(
                    "px-2 py-1 rounded border cursor-pointer transition-colors",
                    isClicked
                        ? "bg-accent/20 border-accent text-accent"
                        : "bg-transparent border-border/50 text-foreground/70 hover:border-border",
                    className
                )}
            >
                {content}
            </button>
        </div>
    );
};
