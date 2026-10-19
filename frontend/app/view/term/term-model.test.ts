import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    globalGet: vi.fn(),
    isMac: false,
}));

vi.mock("@/app/store/global", () => ({
    atoms: {},
    getApi: () => ({}),
    getBlockMetaKeyAtom: vi.fn(),
    getOverrideConfigAtom: vi.fn((blockId: string, key: string) => `${blockId}:${key}`),
    getSettingsKeyAtom: vi.fn((key: string) => key),
    globalStore: { get: mocks.globalGet, set: vi.fn() },
    useBlockAtom: vi.fn((_blockId: string, _key: string, fn: () => unknown) => fn()),
    WOS: { getWaveObjectAtom: vi.fn((oref: string) => oref), makeORef: vi.fn((type: string, id: string) => `${type}:${id}`) },
}));

vi.mock("@/app/store/keymodel", () => ({ appHandleKeyDown: vi.fn(() => false) }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => vi.fn()) }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrouter", () => ({ makeFeBlockRouteId: vi.fn((blockId: string) => `fe:${blockId}`) }));
vi.mock("@/app/store/wshrpcutil", () => ({ DefaultRouter: { registerRoute: vi.fn(), unregisterRoute: vi.fn() }, TabRpcClient: {} }));
vi.mock("@/app/view/term/term", () => ({ TerminalView: vi.fn() }));
vi.mock("@/app/view/term/term-wsh", () => ({ TermWshClient: vi.fn() }));
vi.mock("@/store/services", () => ({}));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => mocks.isMac, isWindows: () => true }));

import { TermViewModel } from "./term-model";

function makeKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        type: "keydown",
        key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...opts,
    } as unknown as KeyboardEvent;
}

function makeModel(pasteHandler = vi.fn(), keyDownHandler = vi.fn(() => false)) {
    return {
        blockId: "b1",
        keyDownHandler,
        sendDataToController: vi.fn(),
        shouldHandleCtrlVPaste: TermViewModel.prototype.shouldHandleCtrlVPaste,
        handleTerminalKeydown: TermViewModel.prototype.handleTerminalKeydown,
        termRef: { current: { pasteHandler } },
    };
}

beforeEach(() => {
    mocks.isMac = false;
    mocks.globalGet.mockReturnValue(undefined);
});

describe("TermViewModel.handleTerminalKeydown", () => {
    it("routes Ctrl+V through the terminal paste handler", () => {
        const pasteHandler = vi.fn();
        const model = makeModel(pasteHandler);
        const event = makeKeyEvent("v", { ctrlKey: true });

        const rtn = model.handleTerminalKeydown(event);

        expect(rtn).toBe(false);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(pasteHandler).toHaveBeenCalledOnce();
    });

    it("routes Ctrl+Shift+V through the terminal paste handler", () => {
        const pasteHandler = vi.fn();
        const model = makeModel(pasteHandler);
        const event = makeKeyEvent("v", { ctrlKey: true, shiftKey: true });

        const rtn = model.handleTerminalKeydown(event);

        expect(rtn).toBe(false);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(pasteHandler).toHaveBeenCalledOnce();
    });

    it("ignores anything but a keydown", () => {
        const pasteHandler = vi.fn();
        const model = makeModel(pasteHandler);
        const event = makeKeyEvent("v", { type: "keyup", ctrlKey: true });

        expect(model.handleTerminalKeydown(event)).toBe(true);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(pasteHandler).not.toHaveBeenCalled();
    });

    it("stops a key the block's own handler takes", () => {
        const keyDownHandler = vi.fn(() => true);
        const model = makeModel(vi.fn(), keyDownHandler);
        const event = makeKeyEvent("a");

        expect(model.handleTerminalKeydown(event)).toBe(false);
        expect(keyDownHandler).toHaveBeenCalledOnce();
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it("lets a plain key through untouched", () => {
        const pasteHandler = vi.fn();
        const model = makeModel(pasteHandler);
        const event = makeKeyEvent("a");

        expect(model.handleTerminalKeydown(event)).toBe(true);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(pasteHandler).not.toHaveBeenCalled();
        expect(model.sendDataToController).not.toHaveBeenCalled();
    });

    it("does not paste on Ctrl+V when the setting turns Ctrl+V paste off", () => {
        mocks.globalGet.mockReturnValue(false);
        const pasteHandler = vi.fn();
        const model = makeModel(pasteHandler);
        const event = makeKeyEvent("v", { ctrlKey: true });

        expect(model.handleTerminalKeydown(event)).toBe(true);
        expect(pasteHandler).not.toHaveBeenCalled();
    });

    it("sends Ctrl-A and Ctrl-E for Cmd+Left and Cmd+Right on macOS only", () => {
        mocks.isMac = true;
        const left = makeModel();
        const leftEvent = makeKeyEvent("ArrowLeft", { metaKey: true });
        expect(left.handleTerminalKeydown(leftEvent)).toBe(false);
        expect(left.sendDataToController).toHaveBeenCalledExactlyOnceWith("\x01");
        expect(leftEvent.preventDefault).toHaveBeenCalledOnce();

        const right = makeModel();
        expect(right.handleTerminalKeydown(makeKeyEvent("ArrowRight", { metaKey: true }))).toBe(false);
        expect(right.sendDataToController).toHaveBeenCalledExactlyOnceWith("\x05");

        mocks.isMac = false;
        const other = makeModel();
        expect(other.handleTerminalKeydown(makeKeyEvent("ArrowLeft", { metaKey: true }))).toBe(true);
        expect(other.sendDataToController).not.toHaveBeenCalled();
    });

    it("sends a newline for Shift+Enter unless term:shiftenternewline is off", () => {
        const on = makeModel();
        const onEvent = makeKeyEvent("Enter", { shiftKey: true });
        expect(on.handleTerminalKeydown(onEvent)).toBe(false);
        expect(on.sendDataToController).toHaveBeenCalledExactlyOnceWith("\n");
        expect(onEvent.preventDefault).toHaveBeenCalledOnce();

        mocks.globalGet.mockReturnValue(false);
        const off = makeModel();
        off.handleTerminalKeydown(makeKeyEvent("Enter", { shiftKey: true }));
        expect(off.sendDataToController).not.toHaveBeenCalled();
    });
});
