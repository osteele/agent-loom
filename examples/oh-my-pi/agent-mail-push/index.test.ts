import { expect, test } from "bun:test";
import {
  agentMailSessionId,
  descendantProcessIds,
  parseGitStatus,
  parseJjStatus,
  parseListeningDevPorts,
  parseMailStatus,
  renderResidualWidget,
  renderStyledResidualWidget,
  weeklyUsageForProvider,
} from "./index.ts";

test("OMP status preserves an unknown final Weft field", () => {
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t\n")).toEqual({
    name: "Quiet Lantern",
    peers: 2,
    unread: 0,
    unprocessed: undefined,
  });
});

test("OMP status rejects malformed counts instead of implying zero", () => {
  expect(parseMailStatus("Quiet Lantern\tmany\t0\tpush\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\tmany\tpush\t0\n")).toBeUndefined();
  expect(parseMailStatus("Quiet Lantern\t2\t0\tpush\t-1\n")).toBeUndefined();
});

test("OMP shares the launcher identity with its MCP server", () => {
  expect(agentMailSessionId("omp-native", "launcher-shared", "42", 42)).toBe(
    "launcher-shared",
  );
  expect(agentMailSessionId("omp-native", "parent-agent", "41", 42)).toBe(
    "omp-native",
  );
  expect(agentMailSessionId("omp-native", "  ", "42", 42)).toBe(
    "omp-native",
  );
});

test("OMP widget shows only development servers descended from OMP", () => {
  const processes = ["100 1", "101 100", "102 101", "200 1"].join("\n");
  const listeners = [
    "p101",
    "n*:3000",
    "p102",
    "n127.0.0.1:8000",
    "p102",
    "n*:5432",
    "p200",
    "n*:8080",
  ].join("\n");
  const descendants = descendantProcessIds(processes, 100);
  expect([...descendants].sort()).toEqual([100, 101, 102]);
  expect(parseListeningDevPorts(listeners, descendants)).toEqual([3000, 8000]);
});

test("OMP widget reads branch and dirty state from Git porcelain v2", () => {
  expect(
    parseGitStatus(
      [
        "# branch.oid 0123456789abcdef",
        "# branch.head feature/status",
        "1 .M N... 100644 100644 100644 abc def src/index.ts",
      ].join("\n"),
    ),
  ).toBe("feature/status*");
  expect(
    parseGitStatus("# branch.oid 0123456789abcdef\n# branch.head (detached)\n"),
  ).toBe("01234567");
});

test("OMP widget reserves one trailing jj asterisk for dirty state", () => {
  expect(parseJjStatus("change=rrynpnzl\ndirty=1\nbookmark=main*\n")).toBe(
    "main*",
  );
  expect(parseJjStatus("change=rrynpnzl\ndirty=0\n")).toBe("rrynpnzl");
});

test("OMP widget puts aligned progress bars last", () => {
  const lines = renderResidualWidget(
    {
      billing: { mode: "subscription", weeklyUsed: 37 },
      contextPercent: 42,
      effort: "high",
      jj: "main*",
      mail: {
        name: "Evergreen Cake",
        peers: 2,
        unread: 2,
        unprocessed: 3,
      },
      modelName: "GPT-5.6 Sol",
      path: "agent-mail",
      peers: 2,
      pythonEnvironment: ".venv",
      nodeRuntime: "bun",
      devPorts: [3000, 8000],
      push: "online",
    },
    110,
  );
  expect(lines).toEqual([
    "GPT-5.6 Sol/high · 📁 agent-mail · 2 peers · ⅉ main* ·       ctx █████████████████░░░░░░░░░░░░░░░░░░░░░░░  42%",
    "Evergreen Cake · ✉️ 2 · ⚙️ 3 · py .venv · bun · :3000,8000 ·  wk ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░  37%",
  ]);
  const barColumns = lines.map((line) =>
    Bun.stringWidth(line.slice(0, line.indexOf("█"))),
  );
  expect(barColumns[0]).toBe(barColumns[1]);
  expect(lines[0]?.endsWith("42%")).toBe(true);
  expect(lines[1]?.endsWith("37%")).toBe(true);
});

