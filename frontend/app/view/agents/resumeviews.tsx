// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// E continuity resume card: "where this task stands", written by the backend at the
// run's rest boundary and rendered here without a fresh model call. Informational +
// dismissible; non-navigating this cycle, matching the S3 proactive card it sits
// beside. Marked visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { AmbientCard } from "./ambientcard";
import { dismissResume, dismissedResumeAtom, readResumeCard } from "./resume";

export function ResumeCard({ run }: { run: Run }) {
    const dismissed = useAtomValue(dismissedResumeAtom);
    const vm = readResumeCard(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    return (
        <AmbientCard
            eyebrow={`Where this stands${vm.status ? ` · ${vm.status}` : ""}`}
            dismissLabel="Dismiss resume summary"
            onDismiss={() => dismissResume(run)}
        >
            <div className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-secondary">{vm.summary}</div>
        </AmbientCard>
    );
}
