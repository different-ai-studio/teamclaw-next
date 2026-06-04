import { describe, expect, it } from "vitest";
import {
  matchesSkillTool,
  resolveWireToolName,
} from "../tool-call-utils";

describe("resolveWireToolName", () => {
  it("maps execute kind to bash", () => {
    expect(resolveWireToolName("execute", "other", { command: "ls" })).toBe("bash");
  });

  it("maps ACP other + skill title to skill route", () => {
    expect(
      resolveWireToolName("other", "other", {
        name: "brainstorming",
        description: "skill",
      }),
    ).toBe("skill");
  });

  it("keeps explicit skill wire name", () => {
    expect(resolveWireToolName(undefined, "skill", { name: "demo" })).toBe("skill");
  });
});

describe("matchesSkillTool", () => {
  it("recognizes daemon other wire rows for skill invocations", () => {
    expect(
      matchesSkillTool({
        name: "other",
        toolKind: "other",
        arguments: { name: "session-distiller", description: "skill" },
      }),
    ).toBe(true);
  });
});
