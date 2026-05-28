import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SELF = path.resolve(__filename);
const SRC_DIR = path.resolve(path.dirname(SELF), "..", "..", "..", "..", "src");

const EXCLUDED = new Set([SELF]);
const SUPABASE_IMPORT_RE = /from\s+['"]@supabase\//;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("guardrail: no @supabase imports in app source", () => {
  it("packages/app/src contains zero `from '@supabase/...'` lines", () => {
    const files = walk(SRC_DIR);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (EXCLUDED.has(path.resolve(file))) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (SUPABASE_IMPORT_RE.test(line)) {
          offenders.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
