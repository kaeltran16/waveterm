// Minimal toast store for the cockpit's own transient feedback (a failed open, a focus warning). A
// `wsh notify` is not a toast: the avatar is its only voice (petsources.tsx), so the two never say one
// thing twice in the same corner.

import { atom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";

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
