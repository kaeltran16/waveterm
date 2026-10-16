// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { NullErrorBoundary } from "@/app/element/errorboundary";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { useTabModel } from "@/app/store/tab-model";
import type { TermViewModel } from "@/app/view/term/term-model";
import { activePalette, deriveTermTheme } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { atoms, getOverrideConfigAtom, getSettingsPrefixAtom, WOS } from "@/store/global";
import { fireAndForget } from "@/util/util";
import debug from "debug";
import * as jotai from "jotai";
import * as React from "react";
import { TermLinkTooltip } from "./term-tooltip";
import { TermThemeUpdater } from "./termtheme";
import { normalizeCursorStyle } from "./termutil";
import { TermWrap } from "./termwrap";
import "./xterm.css";

const dlog = debug("wave:term");

const TerminalView = ({ blockId, model }: ViewComponentProps<TermViewModel>) => {
    const connectElemRef = React.useRef<HTMLDivElement>(null);
    const [termWrapInst, setTermWrapInst] = React.useState<TermWrap | null>(null);
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const termSettingsAtom = getSettingsPrefixAtom("term");
    const termSettings = jotai.useAtomValue(termSettingsAtom);

    const tabModel = useTabModel();
    const termFontSize = jotai.useAtomValue(model.fontSizeAtom);
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    const connFontFamily = fullConfig.connections?.[blockData?.meta?.connection]?.["term:fontfamily"];

    React.useEffect(() => {
        const termMacOptionIsMetaAtom = getOverrideConfigAtom(blockId, "term:macoptionismeta");
        const termTheme = deriveTermTheme(
            activePalette(globalStore.get(themePresetAtom)),
            globalStore.get(themeOverridesAtom)
        );
        let termScrollback = 2000;
        if (termSettings?.["term:scrollback"]) {
            termScrollback = Math.floor(termSettings["term:scrollback"]);
        }
        if (blockData?.meta?.["term:scrollback"]) {
            termScrollback = Math.floor(blockData.meta["term:scrollback"]);
        }
        if (termScrollback < 0) {
            termScrollback = 0;
        }
        if (termScrollback > 50000) {
            termScrollback = 50000;
        }
        const termAllowBPM = globalStore.get(model.termBPMAtom) ?? true;
        const termMacOptionIsMeta = globalStore.get(termMacOptionIsMetaAtom) ?? false;
        const termCursorStyle = normalizeCursorStyle(globalStore.get(getOverrideConfigAtom(blockId, "term:cursor")));
        const termCursorBlink = globalStore.get(getOverrideConfigAtom(blockId, "term:cursorblink")) ?? false;
        const wasFocused = model.termRef.current != null && globalStore.get(model.nodeModel.isFocused);
        const termWrap = new TermWrap(
            tabModel.tabId,
            blockId,
            connectElemRef.current,
            {
                theme: termTheme,
                fontSize: termFontSize,
                fontFamily: termSettings?.["term:fontfamily"] ?? connFontFamily ?? "Hack",
                drawBoldTextInBrightColors: false,
                fontWeight: "normal",
                fontWeightBold: "bold",
                allowTransparency: true,
                scrollback: termScrollback,
                ignoreBracketedPasteMode: !termAllowBPM,
                macOptionIsMeta: termMacOptionIsMeta,
                cursorStyle: termCursorStyle,
                cursorBlink: termCursorBlink,
                overviewRuler: { width: 6 },
            },
            {
                keydownHandler: model.handleTerminalKeydown.bind(model),
                useWebGl: !termSettings?.["term:disablewebgl"],
                sendDataHandler: model.sendDataToController.bind(model),
                nodeModel: model.nodeModel,
            }
        );
        model.termRef.current = termWrap;
        setTermWrapInst(termWrap);
        const rszObs = new ResizeObserver(() => {
            termWrap.handleResize_debounced();
        });
        rszObs.observe(connectElemRef.current);
        fireAndForget(termWrap.initTerminal.bind(termWrap));
        if (wasFocused) {
            setTimeout(() => {
                model.giveFocus();
            }, 10);
        }
        return () => {
            termWrap.dispose();
            rszObs.disconnect();
            setTermWrapInst(null);
        };
    }, [blockId, termSettings, termFontSize, connFontFamily]);

    const handleContextMenu = React.useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const menuItems = model.getContextMenuItems();
            ContextMenuModel.getInstance().showContextMenu(menuItems, e);
        },
        [model]
    );

    return (
        <div
            className="relative flex h-full w-full flex-col overflow-hidden"
            data-term-view
            onContextMenu={handleContextMenu}
        >
            <TermThemeUpdater termRef={model.termRef} />
            <div
                key="connect-elem"
                className="my-[5px] mr-px ml-1 flex min-h-0 grow overflow-hidden leading-none [&_.terminal]:w-full [&_.xterm-decoration-overview-ruler]:!hidden [&_.xterm-viewport]:!bg-transparent"
                ref={connectElemRef}
            />
            <NullErrorBoundary debugName="TermLinkTooltip">
                <TermLinkTooltip termWrap={termWrapInst} />
            </NullErrorBoundary>
        </div>
    );
};

export { TerminalView };
