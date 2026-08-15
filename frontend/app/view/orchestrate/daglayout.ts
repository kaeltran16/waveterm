// Layered (longest-path) layout for the dag graph. Pure: same input, same positions.
export interface LayoutOpts {
    width?: number;
    height?: number;
    gapX?: number;
    gapY?: number;
}

export function computeLayeredLayout(
    tasks: { id: string; deps?: string[] }[],
    opts: LayoutOpts = {}
): Map<string, { x: number; y: number }> {
    const { width = 168, height = 64, gapX = 28, gapY = 48 } = opts;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const layer = new Map<string, number>();
    const visit = (id: string): number => {
        const cached = layer.get(id);
        if (cached !== undefined) return cached;
        const t = byId.get(id)!;
        let l = 0;
        for (const d of t.deps ?? []) l = Math.max(l, visit(d) + 1);
        layer.set(id, l);
        return l;
    };
    for (const t of tasks) visit(t.id);
    const byLayer = new Map<number, string[]>();
    for (const t of tasks) {
        const l = layer.get(t.id)!;
        byLayer.set(l, [...(byLayer.get(l) ?? []), t.id]);
    }
    const out = new Map<string, { x: number; y: number }>();
    for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
        const sorted = [...ids].sort();
        const total = sorted.length * width + (sorted.length - 1) * gapX;
        sorted.forEach((id, i) => {
            out.set(id, { x: -total / 2 + i * (width + gapX) + width / 2, y: l * (height + gapY) });
        });
    }
    return out;
}
