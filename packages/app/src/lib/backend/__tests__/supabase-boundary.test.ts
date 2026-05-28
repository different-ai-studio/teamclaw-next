import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "../..");
const appSrc = path.resolve(process.cwd(), "src");
const daemonSrc = path.resolve(process.cwd(), "../../apps/daemon/src");
const desktopRustTargets = [
  path.resolve(repoRoot, "apps/desktop/src"),
  path.resolve(repoRoot, "apps/desktop/crates"),
  path.resolve(repoRoot, "apps/desktop/tauri-plugin-mcp-local/src"),
  path.resolve(repoRoot, "apps/desktop/build.rs"),
  path.resolve(repoRoot, "apps/desktop/tauri-plugin-mcp-local/build.rs"),
];

const appAllowed = [
  "lib/supabase-client.ts",
  "lib/backend/supabase/",
  "lib/backend/__tests__/",
  "components/auth/DesktopOnboarding.tsx",
  "lib/server-config.ts",
];

const daemonSupabaseAdapterAllowed = ["supabase/"];
const daemonProviderTypeAllowed = [
  "backend/error.rs",
  "onboarding/init.rs",
  "onboarding/invite_url.rs",
  "main.rs",
];

const appSupabaseClientPath = path.resolve(appSrc, "lib/supabase-client");
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, suffixes: string[]): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, suffixes);
    return suffixes.some((suffix) => full.endsWith(suffix)) ? [full] : [];
  });
}

function rustFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return walk(target, [".rs"]);
  return target.endsWith(".rs") ? [target] : [];
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function stripTsExtension(file: string): string {
  return file.replace(/\.(tsx?|jsx?)$/, "");
}

function stripSpecifierQuery(specifier: string): string {
  return specifier.split(/[?#]/, 1)[0];
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(importSpecifierPattern)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function importsRawSupabaseClient(file: string): boolean {
  const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));

  return specifiers.some((rawSpecifier) => {
    const specifier = stripSpecifierQuery(rawSpecifier);
    const normalizedSpecifier = stripTsExtension(specifier);

    if (
      normalizedSpecifier === "@/lib/supabase-client" ||
      normalizedSpecifier === "@supabase/supabase-js" ||
      normalizedSpecifier.startsWith("@supabase/supabase-js/")
    ) {
      return true;
    }

    if (!specifier.startsWith(".")) return false;

    const resolved = stripTsExtension(
      path.resolve(path.dirname(file), specifier),
    );
    return resolved === appSupabaseClientPath;
  });
}

function skipRustLineComment(text: string, index: number): number {
  const nextNewline = text.indexOf("\n", index + 2);
  return nextNewline === -1 ? text.length : nextNewline + 1;
}

function skipRustBlockComment(text: string, index: number): number {
  let depth = 1;
  index += 2;

  while (index < text.length && depth > 0) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }

  return index;
}

function skipRustQuoted(text: string, index: number, quote: '"' | "'"): number {
  index += 1;

  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
    } else if (text[index] === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }

  return index;
}

function skipRustRawString(text: string, index: number): number | null {
  let cursor = index;
  if (text[cursor] === "b") cursor += 1;
  if (text[cursor] !== "r") return null;

  cursor += 1;
  let hashes = 0;
  while (text[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }

  if (text[cursor] !== '"') return null;

  const terminator = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(terminator, cursor + 1);
  return end === -1 ? text.length : end + terminator.length;
}

function looksLikeRustCharLiteral(text: string, index: number): boolean {
  const next = text[index + 1];
  if (!next) return false;
  if (/[_A-Za-z]/.test(next)) return false;
  return true;
}

function skipRustIgnoredSyntax(text: string, index: number): number | null {
  if (text.startsWith("//", index)) return skipRustLineComment(text, index);
  if (text.startsWith("/*", index)) return skipRustBlockComment(text, index);

  const rawStringEnd = skipRustRawString(text, index);
  if (rawStringEnd !== null) return rawStringEnd;

  const quote = text[index];
  if (quote === '"') return skipRustQuoted(text, index, quote);
  if (quote === "'" && looksLikeRustCharLiteral(text, index)) {
    return skipRustQuoted(text, index, quote);
  }

  return null;
}

function matchingRustBraceIndex(text: string, openBraceIndex: number): number {
  let depth = 1;
  let index = openBraceIndex + 1;

  while (index < text.length && depth > 0) {
    const nextIndex = skipRustIgnoredSyntax(text, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    index += 1;
  }

  return index;
}

function findRustTestModule(
  text: string,
  fromIndex: number,
): RegExpExecArray | null {
  const testModulePattern =
    /#\[cfg\(test\)\]\s*mod\s+[_A-Za-z][_A-Za-z0-9]*\s*\{/y;
  let index = fromIndex;

  while (index < text.length) {
    const nextIndex = skipRustIgnoredSyntax(text, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    testModulePattern.lastIndex = index;
    const match = testModulePattern.exec(text);
    if (match) return match;

    index += 1;
  }

  return null;
}

function stripRustTestModules(text: string): string {
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = findRustTestModule(text, cursor)) !== null) {
    result += text.slice(cursor, match.index);
    const index = matchingRustBraceIndex(
      text,
      match.index + match[0].length - 1,
    );

    cursor = index;
  }

  return result + text.slice(cursor);
}

function readProductionRustText(file: string): string {
  return stripRustTestModules(fs.readFileSync(file, "utf8"));
}

function hasForbiddenDaemonSupabaseUse(file: string): boolean {
  const relativeFile = rel(daemonSrc, file);
  if (
    daemonSupabaseAdapterAllowed.some((allowed) =>
      relativeFile.startsWith(allowed),
    )
  ) {
    return false;
  }

  const text = readProductionRustText(file);
  if (text.includes("/rest/v1/")) return true;

  const providerTypesAllowed = daemonProviderTypeAllowed.some((allowed) =>
    relativeFile.startsWith(allowed),
  );

  return (
    !providerTypesAllowed &&
    (text.includes("SupabaseResult") || text.includes("SupabaseError"))
  );
}

describe("Supabase provider boundary", () => {
  it("keeps Desktop product code from importing the raw Supabase client", () => {
    const offenders = walk(appSrc, [".ts", ".tsx"])
      .filter((file) => !rel(appSrc, file).includes("__tests__/"))
      .filter((file) => !rel(appSrc, file).endsWith(".test.ts"))
      .filter((file) => !rel(appSrc, file).endsWith(".test.tsx"))
      .filter(
        (file) =>
          !appAllowed.some((allowed) => rel(appSrc, file).startsWith(allowed)),
      )
      .filter(importsRawSupabaseClient)
      .map((file) => rel(appSrc, file));

    expect(offenders).toEqual([]);
  });

  it("keeps daemon REST/RPC Supabase calls inside the Supabase adapter", () => {
    const offenders = walk(daemonSrc, [".rs"])
      .filter((file) => !rel(daemonSrc, file).includes("/tests/"))
      .filter(hasForbiddenDaemonSupabaseUse)
      .map((file) => rel(daemonSrc, file));

    expect(offenders).toEqual([]);
  });

  it("documents that Tauri Rust has no direct Supabase data writes", () => {
    const offenders = desktopRustTargets
      .flatMap(rustFiles)
      .filter((file) => {
        const text = readProductionRustText(file);
        return (
          text.includes("/rest/v1/") ||
          text.includes("SupabaseResult") ||
          text.includes("SupabaseError")
        );
      })
      .map((file) => rel(repoRoot, file));

    expect(offenders).toEqual([]);
  });
});
