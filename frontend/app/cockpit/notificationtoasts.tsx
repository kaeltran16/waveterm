// Toast stack for transient cockpit notifications. Thin render over toastsAtom; colors come
// from @theme tokens only.
import { cardVariants } from "@/app/element/motiontokens";
import { petBubbleHeightAtom, petCornerAtom } from "@/app/view/jarvis/petstore";
import { AVATAR_WINDOW_REACH_PX } from "@/app/view/jarvis/petview";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { dismissToast, toastsAtom, type ToastNotification } from "./notificationstore";
import { toastStackBottom } from "./toaststack";

// the level is said three ways (icon, tinted edge, the icon's accessible name), never by colour alone. the name
// rides on the icon, not as hidden text, so a toast's textContent stays its title and message. the Brief's toast
// reads it too, so both toast systems say a level one way.
export const TOAST_LEVEL: Record<
    ToastNotification["level"],
    { Icon: typeof Info; tone: string; edge: string; label: string }
> = {
    error: { Icon: CircleAlert, tone: "text-error", edge: "border-error/40", label: "Error" },
    warn: { Icon: TriangleAlert, tone: "text-warning", edge: "border-warning/40", label: "Warning" },
    info: { Icon: Info, tone: "text-accent-soft", edge: "border-edge-strong", label: "Info" },
};

export function NotificationToasts(): React.JSX.Element {
    const toasts = useAtomValue(toastsAtom);
    const corner = useAtomValue(petCornerAtom);
    const bubbleHeight = useAtomValue(petBubbleHeightAtom);
    const bottom = toastStackBottom(corner, bubbleHeight, AVATAR_WINDOW_REACH_PX);
    // the stack stays mounted while empty so the last toast can play its exit; popLayout takes a leaving toast
    // out of flow at once, so the rest slide into its place instead of waiting for it
    return (
        <MotionConfig reducedMotion="user">
            <div
                role="status"
                aria-live="polite"
                style={{ bottom }}
                className="pointer-events-none fixed right-4 z-50 flex w-80 flex-col gap-2"
            >
                <AnimatePresence mode="popLayout">
                    {toasts.map((t) => {
                        const level = TOAST_LEVEL[t.level];
                        return (
                            <motion.button
                                key={t.id}
                                layout
                                variants={cardVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                type="button"
                                data-notification-toast={t.level}
                                onClick={() => dismissToast(t.id)}
                                className={cn(
                                    "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface-raised p-3 text-left text-primary shadow-popover-md",
                                    level.edge
                                )}
                            >
                                <level.Icon size={15} role="img" aria-label={level.label} className={cn("mt-px shrink-0", level.tone)} />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] font-medium">{t.title}</span>
                                    {t.message ? (
                                        <span className="mt-0.5 block text-[12px] text-secondary">{t.message}</span>
                                    ) : null}
                                </span>
                            </motion.button>
                        );
                    })}
                </AnimatePresence>
            </div>
        </MotionConfig>
    );
}
