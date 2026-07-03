// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import clsx from "clsx";
import { motion } from "motion/react";
import { forwardRef } from "react";
import ReactDOM from "react-dom";

import "./modal.scss";

interface ModalProps {
    children?: React.ReactNode;
    okLabel?: string;
    cancelLabel?: string;
    className?: string;
    onClickBackdrop?: () => void;
    onOk?: () => void;
    onCancel?: () => void;
    onClose?: () => void;
    okDisabled?: boolean;
    cancelDisabled?: boolean;
}

const Modal = forwardRef<HTMLDivElement, ModalProps>(
    (
        {
            children,
            className,
            cancelLabel,
            okLabel,
            onCancel,
            onOk,
            onClose,
            onClickBackdrop,
            okDisabled,
            cancelDisabled,
        }: ModalProps,
        ref
    ) => {
        const renderBackdrop = (onClick) => (
            <motion.div
                className="modal-backdrop"
                onClick={onClick}
                variants={modalBackdrop}
                initial="initial"
                animate="animate"
                exit="exit"
            />
        );

        const renderFooter = () => {
            return onOk || onCancel;
        };

        const renderModal = () => (
            <div className="modal-wrapper">
                {renderBackdrop(onClickBackdrop)}
                <motion.div
                    ref={ref}
                    className={clsx(`modal`, className)}
                    variants={modalPanel}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                >
                    <Button className="grey ghost modal-close-btn" onClick={onClose} title="Close (ESC)">
                        <i className="fa-sharp fa-solid fa-xmark"></i>
                    </Button>
                    <div className="content-wrapper">
                        <ModalContent>{children}</ModalContent>
                    </div>
                    {renderFooter() && (
                        <ModalFooter
                            onCancel={onCancel}
                            onOk={onOk}
                            cancelLabel={cancelLabel}
                            okLabel={okLabel}
                            okDisabled={okDisabled}
                            cancelDisabled={cancelDisabled}
                        />
                    )}
                </motion.div>
            </div>
        );

        return ReactDOM.createPortal(renderModal(), document.getElementById("main"));
    }
);

interface ModalContentProps {
    children: React.ReactNode;
}

function ModalContent({ children }: ModalContentProps) {
    return <div className="modal-content">{children}</div>;
}

interface ModalFooterProps {
    okLabel?: string;
    cancelLabel?: string;
    onOk?: () => void;
    onCancel?: () => void;
    okDisabled?: boolean;
    cancelDisabled?: boolean;
}

const ModalFooter = ({
    onCancel,
    onOk,
    cancelLabel = "Cancel",
    okLabel = "Ok",
    okDisabled,
    cancelDisabled,
}: ModalFooterProps) => {
    return (
        <footer className="modal-footer">
            {onCancel && (
                <Button className="grey ghost" onClick={onCancel} disabled={cancelDisabled}>
                    {cancelLabel}
                </Button>
            )}
            {onOk && (
                <Button onClick={onOk} disabled={okDisabled}>
                    {okLabel}
                </Button>
            )}
        </footer>
    );
};

interface FlexiModalProps {
    children?: React.ReactNode;
    className?: string;
    onClickBackdrop?: () => void;
}

interface FlexiModalComponent extends React.ForwardRefExoticComponent<
    FlexiModalProps & React.RefAttributes<HTMLDivElement>
> {
    Content: typeof ModalContent;
    Footer: typeof ModalFooter;
}

const FlexiModal = forwardRef<HTMLDivElement, FlexiModalProps>(
    ({ children, className, onClickBackdrop }: FlexiModalProps, ref) => {
        const renderBackdrop = (onClick: () => void) => (
            <motion.div
                className="modal-backdrop"
                onClick={onClick}
                variants={modalBackdrop}
                initial="initial"
                animate="animate"
                exit="exit"
            />
        );

        const renderModal = () => (
            <div className="modal-wrapper">
                {renderBackdrop(onClickBackdrop)}
                <motion.div
                    className={cn("modal pt-6 px-4 pb-4", className)}
                    ref={ref}
                    variants={modalPanel}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                >
                    {children}
                </motion.div>
            </div>
        );

        return ReactDOM.createPortal(renderModal(), document.getElementById("main")!);
    }
);

(FlexiModal as FlexiModalComponent).Content = ModalContent;
(FlexiModal as FlexiModalComponent).Footer = ModalFooter;

export { FlexiModal, Modal };