test("OMP widget drops lower-priority fields at half-pane width", () => {
  expect(
    renderResidualWidget(
      {
        effort: "high",
        mail: {
          name: "Evergreen Cake",
          peers: 2,
          unread: 0,
          unprocessed: 0,
        },
        peers: 2,
        pythonEnvironment: ".venv",
        nodeRuntime: "bun",
        devPorts: [3000, 8000],
        push: "online",
      },
      38,
    ),
  ).toEqual([
    "model ?/high · 2 peers · ctx ?",
    "Evergreen Cake · py .venv · bun · wk ?",
  ]);
});

test("OMP widget truncates rather than overflowing a very narrow pane", () => {
  const lines = renderResidualWidget(
    {
      effort: "xhigh",
      peers: 12,
      pythonEnvironment: "long-environment",
      nodeRuntime: "bun",
    },
    14,
  );
  expect(lines).toEqual(["model ?/xhigh", "connecting"]);
  expect(lines.every((line) => Bun.stringWidth(line) <= 14)).toBe(true);
});

test("OMP widget uses the gitsync Jujutsu icon for a change id", () => {
  expect(
    renderResidualWidget(
      {
        effort: "high",
        jj: "qvtszkkm*",
        mail: {
          name: "Evergreen Cake",
          peers: 1,
          unread: 0,
          unprocessed: 0,
        },
        peers: 1,
        push: "online",
      },
      80,
    )[0],
  ).toBe("model ?/high · 1 peer · ⅉ qvtszkkm* · ctx ?");
});

test("OMP widget renders unknown mail state without synthetic zeroes", () => {
  expect(
    renderResidualWidget(
      {
        address: "Innovative Dandelion",
        push: "online",
      },
      80,
    )[1],
  ).toContain("Innovative Dandelion · ✉️ ? · ⚙️ ?");
});

test("OMP widget uses the gitsync Git icon", () => {
  expect(
    renderResidualWidget(
      {
        git: "feature/status*",
        push: "connecting",
      },
      80,
    )[0],
  ).toContain("⎇ feature/status*");
});

test("OMP widget colors dirty and API-billed signals as warnings", () => {
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };
  const lines = renderStyledResidualWidget(
    {
      billing: {
        mode: "api",
        cost: 1.25,
        costPerHour: 2.5,
        totalTokens: 12_400,
      },
      effort: "high",
      jj: "main*",
      mail: {
        name: "Evergreen Cake",
        peers: 1,
        unread: 0,
        unprocessed: 0,
      },
      peers: 1,
      push: "online",
    },
    100,
    theme,
  );
  expect(lines[0]).toContain("<warning>ⅉ main*</warning>");
  expect(lines[1]).toContain("<error>API $1.25 · $2.50/h · 12k tok</error>");
});

test("OMP weekly usage accepts exactly one active-provider weekly bucket", () => {
  const weekly = {
    id: "secondary",
    window: { durationMs: 7 * 24 * 60 * 60_000 },
    amount: { unit: "percent", usedFraction: 0.37 },
  };
  expect(
    weeklyUsageForProvider(
      [
        { provider: "anthropic", limits: [weekly] },
        { provider: "openai-codex", limits: [weekly] },
      ],
      "openai-codex",
    ),
  ).toBe(37);
  expect(
    weeklyUsageForProvider(
      [
        { provider: "openai-codex", limits: [weekly] },
        { provider: "openai-codex", limits: [weekly] },
      ],
      "openai-codex",
    ),
  ).toBeUndefined();
});

test("OMP weekly usage prefers a provider-wide bucket over a model tier", () => {
  expect(
    weeklyUsageForProvider(
      [
        {
          provider: "openai-codex",
          limits: [
            {
              id: "openai-codex:primary",
              scope: { provider: "openai-codex", windowId: "7d" },
              window: { durationMs: 7 * 24 * 60 * 60_000 },
              amount: { unit: "percent", usedFraction: 0.16 },
            },
            {
              id: "openai-codex:spark:secondary",
              scope: {
                provider: "openai-codex",
                modelId: "GPT-5.3-Codex-Spark",
                tier: "spark",
                windowId: "7d",
              },
              window: { durationMs: 7 * 24 * 60 * 60_000 },
              amount: { unit: "percent", usedFraction: 0 },
            },
          ],
        },
      ],
      "openai-codex",
    ),
  ).toBe(16);
});
