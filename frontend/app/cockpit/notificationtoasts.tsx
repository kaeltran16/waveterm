// Toast stack for transient cockpit notifications. Thin render over toastsAtom; colors come
// from @theme tokens only.
import { cardVariants } from "@/app/element/motiontokens";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { dismissToast, toastsAtom } from "./notificationstore";

export function NotificationToasts(): React.JSX.Element {
    const toasts = useAtomValue(toastsAtom);
    // the stack stays mounted while empty so the last toast can play its exit; popLayout takes a leaving toast
    // out of flow at once, so the rest slide into its place instead of waiting for it
    return (
        <MotionConfig reducedMotion="user">
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
                <AnimatePresence mode="popLayout">
                    {toasts.map((t) => (
                        <motion.button
                            key={t.id}
                            layout
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            type="button"
                            data-notification-toast
                            onClick={() => dismissToast(t.id)}
                            className={`pointer-events-auto rounded-lg border p-3 text-left shadow-lg ${
                                t.level === "error"
                                    ? "border-error/40 bg-surface text-primary"
                                    : t.level === "warn"
                                      ? "border-warning/40 bg-surface text-primary"
                                      : "border-border bg-surface text-primary"
                            }`}
                        >
                            <div className="text-sm font-medium">{t.title}</div>
                            {t.message ? <div className="text-xs text-secondary">{t.message}</div> : null}
                        </motion.button>
                    ))}
                </AnimatePresence>
            </div>
        </MotionConfig>
    );
}
