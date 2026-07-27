// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// E continuity resume card: "where this task stands", written by the backend at the
// run's rest boundary and rendered here without a fresh model call. Informational +
// dismissible; non-navigating this cycle, matching the S3 proactive card it sits
// beside. Marked visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { dismissResume, dismissedResumeAtom, readResumeCard } from "./resume";

export function ResumeCard({ run }: { run: Run }) {
    const dismissed = useAtomValue(dismissedResumeAtom);
    const vm = readResumeCard(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    return (
        <div className="mb-3 flex items-start gap-2 rounded-[9px] border border-border bg-surface px-3 py-2">
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
                    Where this stands{vm.status ? ` · ${vm.status}` : ""}
                </div>
                <div className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-secondary">{vm.summary}</div>
            </div>
            <button
                type="button"
                aria-label="Dismiss resume summary"
                onClick={() => dismissResume(run)}
                className="flex-none rounded-[4px] px-1.5 py-px text-[13px] leading-none text-muted hover:text-secondary"
            >
                ×
            </button>
        </div>
    );
}
