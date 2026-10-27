import { decisionDate } from "../../web/src/decisions/model";
import {
  useProjectedDecisions,
  type WorkIndexWorkspace,
} from "../../web/src/hosted-work-index";
import type { Id } from "../../convex/_generated/dataModel";
// SPDX-License-Identifier: Apache-2.0
// Local immutable owner-record fixtures plus one illustrative Intent. No backend or credentials.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { DecisionRecord } from "../../src/decision-types";
import real from "./owner-decisions.json";
import { Shell } from "../../web/src/shell/Shell";
import { WorkHeaderProvider } from "../../web/src/shell/WorkHeader";
import { Panel } from "../../web/src/ui/primitives";
import { Glyph } from "../../web/src/ui/Glyph";
import { OwnerDecisionsContext } from "../../web/src/decisions/context";
import { OwnerDecisionsRoute } from "../../web/src/decisions/OwnerDecisionsRoute";
import { OwnerDecisionsList } from "../../web/src/decisions/OwnerDecisionsList";
import { OwnerDecisionPage } from "../../web/src/decisions/OwnerDecisionPage";
import {
  OwnerDecisionsPointer,
  OwnerDecisionsDisclosure,
} from "../../web/src/decisions/OwnerDecisionsPanel";
import { IntentDetailView } from "../../web/src/intents/IntentDetail";
import "../../web/src/legacy.css";
import "../../web/src/ui/tokens.css";
import "../../web/src/ui/components.css";
import "../../web/src/ui/signals.css";
import "../../web/src/cockpit/cockpit.css";
import "../../web/src/shell/shell.css";
import "../../web/src/lane/lane.css";
import "../../web/src/lane/lane-fable.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("forge-theme", params.get("theme") ?? "dark");
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
const now = Date.parse("2026-10-25T12:00:00Z");
const intentId = "10000000-0000-4000-8000-000000000001";
const intents = [{ id: intentId, outcome: "Faster first byte from R2" }];
const scoped: DecisionRecord = {
  ...real[0]!,
  id: "10000000-0000-4000-8000-000000000002",
  operationId: "10000000-0000-4000-8000-000000000002",
  target: { kind: "intent", intentId },
  what: "This Intent lands on the focused contract check (r2-range, r2-upload) instead of the full suite.",
  why: "The change is confined to src/r2; the full suite runs continuously on main and repairs forward.",
  decidedAt: "2026-10-25T08:40:00Z",
  at: "2026-10-25T08:40:00Z",
  overrides: {
    kind: "default",
    description: "Full-suite landing gate",
    link: "docs/workflows.md",
  },
  actor: { name: "Dino", kind: "human" },
} as DecisionRecord;
const records = [...real, scoped] as DecisionRecord[];
const href = (surface: string, id?: string) =>
  `?surface=${surface}&theme=${params.get("theme") ?? "dark"}${id ? `&decision=${id}` : ""}`;
