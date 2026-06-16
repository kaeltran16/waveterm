import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionGroup, SessionRow, STATUS_COLOR, SUBAGENT_MARKER_COLOR, SubagentRow } from "./sessionrow";

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
    it("renders the detail line when provided", () => {
        expect(render({ detail: "editing CorrelationEngine.java" })).toContain("editing CorrelationEngine.java");
    });
    it("omits the detail line when not provided", () => {
        expect(render({ detail: undefined })).not.toContain("session-row-detail");
    });
    it("shows a subagent count and a chevron when there are subagents", () => {
        const html = render({ subagentCount: 2, expanded: false });
        expect(html).toContain(">2<");
        expect(html).toContain("fa-chevron-right");
    });
    it("shows a chevron-down when expanded", () => {
        expect(render({ subagentCount: 1, expanded: true })).toContain("fa-chevron-down");
    });
    it("omits the subagent chevron when there are none", () => {
        const html = render({ subagentCount: 0 });
        expect(html).not.toContain("fa-chevron-right");
        expect(html).not.toContain("fa-chevron-down");
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

function renderSub(props: Partial<Parameters<typeof SubagentRow>[0]> = {}): string {
    return renderToStaticMarkup(<SubagentRow type="Explore" state="working" last={false} {...props} />);
}

describe("SubagentRow", () => {
    it("renders the subagent type", () => {
        expect(renderSub({ type: "general-purpose" })).toContain("general-purpose");
    });
    it("colors the marker by state", () => {
        expect(renderSub({ state: "working" })).toContain(SUBAGENT_MARKER_COLOR.working);
        expect(renderSub({ state: "success" })).toContain(SUBAGENT_MARKER_COLOR.success);
        expect(renderSub({ state: "failure" })).toContain(SUBAGENT_MARKER_COLOR.failure);
    });
    it("renders the marker glyph by state", () => {
        expect(renderSub({ state: "working" })).toContain("◦");
        expect(renderSub({ state: "success" })).toContain("✓");
        expect(renderSub({ state: "failure" })).toContain("✗");
    });
    it("uses a tee connector for a non-last child and an elbow for the last", () => {
        expect(renderSub({ last: false })).toContain("├─");
        expect(renderSub({ last: true })).toContain("└─");
    });
    it("sets a title for hover/truncation", () => {
        expect(renderSub({ type: "a-very-long-subagent-type-name" })).toContain('title="a-very-long-subagent-type-name"');
    });
});

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
