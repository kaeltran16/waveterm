// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Notes scope's writing side: the draft the palette edits in place of its search, the armed second press
// (del to delete, esc to discard), and saving and deleting. The rules are in palette-notes.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { useEffect, useRef, useState, type RefObject } from "react";
import { errorText, runPaletteAction } from "./palette-action";
import type { PaletteDeps } from "./palette-items";
import {
    draftDirty,
    noteTitleError,
    pressArm,
    selectionAfterDelete,
    type Armed,
    type NoteDraft,
} from "./palette-notes";
import { deletePaletteNote, paletteNotesAtom, saveNoteDraft } from "./palette-notesstore";

type EditorDeps = Pick<PaletteDeps, "model" | "setNav" | "setSel" | "setPaletteError">;

export function useNoteEditor(open: boolean, inputRef: RefObject<HTMLInputElement>, deps: EditorDeps) {
    const { model, setNav, setSel, setPaletteError } = deps;
    const [armed, setArmed] = useState<Armed | null>(null);
    // the note being written: while set, the palette is the editor. dropped with each open
    const [draft, setDraft] = useState<NoteDraft | null>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const savingRef = useRef(false);

    useEffect(() => {
        if (open) {
            setDraft(null);
            setArmed(null);
        }
    }, [open]);

    // at: the deleted row's index; count: the note rows listed with it
    const deleteNote = (note: UserNote, at: number, count: number) => {
        setPaletteError(undefined);
        void runPaletteAction(() => deletePaletteNote(note.id)).then((result) => {
            if ("error" in result) {
                setPaletteError(`Delete failed: ${errorText(result.error)}`);
                return;
            }
            setSel(selectionAfterDelete(at, count));
        });
    };

    function openDraft(d: NoteDraft) {
        setDraft(d);
        setArmed(null);
        setPaletteError(undefined);
    }
    const editDraft = (patch: { title?: string; body?: string }) => {
        setDraft((d) => (d == null ? d : { ...d, ...patch }));
        setArmed(null);
        setPaletteError(undefined);
    };
    // Esc, the chip, a backdrop click and the palette toggle all leave through here, back to the Notes list
    // and never out of the palette; unsaved changes take a second leave
    const leaveDraft = () => {
        if (draft == null) {
            return;
        }
        if (draftDirty(draft)) {
            const press = pressArm(armed, "esc", "");
            setArmed(press.armed);
            if (!press.fire) {
                return;
            }
        }
        setDraft(null);
        setPaletteError(undefined);
    };
    const saveDraft = () => {
        if (draft == null || savingRef.current) {
            return;
        }
        const refused = noteTitleError(draft.title);
        if (refused != null) {
            setPaletteError(refused);
            return;
        }
        setPaletteError(undefined);
        savingRef.current = true;
        let id: string;
        void runPaletteAction(async () => {
            id = await saveNoteDraft(draft);
        }).then((result) => {
            savingRef.current = false;
            if ("error" in result) {
                setPaletteError(`Save failed: ${errorText(result.error)}`);
                return;
            }
            setDraft(null);
            setArmed(null);
            setNav((s) => ({ ...s, query: "" }));
            // with no query the list is the store's own order
            setSel(
                Math.max(
                    0,
                    (globalStore.get(paletteNotesAtom) ?? []).findIndex((n) => n.id === id)
                )
            );
        });
    };
    const onEditorKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            // taken here rather than by ModalShell's window listener, which cannot tell a held key: an
            // auto-repeat must not confirm its own discard
            e.stopPropagation();
            if (!e.repeat) {
                leaveDraft();
            }
            return;
        }
        setArmed(null);
        if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            // a held key would add a new note once per repeat
            if (!e.repeat) {
                saveDraft();
            }
        } else if (e.key === "Tab" || (e.key === "Enter" && e.target === inputRef.current)) {
            e.preventDefault();
            (e.target === bodyRef.current ? inputRef : bodyRef).current?.focus();
        }
    };

    const editing = draft != null;
    const leaveRef = useRef(leaveDraft);
    leaveRef.current = leaveDraft;
    // Whatever closes the palette while a draft is open (Ctrl+P's toggle is a binding, out of the palette's
    // reach) is taken as a leave: reopened before React sees it closed, so the text is never dropped.
    useEffect(() => {
        if (!editing) {
            return;
        }
        return globalStore.sub(model.paletteOpenAtom, () => {
            if (!globalStore.get(model.paletteOpenAtom)) {
                globalStore.set(model.paletteOpenAtom, true);
                leaveRef.current();
            }
        });
    }, [editing, model]);
    // editing opens with the caret in the body, a new note with no title in the title; leaving hands the
    // keyboard back to the search field
    useEffect(() => {
        if (!open) {
            return;
        }
        const body = bodyRef.current;
        if (draft == null || body == null || (draft.id == null && draft.title === "")) {
            inputRef.current?.focus();
            return;
        }
        body.focus();
        body.setSelectionRange(body.value.length, body.value.length);
    }, [editing]);

    return { draft, armed, setArmed, bodyRef, openDraft, editDraft, leaveDraft, onEditorKeyDown, deleteNote };
}
