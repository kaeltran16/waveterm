import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, pushToast, TOAST_TTL_MS, toastsAtom } from "./notificationstore";
import { ERROR_TOAST_TTL_MS } from "./toaststack";

describe("notificationstore", () => {
    beforeEach(() => {
        globalStore.set(toastsAtom, []);
        vi.useFakeTimers();
    });

    it("pushes a toast into the atom", () => {
        pushToast({ title: "hi", message: "there", level: "info" });
        const toasts = globalStore.get(toastsAtom);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].title).toBe("hi");
    });

    it("caps the stack at five and auto-dismisses", () => {
        for (let i = 0; i < 6; i++) pushToast({ title: `t${i}`, message: "", level: "info" });
        expect(globalStore.get(toastsAtom)).toHaveLength(5);
        vi.advanceTimersByTime(7000);
        expect(globalStore.get(toastsAtom)).toHaveLength(0);
    });

    it("keeps an error toast past the info lifetime, until the error lifetime", () => {
        pushToast({ title: "info", message: "", level: "info" });
        pushToast({ title: "error", message: "", level: "error" });
        vi.advanceTimersByTime(TOAST_TTL_MS);
        expect(globalStore.get(toastsAtom).map((t) => t.title)).toEqual(["error"]);
        vi.advanceTimersByTime(ERROR_TOAST_TTL_MS - TOAST_TTL_MS);
        expect(globalStore.get(toastsAtom)).toHaveLength(0);
    });

    it("dismisses a specific toast", () => {
        pushToast({ title: "a", message: "", level: "info" });
        pushToast({ title: "b", message: "", level: "info" });
        const first = globalStore.get(toastsAtom)[0];
        dismissToast(first.id);
        expect(globalStore.get(toastsAtom).map((t) => t.title)).toEqual(["b"]);
    });
});
