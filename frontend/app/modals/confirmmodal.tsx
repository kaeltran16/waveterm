// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { FlexiModal } from "@/app/modals/modal";
import { modalsModel } from "@/app/store/modalmodel";
import { makeIconClass } from "@/util/util";
import { useEffect } from "react";

interface ConfirmModalProps {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onConfirm: () => void;
}

const ConfirmModal = ({
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive,
    onConfirm,
}: ConfirmModalProps) => {
    const close = () => modalsModel.popModal();
    const confirm = () => {
        close();
        onConfirm();
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                close();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <FlexiModal className="w-[400px] max-w-[90vw]" onClickBackdrop={close}>
            <div className="flex gap-3">
                {destructive && (
                    <i className={makeIconClass("triangle-exclamation", true) + " mt-px text-[16px] text-error"} />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {title && <span className="text-[14px] font-semibold text-primary">{title}</span>}
                    <div className="text-[13px] leading-relaxed text-secondary">{message}</div>
                    <div className="mt-4 flex items-center justify-end gap-2">
                        <Button className="grey solid" onClick={close}>
                            {cancelLabel}
                        </Button>
                        <Button className={destructive ? "red solid" : "green solid"} onClick={confirm}>
                            {confirmLabel}
                        </Button>
                    </div>
                </div>
            </div>
        </FlexiModal>
    );
};

ConfirmModal.displayName = "ConfirmModal";

export { ConfirmModal };
