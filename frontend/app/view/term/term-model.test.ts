import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    nativePaste: vi.fn(),
    globalGet: vi.fn(),
}));

vi.mock("@/app/store/global", () => ({
    atoms: {},
    getAllBlockComponentModels: vi.fn(() => []),
    getApi: () => ({ nativePaste: mocks.nativePaste }),
    getBlockComponentModel: vi.fn(),
    getBlockMetaKeyAtom: vi.fn(),
    getBlockTermDurableAtom: vi.fn(),
    getConnStatusAtom: vi.fn(),
    getOverrideConfigAtom: vi.fn((blockId: string, key: string) => `${blockId}:${key}`),
    getSettingsKeyAtom: vi.fn((key: string) => key),
    globalStore: { get: mocks.globalGet, set: vi.fn() },
    readAtom: vi.fn(),
    recordTEvent: vi.fn(),
    useBlockAtom: vi.fn((_blockId: string, _key: string, fn: () => unknown) => fn()),
    WOS: { getWaveObjectAtom: vi.fn((oref: string) => oref), makeORef: vi.fn((type: string, id: string) => `${type}:${id}`) },
}));

vi.mock("@/app/store/keymodel", () => ({ appHandleKeyDown: vi.fn(() => false) }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => vi.fn()) }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrouter", () => ({ makeFeBlockRouteId: vi.fn((blockId: string) => `fe:${blockId}`) }));
vi.mock("@/app/store/wshrpcutil", () => ({ DefaultRouter: { registerRoute: vi.fn(), unregisterRoute: vi.fn() }, TabRpcClient: {} }));
vi.mock("@/app/view/term/term", () => ({ TermClaudeIcon: vi.fn(), TerminalView: vi.fn() }));
vi.mock("@/app/view/term/term-wsh", () => ({ TermWshClient: vi.fn() }));
vi.mock("@/app/view/vdom/vdom-model", () => ({ VDomModel: vi.fn() }));
vi.mock("@/store/services", () => ({}));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => false, isWindows: () => true }));

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

function makeModel(pasteHandler = vi.fn()) {
    return {
        blockId: "b1",
        keyDownHandler: vi.fn(() => false),
        shouldHandleCtrlVPaste: TermViewModel.prototype.shouldHandleCtrlVPaste,
        handleTerminalKeydown: TermViewModel.prototype.handleTerminalKeydown,
        termRef: { current: { pasteHandler } },
    };
}

beforeEach(() => {
    mocks.nativePaste.mockClear();
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
        expect(mocks.nativePaste).not.toHaveBeenCalled();
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
        expect(mocks.nativePaste).not.toHaveBeenCalled();
    });
});
