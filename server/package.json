import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acceptedCandidates,
  archiveTargetBody,
  classify,
  confirmationBody,
  decodeJwtPayload,
  fetchMineInboxRows,
  normalizeApiBase,
} from "./garden-inbox.mjs";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const STALE_DAYS = 60;
const API_CONFIG = Object.freeze({
  apiBase: "https://paperclip.example",
  apiKey: "secret",
});

function createIssue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Example",
    status: "done",
    updatedAt: "2025-01-01T00:00:00.000Z",
    blockedBy: [],
    ...overrides,
  };
}

function createWorkspace({ git = {}, linkedIssues, ...overrides } = {}) {
  const defaultReadiness = {
    git: { isMergedIntoBase: false, aheadCount: 0, ...git },
    linkedIssues: linkedIssues ?? [{ isTerminal: true }],
  };

  return {
    gone: false,
    error: null,
    status: "active",
    branchCommitAt: "2025-01-01T00:00:00.000Z",
    readiness: overrides.readiness !== undefined ? overrides.readiness : defaultReadiness,
    ...overrides,
  };
}

function createCandidate(overrides = {}) {
  return {
    issueId: "issue-1",
    identifier: "PAP-1",
    title: "Candidate",
    bucket: "B",
    lastActivityAt: "2026-05-01T00:00:00.000Z",
    reason: { message: "Stale." },
    ...overrides,
  };
}

function createInteraction({ optionIds = ["issue-1"], selectedOptionIds = ["issue-1"], ...overrides } = {}) {
  return {
    id: "interaction-1",
    kind: "request_checkbox_confirmation",
    idempotencyKey: "garden-inbox:scan-1:1:1",
    status: "accepted",
    payload: { options: optionIds.map((id) => ({ id })) },
    result: { outcome: "accepted", selectedOptionIds },
    ...overrides,
  };
}

describe("classify()", () => {
  test("classifies each archive and keep condition into its respective bucket", async (t) => {
    const cases = [
      {
        name: "Bucket A: merged into base and terminal",
        issue: createIssue(),
        workspace: createWorkspace({ git: { isMergedIntoBase: true, aheadCount: 0 } }),
        expectedBucket: "A",
      },
      {
        name: "Bucket B: unmerged with 0 commits ahead and terminal",
        issue: createIssue(),
        workspace: createWorkspace(),
        expectedBucket: "B",
      },
      {
        name: "Bucket C: unmerged with commits ahead",
        issue: createIssue(),
        workspace: createWorkspace({ git: { isMergedIntoBase: false, aheadCount: 2 } }),
        expectedBucket: "C",
      },
      {
        name: "Bucket D: active/in-progress issue",
        issue: createIssue({ status: "in_progress" }),
        workspace: createWorkspace(),
        expectedBucket: "D",
      },
    ];

    for (const { name, issue, workspace, expectedBucket } of cases) {
      await t.test(name, () => {
        assert.equal(classify(issue, workspace, STALE_DAYS, NOW).bucket, expectedBucket);
      });
    }
  });

  test("keeps candidates when workspace safety inspection fails", () => {
    const failedWorkspace = createWorkspace({
      error: "503 Service Unavailable",
      readiness: null,
    });

    const result = classify(createIssue(), failedWorkspace, STALE_DAYS, NOW);

    assert.equal(result.bucket, "D");
    assert.equal(result.reason.code, "workspace_inspection_failed");
  });
});