const links = {
  recordHref: (id: string) => href("record", id),
  intentHref: () => href("intent"),
  documentHref: () => "#document",
};
const tabs = [
  { id: "now", label: "Now", glyph: "now" },
  { id: "work", label: "Work", glyph: "intent" },
  { id: "code", label: "Code", glyph: "code" },
  { id: "settings", label: "Settings", glyph: "settings" },
] as const;
let decisionReads = 0;
let selectedWorkspace: WorkIndexWorkspace;
Object.assign(globalThis, {
  __forgeTree: {
    queries: {
      "projectWorkIndex:records": () => {
        decisionReads++;
        const current =
          selectedWorkspace.decisionVersion === "v2"
            ? [
                ...records,
                { ...scoped, id: "new-record", what: "An additional decision" },
              ]
            : records;
        return {
          generationId: "fixture-generation",
          revision: selectedWorkspace.revision,
          page: current.map((record, position) => ({
            id: record.id,
            position,
            value: JSON.stringify(record),
          })),
          isDone: true,
          continueCursor: "",
        };
      },
      "projectWorkIndex:workspace": () => {
        decisionReads++;
        return JSON.stringify(selectedWorkspace);
      },
    },
  },
});
function DecisionCache() {
  const [revision, setRevision] = useState(1);
  const [version, setVersion] = useState("v1");
  selectedWorkspace = {
    generationId: "fixture-generation",
    decisionVersion: version,
    revision,
  } as WorkIndexWorkspace;
  const value = useProjectedDecisions(
    "fixture-project" as Id<"hostedProjects">,
    selectedWorkspace,
  );
  return (
    <div>
      <h1>Decision cache</h1>
      <p data-testid="cache-count">
        {value.loading ? "Loading" : value.records.length}
      </p>
      <p data-testid="cache-reads">{decisionReads}</p>
      <button onClick={() => setRevision(revision + 1)}>
        Unrelated Work revision
      </button>
      <button onClick={() => setVersion("v2")}>New decision version</button>
    </div>
  );
}
function Preview() {
  const [surface, setSurface] = useState(params.get("surface") ?? "list");
  const old = records.find((record) =>
    records.some((next) => next.supersedes === record.id),
  )!;
  const selected =
    records.find((record) => record.id === params.get("decision")) ?? old;
  const empty = params.get("empty") === "1";
  const nowAt = params.get("stale") === "1" ? now + 8 * 86_400_000 : now;
  return (
    <OwnerDecisionsContext.Provider
      value={{ records: empty ? [] : records, intents, now: nowAt, links }}
    >
      <WorkHeaderProvider
        page={surface === "list" ? "decisions" : undefined}
        onChange={() => setSurface("list")}
      >
        <Shell
          tabs={tabs}
          current={surface === "now" ? "now" : "work"}
          onTab={(tab) => setSurface(tab === "now" ? "now" : "list")}
          accountName="Dino"
          context={<span className="fx-switch">nanthai-forge</span>}
        >
          {surface === "cache" ? (
            <DecisionCache />
          ) : surface === "intent" ? (
            <IntentDetailView
              row={{
                id: intentId,
                outcome: intents[0]!.outcome,
                constraints:
                  "Serve the first byte straight from R2 with a presigned range read. Retry multipart uploads once on 5xx. No new dependencies.",
                status: "active",
                tone: "active",
                label: "Working",
                lanes: [],
                open: [],
                decisions: 1,
                views: 0,
                ready: false,
              }}
              views={[]}
              notes={[]}
              planning={[]}
              now={now}
              laneHref={() => "#lane"}
            />
          ) : surface === "route" ? (
            <OwnerDecisionsRoute />
          ) : (
            <div className="fx-page">
              <nav className="fx-crumbs">
                <a href={href("list")}>Work</a>
                <Glyph name="chevron" size={12} />
                <a href={href("list")}>Decisions</a>
                {surface === "record" && (
                  <>
                    <Glyph name="chevron" size={12} />
                    <span>Decision · {decisionDate(selected.decidedAt)}</span>
                  </>
                )}
              </nav>
              {surface === "record" ? (
                <div className="fx-work-grid">
                  <OwnerDecisionPage
                    {...links}
                    {...{ records, intents, now }}
                    record={selected}
                  />
                </div>
              ) : surface === "review" ? (
                <div className="fx-work-grid">
                  <Panel title="Changes">
                    <p className="fx-panel-note">Candidate from Upload retry</p>
                  </Panel>
                  <div className="fx-lane-col">
                    <Panel title="Your decision">
                      <p className="fx-panel-note">
                        Contract check passed on exactly this Candidate.
                      </p>
                    </Panel>
                    <OwnerDecisionsDisclosure intentId={intentId} />
                  </div>
                </div>
              ) : surface === "now" ? (
                <>
                  <h1>Now</h1>
                  <div className="fx-work-grid">
                    <Panel title="Needs you">
                      <p className="fx-panel-note">Nothing needs you.</p>
                    </Panel>
                    <OwnerDecisionsPointer />
                  </div>
                </>
              ) : (
                <OwnerDecisionsList
                  {...links}
                  records={empty ? [] : records}
                  intents={intents}
                  now={now}
                />
              )}
            </div>
          )}
        </Shell>
      </WorkHeaderProvider>
    </OwnerDecisionsContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
