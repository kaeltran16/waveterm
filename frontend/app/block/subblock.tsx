// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The SubBlock chain, split out of block.tsx so the tiling frame (Block/BlockFrame) can be
// deleted while the terminal's VDOM sub-block keeps working. Uses makeViewModel (slimmed registry).
import { FullSubBlockProps, SubBlockProps } from "@/app/block/blocktypes";
import { useTabModel } from "@/app/store/tab-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { ErrorBoundary } from "@/element/errorboundary";
import { CenteredDiv } from "@/element/quickelems";
import { counterInc } from "@/store/counters";
import { getBlockComponentModel, registerBlockComponentModel, unregisterBlockComponentModel } from "@/store/global";
import { makeORef } from "@/store/wos";
import { isBlank, useAtomValueSafe } from "@/util/util";
import clsx from "clsx";
import { useAtomValue } from "jotai";
import { memo, Suspense, useEffect, useMemo, useRef } from "react";
import { BlockEnv } from "./blockenv";
import { makeViewModel } from "./blockregistry";

function getViewElem(
    blockId: string,
    blockRef: React.RefObject<HTMLDivElement>,
    contentRef: React.RefObject<HTMLDivElement>,
    blockView: string,
    viewModel: ViewModel
): React.ReactElement {
    if (isBlank(blockView)) {
        return <CenteredDiv>No View</CenteredDiv>;
    }
    if (viewModel.viewComponent == null) {
        return <CenteredDiv>No View Component</CenteredDiv>;
    }
    const VC = viewModel.viewComponent;
    return <VC key={blockId} blockId={blockId} blockRef={blockRef} contentRef={contentRef} model={viewModel} />;
}

const BlockSubBlock = memo(({ nodeModel, viewModel }: FullSubBlockProps) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const blockIsNull = useAtomValue(waveEnv.wos.isWaveObjectNullAtom(makeORef("block", nodeModel.blockId)));
    const blockView = useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "view")) ?? "";
    const blockRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const viewElem = useMemo(
        () => getViewElem(nodeModel.blockId, blockRef, contentRef, blockView, viewModel),
        [nodeModel.blockId, blockView, viewModel]
    );
    const noPadding = useAtomValueSafe(viewModel.noPadding);
    if (blockIsNull) {
        return null;
    }
    return (
        <div key="content" className={clsx("block-content", { "block-no-padding": noPadding })} ref={contentRef}>
            <ErrorBoundary>
                <Suspense fallback={<CenteredDiv>Loading...</CenteredDiv>}>{viewElem}</Suspense>
            </ErrorBoundary>
        </div>
    );
});

const SubBlockInner = memo((props: SubBlockProps & { viewType: string }) => {
    counterInc("render-Block");
    counterInc("render-Block-" + props.nodeModel.blockId?.substring(0, 8));
    const tabModel = useTabModel();
    const waveEnv = useWaveEnv();
    const bcm = getBlockComponentModel(props.nodeModel.blockId);
    let viewModel = bcm?.viewModel;
    if (viewModel == null) {
        // viewModel gets the full waveEnv
        viewModel = makeViewModel(props.nodeModel.blockId, props.viewType, props.nodeModel, tabModel, waveEnv);
        registerBlockComponentModel(props.nodeModel.blockId, { viewModel });
    }
    useEffect(() => {
        return () => {
            unregisterBlockComponentModel(props.nodeModel.blockId);
            viewModel?.dispose?.();
        };
    }, []);
    return <BlockSubBlock {...props} viewModel={viewModel} />;
});
SubBlockInner.displayName = "SubBlockInner";

const SubBlock = memo((props: SubBlockProps) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const isNull = useAtomValue(waveEnv.wos.isWaveObjectNullAtom(makeORef("block", props.nodeModel.blockId)));
    const viewType = useAtomValue(waveEnv.getBlockMetaKeyAtom(props.nodeModel.blockId, "view")) ?? "";
    if (isNull || isBlank(props.nodeModel.blockId)) {
        return null;
    }
    return <SubBlockInner key={props.nodeModel.blockId + ":" + viewType} {...props} viewType={viewType} />;
});

export { SubBlock };