describe("confirmationBody() & acceptedCandidates()", () => {
  const scan = Object.freeze({ scanId: "scan-1", staleDays: STALE_DAYS });

  test("returns only accepted options from the originating scan", () => {
    const candidate = createCandidate({ issueId: "issue-1", bucket: "A" });
    const interaction = createInteraction({
      optionIds: ["issue-1"],
      selectedOptionIds: ["issue-1"],
    });
    const candidateMap = new Map([[candidate.issueId, candidate]]);

    assert.deepEqual(acceptedCandidates(interaction, scan, candidateMap), [candidate]);
  });

  test("rejects selected ids that were not offered in the interaction", () => {
    const interaction = createInteraction({
      optionIds: ["issue-1"],
      selectedOptionIds: ["issue-2"],
    });

    assert.throws(
      () => acceptedCandidates(interaction, scan, new Map()),
      /was not an option in the interaction/,
    );
  });

  test("starts previously declined candidates unchecked and deterministically hashes idempotencyKey", () => {
    const candidates = [
      createCandidate({ issueId: "issue-1", identifier: "PAP-1", title: "Kept before" }),
      createCandidate({ issueId: "issue-2", identifier: "PAP-2", title: "New candidate" }),
    ];
    const declinedSet = new Set(["issue-1"]);

    const body = confirmationBody(scan, candidates, 0, 1, declinedSet);

    assert.deepEqual(body.payload.defaultSelectedOptionIds, ["issue-2"]);
    assert.match(body.payload.options[0].description, /Declined in a previous pass; starts unchecked\./);
    assert.doesNotMatch(body.payload.options[1].description, /Declined in a previous pass/);

    assert.notEqual(body.idempotencyKey, "garden-inbox:scan-1:1:1");
    assert.equal(
      body.idempotencyKey,
      confirmationBody(scan, candidates, 0, 1, new Set(["issue-1"])).idempotencyKey,
    );
    assert.notEqual(
      body.idempotencyKey,
      confirmationBody(scan, candidates, 0, 1, new Set(["issue-2"])).idempotencyKey,
    );
    assert.equal(
      confirmationBody(scan, candidates, 0, 1).idempotencyKey,
      "garden-inbox:scan-1:1:1",
    );
    assert.equal(
      confirmationBody(scan, [candidates[1]], 1, 2, declinedSet).idempotencyKey,
      "garden-inbox:scan-1:2:2",
    );
  });
});

describe("auth & request helpers", () => {
  test("preserves an overridden scan user for archive and undo requests", () => {
    assert.deepEqual(archiveTargetBody({ userId: "target-user" }), { userId: "target-user" });
  });

  test("decodes the responsible user from JWT and normalizes API URLs", () => {
    const payload = Buffer.from(JSON.stringify({ responsible_user_id: "user-1" })).toString("base64url");

    assert.equal(decodeJwtPayload(`header.${payload}.signature`).responsible_user_id, "user-1");
    assert.equal(normalizeApiBase("https://paperclip.example/api/"), "https://paperclip.example");
  });
});

describe("fetchMineInboxRows()", () => {
  test("scans Mine once per status and merges duplicate rows by issue id", async (t) => {
    const requestedStatuses = [];
    const fixturesByStatus = {
      todo: [createIssue({ id: "shared", status: "todo" })],
      done: [createIssue({ id: "shared", status: "done" }), createIssue({ id: "done-only" })],
    };

    t.mock.method(globalThis, "fetch", async (url) => {
      const status = new URL(url).searchParams.get("status");
      requestedStatuses.push(status);
      return Response.json(fixturesByStatus[status] ?? [], { status: 200 });
    });

    const result = await fetchMineInboxRows(API_CONFIG, "user-1");

    assert.deepEqual(requestedStatuses, [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
      "done",
    ]);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows.find((row) => row.id === "shared")?.status, "done");
    assert.equal(result.coverage.duplicateCount, 1);
    assert.equal(result.coverage.complete, true);
    assert.deepEqual(result.coverage.statusCounts, {
      backlog: 0,
      todo: 1,
      in_progress: 0,
      in_review: 0,
      blocked: 0,
      done: 2,
    });
  });

  test("marks coverage incomplete when an individual status query hits the 500-row cap", async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
      const status = new URL(url).searchParams.get("status");
      const rows =
        status === "done"
          ? Array.from({ length: 500 }, (_, index) => createIssue({ id: `done-${index}` }))
          : [];
      return Response.json(rows, { status: 200 });
    });

    const result = await fetchMineInboxRows(API_CONFIG, "user-1");

    assert.equal(result.rows.length, 500);
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.coverage.cappedStatuses, ["done"]);
    assert.equal(result.coverage.queryCap, 500);
  });
});
