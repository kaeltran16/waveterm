// one-off: click the "Channels" nav button in the dev app over CDP, then screenshot.
const port = "9222";
const out = process.argv[2] ?? "cdp-shots/channels.png";

async function pickTarget() {
    const res = await fetch(`http://localhost:${port}/json/list`);
    const targets = await res.json();
    return (
        targets.find((t) => t.type === "page" && /localhost:5174|wave|arc/i.test(t.url ?? "")) ??
        targets.find((t) => t.type === "page")
    );
}

function cdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (method, params = {}) => {
                    const msgId = ++id;
                    ws.send(JSON.stringify({ id: msgId, method, params }));
                    return new Promise((res) => pending.set(msgId, res));
                },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg.result);
                pending.delete(msg.id);
            }
        });
    });
}

const target = await pickTarget();
if (!target) {
    console.error(`no page target on :${port}`);
    process.exit(1);
}
const client = await cdp(target.webSocketDebuggerUrl);
await client.send("Runtime.enable");
const r = await client.send("Runtime.evaluate", {
    expression: `(() => {
        const btns = [...document.querySelectorAll('nav button')];
        const b = btns.find((x) => /Channels/i.test(x.textContent || ""));
        if (!b) return "no channels button; nav buttons: " + btns.map(x=>x.textContent).join("|");
        b.click();
        return "clicked: " + (b.textContent || "");
    })()`,
    returnByValue: true,
});
console.log(JSON.stringify(r.result?.value ?? r));
await new Promise((res) => setTimeout(res, 800));
await client.send("Page.enable");
const { data } = await client.send("Page.captureScreenshot", { format: "png" });
client.close();
const { writeFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(data, "base64"));
console.log(`captured ${target.url} -> ${out}`);
