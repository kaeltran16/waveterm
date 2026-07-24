// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Stack-rendered acknowledgement (pushModal("MessageModal", { children })). A single-button info
// alert over ConfirmDialog. Callers pass a string (or node) message as children.

import { ConfirmDialog } from "@/app/modals/confirmdialog";
import { modalsModel } from "@/app/store/modalmodel";
import { ReactNode } from "react";

const MessageModal = ({ children }: { children: ReactNode }) => {
    const close = () => modalsModel.popModal();
    return <ConfirmDialog tone="info" body={children} confirmLabel="OK" onConfirm={close} onClose={close} />;
};

MessageModal.displayName = "MessageModal";

export { MessageModal };
