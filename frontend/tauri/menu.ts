import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

// Electron roles we map to Tauri PredefinedMenuItem; anything else falls back to a plain item.
const ROLE_MAP: Record<string, string> = {
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    selectall: "SelectAll",
    undo: "Undo",
    redo: "Redo",
};

async function buildItems(items: ContextMenuItem[]): Promise<any[]> {
    const out: any[] = [];
    for (const it of items) {
        if (it.visible === false) continue;
        if (it.type === "separator") {
            out.push(await PredefinedMenuItem.new({ item: "Separator" }));
            continue;
        }
        const role = it.role?.toLowerCase();
        if (role && ROLE_MAP[role]) {
            out.push(await PredefinedMenuItem.new({ item: ROLE_MAP[role] as any }));
            continue;
        }
        if (it.submenu) {
            out.push(await Submenu.new({ text: it.label ?? "", enabled: it.enabled, items: await buildItems(it.submenu) }));
            continue;
        }
        if (it.type === "checkbox") {
            out.push(await CheckMenuItem.new({ text: it.label ?? "", checked: it.checked, enabled: it.enabled, action: it.click }));
            continue;
        }
        out.push(await MenuItem.new({ text: it.label ?? "", enabled: it.enabled, action: it.click }));
    }
    return out;
}

// The long-term context-menu primitive: callbacks fire directly in JS (no id round-trip, no
// Rust). Phase 5's ContextMenuModel imports this and drops getApi().showContextMenu.
export async function buildTauriMenu(items: ContextMenuItem[]): Promise<Menu> {
    return Menu.new({ items: await buildItems(items) });
}
