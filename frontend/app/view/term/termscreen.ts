// registry of live terminals by block id, so the agents surface can read a screen without the term view model

export type ScreenTerminal = {
    rows: number;
    buffer: {
        active: {
            baseY: number;
            getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
        };
    };
    write?(data: string): void;
};

const terminals = new Map<string, ScreenTerminal>();

export function registerTermScreen(blockId: string, term: ScreenTerminal): () => void {
    terminals.set(blockId, term);
    return () => {
        // a newer terminal for the same block must survive a stale dispose
        if (terminals.get(blockId) === term) terminals.delete(blockId);
    };
}

export function termForBlock(blockId: string): ScreenTerminal | undefined {
    return terminals.get(blockId);
}

// the live screen (the last `rows` lines of the buffer), not the viewport: a hidden terminal scrolled up still reads current
export function screenRows(blockId: string): string[] | null {
    const term = terminals.get(blockId);
    if (!term) return null;
    const buf = term.buffer.active;
    const out: string[] = [];
    for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
        out.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    return out;
}
