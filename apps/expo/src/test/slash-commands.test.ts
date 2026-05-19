import { describe, expect, it } from "vitest";

describe("slashPrefix", () => {
  it("returns the prefix when the message starts with /", async () => {
    const { slashPrefix } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(slashPrefix("/")).toBe("");
    expect(slashPrefix("/ask")).toBe("ask");
    expect(slashPrefix("/com")).toBe("com");
  });

  it("returns null for non-slash queries", async () => {
    const { slashPrefix } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(slashPrefix("")).toBeNull();
    expect(slashPrefix("hello")).toBeNull();
    expect(slashPrefix("/ask something")).toBeNull();
    expect(slashPrefix("/has space")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns commands whose name starts with the prefix, sorted", async () => {
    const { filterSlashCommands, SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(SLASH_COMMANDS, "c").map((c) => c.name)).toEqual([
      "clear",
      "compact",
    ]);
  });

  it("is case-insensitive on the prefix", async () => {
    const { filterSlashCommands, SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(SLASH_COMMANDS, "AS").map((c) => c.name)).toEqual([
      "ask",
    ]);
  });

  it("returns the full set when prefix is empty", async () => {
    const { filterSlashCommands, SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(SLASH_COMMANDS, "").length).toBe(
      [...SLASH_COMMANDS].length,
    );
  });
});
