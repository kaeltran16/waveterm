import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionGroup, SessionRow, STATUS_COLOR } from "./sessionrow";

function render(props: Partial<Parameters<typeof SessionRow>[0]> = {}): string {
    return renderToStaticMarkup(
        <SessionRow
            label="claude"
            status="working"
            active={false}
            blocked={false}
            pinned={false}
            onSelect={() => null}
            onTogglePin={() => null}
            {...props}
        />
    );
}

describe("SessionRow", () => {
    it("renders the label", () => {
        expect(render({ label: "claude · CorrelationEngine" })).toContain("claude · CorrelationEngine");
    });
    it("colors the dot by status", () => {
        expect(render({ status: "working" })).toContain(STATUS_COLOR.working);
        expect(render({ status: "waiting" })).toContain(STATUS_COLOR.waiting);
        expect(render({ status: "idle" })).toContain(STATUS_COLOR.idle);
    });
    it("applies the active accent class when active", () => {
        expect(render({ active: true })).toContain("session-row--active");
    });
    it("applies the blocked accent class when blocked", () => {
        expect(render({ blocked: true })).toContain("session-row--blocked");
    });
    it("renders a pin affordance", () => {
        expect(render()).toContain("fa-thumbtack");
    });
});

function renderGroup(props: Partial<Parameters<typeof SessionGroup>[0]> = {}): string {
    return renderToStaticMarkup(
        <SessionGroup
            label="CorrelationEngine"
            count={2}
            collapsed={false}
            aggregateStatus="idle"
            onToggle={() => null}
            {...props}
        >
            <div>child-row</div>
        </SessionGroup>
    );
}

describe("SessionGroup", () => {
    it("shows the label and count", () => {
        const html = renderGroup();
        expect(html).toContain("CorrelationEngine");
        expect(html).toContain("2");
    });
    it("renders children when expanded", () => {
        expect(renderGroup({ collapsed: false })).toContain("child-row");
    });
    it("hides children when collapsed", () => {
        expect(renderGroup({ collapsed: true })).not.toContain("child-row");
    });
    it("shows a chevron-down when expanded and chevron-right when collapsed", () => {
        expect(renderGroup({ collapsed: false })).toContain("fa-chevron-down");
        expect(renderGroup({ collapsed: true })).toContain("fa-chevron-right");
    });
    it("shows the aggregate dot color when collapsed", () => {
        expect(renderGroup({ collapsed: true, aggregateStatus: "waiting" })).toContain(STATUS_COLOR.waiting);
    });
});
