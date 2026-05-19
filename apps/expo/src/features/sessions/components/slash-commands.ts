export type SlashCommand = {
  name: string;
  description: string;
};

/**
 * Static command roster. Mirrors the seed list defined in iOS
 * `SessionComposer.swift` so the popup behaviour matches between
 * platforms while the real `slash_commands` registry lands later.
 */
export const SLASH_COMMANDS: ReadonlySet<SlashCommand> = new Set([
  { name: "ask", description: "Send a one-shot message without engaging an agent loop." },
  { name: "clear", description: "Clear the composer draft." },
  { name: "compact", description: "Compact older messages into a single recap." },
  { name: "explain", description: "Ask the bound agent to explain the prior reply." },
  { name: "fix", description: "Have the bound agent fix the issue surfaced in the last message." },
  { name: "model", description: "Switch the bound agent's model for the next turn." },
  { name: "review", description: "Request a code review from the bound agent." },
  { name: "test", description: "Run the project's test suite via the bound agent." },
  { name: "todo", description: "Update the session's todo list." },
]);

/**
 * Returns the slash-prefix being typed at the head of `composerText`,
 * or `null` if the cursor doesn't belong to a slash query. Mirrors the
 * iOS `slashPrefix` computed property — only matches when the message
 * starts with `/` and the remainder is `[a-zA-Z0-9_-]*`.
 */
export function slashPrefix(composerText: string): string | null {
  const first = composerText.charAt(0);
  if (first !== "/") return null;
  const rest = composerText.slice(1);
  if (!/^[a-zA-Z0-9_-]*$/.test(rest)) return null;
  return rest;
}

export function filterSlashCommands(
  commands: ReadonlySet<SlashCommand>,
  prefix: string,
): SlashCommand[] {
  const needle = prefix.toLowerCase();
  return [...commands]
    .filter((cmd) => cmd.name.startsWith(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
}
