// Minimal toast store for the cockpit. Notifications arrive on the "notify" wave event
// (wsh notify / wave_notify) and live only in this atom — no router, no persistence.

import { atom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";

export interface ToastNotification {
    id: number;
    title: string;
    message: string;
    level: "info" | "warn" | "error";
}

export const toastsAtom = atom<ToastNotification[]>([]);

let nextId = 1;
export const TOAST_TTL_MS = 6000;
const MAX_TOASTS = 5;

export function pushToast(n: Omit<ToastNotification, "id">): void {
    const toast = { ...n, id: nextId++ };
    globalStore.set(toastsAtom, (prev) => [...prev.slice(-(MAX_TOASTS - 1)), toast]);
    setTimeout(() => dismissToast(toast.id), TOAST_TTL_MS);
}

export function dismissToast(id: number): void {
    globalStore.set(toastsAtom, (prev) => prev.filter((t) => t.id !== id));
}

let subscribed = false;
export function setupNotificationSubscription(): void {
    if (subscribed) return;
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "notify",
        handler: (event) => {
            const data = event.data as NotifyCommandData;
            if (!data?.title) return;
            const level = data.level === "error" || data.level === "warn" ? data.level : "info";
            pushToast({ title: data.title, message: data.message ?? "", level });
        },
    });
}
