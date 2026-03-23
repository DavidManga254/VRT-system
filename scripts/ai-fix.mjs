/**
 * ai-fix.mjs
 *
 * Reads Playwright failure results, then uses Claude Code CLI
 * to fix each failing component. Claude Code reads the pencil.dev
 * design directly via its MCP connection to get the correct spec.
 *
 * Requirements:
 *   - Claude Code installed and authenticated
 *   - pencil MCP server active (claude --print "list your active MCP servers")
 *   - REPO1_PATH env var pointing to your Vite+ app
 *
 * Usage:
 *   REPO1_PATH=../your-app node scripts/ai-fix.mjs
 *
 * Or add to .env:
 *   REPO1_PATH=../your-app
 *   node --env-file=.env scripts/ai-fix.mjs
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_PATH = path.join(ROOT, "reports/results.json");
const FIXES_LOG_PATH = path.join(ROOT, "reports/ai-fixes.json");

// Check Claude Code is installed and pencil MCP is active

try {
  execSync("claude --version", { stdio: "pipe" });
} catch {
  console.error("\n✗ Claude Code is not installed or not in PATH.");
  console.error("  Install it from: https://claude.ai/code");
  console.error("  Then authenticate: claude login\n");
  process.exit(1);
}

// Verify pencil MCP is active
const mcpCheck = spawnSync(
  "claude",
  ["--print", "list your active MCP servers"],
  { encoding: "utf-8" },
);

if (!mcpCheck.stdout?.toLowerCase().includes("pencil")) {
  console.error("\n✗ pencil MCP server is not active in Claude Code.");
  console.error(
    "  Make sure pencil.dev is running and connected to Claude Code.",
  );
  console.error(
    '  You can verify by running: claude --print "list your active MCP servers"\n',
  );
  process.exit(1);
}

console.log("✓ pencil MCP server is active\n");

// Validate environment

const REPO1_PATH = process.env.REPO1_PATH;

if (!REPO1_PATH) {
  console.error("\n✗ REPO1_PATH is not set.");
  console.error("  Example: REPO1_PATH=../my-app node scripts/ai-fix.mjs\n");
  process.exit(1);
}

const REPO1_ABS = path.resolve(ROOT, REPO1_PATH);

if (!fs.existsSync(REPO1_ABS)) {
  console.error(`\n✗ REPO1_PATH does not exist: ${REPO1_ABS}\n`);
  process.exit(1);
}

// Load Playwright results

if (!fs.existsSync(RESULTS_PATH)) {
  console.error(
    "\n✗ reports/results.json not found. Run playwright test first.\n",
  );
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));

//  Collect failures

const failures = [];

function collectSpecs(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status !== "unexpected") continue;
      const attachments = test.results?.[0]?.attachments ?? [];
      const diffPath =
        attachments.find((a) => a.name?.includes("diff"))?.path ?? null;
      const actualPath =
        attachments.find((a) => a.name?.includes("actual"))?.path ?? null;
      const expectedPath =
        attachments.find((a) => a.name?.includes("expected"))?.path ?? null;

      const errorMessage = test.results?.[0]?.error?.message ?? "Unknown error";

      failures.push({
        title: spec.title ?? "",
        error: errorMessage,
        diffPath,
        actualPath,
        expectedPath,
      });
    }
  }
  for (const child of suite.suites ?? []) {
    collectSpecs(child);
  }
}

for (const suite of results.suites ?? []) {
  collectSpecs(suite);
}

if (failures.length === 0) {
  console.log("\n✓ No failures found. Nothing to fix.\n");
  process.exit(0);
}

console.log(`AI Fix Agent — ${failures.length} failure(s) found\n`);

// Helpers

// Find source files for a component in Repo 1
function findSourceFiles(componentHint) {
  const srcDir = path.join(REPO1_ABS, "src");
  if (!fs.existsSync(srcDir)) return [];

  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        /\.(tsx?|css|scss)$/.test(entry.name) &&
        !entry.name.includes(".stories.") &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.")
      ) {
        // Put files matching the component name first
        if (entry.name.toLowerCase().includes(componentHint.toLowerCase())) {
          files.unshift(full);
        } else {
          files.push(full);
        }
      }
    }
  }

  walk(srcDir);
  return files.slice(0, 5);
}

// Call Claude Code CLI

function callClaudeCode(prompt, filePaths = []) {
  const result = spawnSync(
    "claude",
    [
      "--print",
      "--output-format",
      "json",
      ...filePaths.flatMap((f) => ["--file", f]),
    ],
    {
      input: prompt,
      cwd: REPO1_ABS,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || `Claude Code exited with code ${result.status}`,
    );
  }

  // Claude Code --output-format json wraps response in a "result" field
  try {
    const wrapper = JSON.parse(result.stdout.trim());
    const text = wrapper.result ?? wrapper.content ?? result.stdout;
    return text
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  } catch {
    return result.stdout
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
}

//  Apply patch to source file ─

function applyPatch(patch) {
  const absPath = path.join(REPO1_ABS, patch.filePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const content = fs.readFileSync(absPath, "utf-8");
  const count = content.split(patch.oldContent).length - 1;

  if (count === 0) throw new Error(`oldContent not found in ${patch.filePath}`);
  if (count > 1)
    throw new Error(
      `oldContent is ambiguous (${count} matches) — add more surrounding lines`,
    );

  fs.writeFileSync(`${absPath}.bak`, content);
  fs.writeFileSync(
    absPath,
    content.replace(patch.oldContent, patch.newContent),
  );
}

// Process each failure
const seen = new Set();
const uniqueFailures = failures.filter((f) => {
  if (seen.has(f.title)) return false;
  seen.add(f.title);
  return true;
});

const fixLog = [];

for (const failure of uniqueFailures) {
  console.log(`Processing: "${failure.title}"`);

  // Guess component name from test title
  const componentHint =
    failure.title
      .split(/[/\\>]/)
      .pop()
      ?.trim() ?? "";
  const sourceFiles = findSourceFiles(componentHint);

  if (sourceFiles.length === 0) {
    console.warn(
      `  ⚠  No source files found for "${componentHint}" in ${REPO1_ABS}`,
    );
    fixLog.push({
      title: failure.title,
      status: "skipped",
      reason: "no source files found",
    });
    continue;
  }

  // Include diff image so Claude can see exactly what pixels are wrong
  const allFiles = [...sourceFiles];
  if (failure.diffPath && fs.existsSync(failure.diffPath))
    allFiles.push(failure.diffPath);
  if (failure.actualPath && fs.existsSync(failure.actualPath))
    allFiles.push(failure.actualPath);
  if (failure.expectedPath && fs.existsSync(failure.expectedPath))
    allFiles.push(failure.expectedPath);

  const imageContext = [
    failure.expectedPath
      ? "- expected.png = the pencil.dev design (source of truth)"
      : "",
    failure.actualPath
      ? "- actual.png = current broken component screenshot"
      : "",
    failure.diffPath
      ? "- diff.png = highlighted pixel differences between them"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are an automated visual regression fix agent.

A Playwright visual regression test FAILED for component: "${failure.title}"
Error: ${failure.error}

${
  failure.diffPath
    ? "The diff image is attached — highlighted areas show where the component diverges from the baseline."
    : "No diff image available."
}

The following images are attached:
${imageContext}

Use expected.png as the design reference — that is exactly what the component must look like.

## Your task

You have access to the pencil MCP server which contains the original design.
Use it to read the design spec for the "${componentHint}" component — check its exact:
- colours
- spacing and padding
- font sizes and weights
- border radius
- dimensions

The attached source files are the current component implementation.
Find the minimal CSS or TSX change that makes the component exactly match the pencil.dev design.

Respond ONLY with this JSON — no explanation, no markdown fences, no other text:

{
  "diagnosis": "one sentence describing the exact discrepancy",
  "confidence": "high | medium | low",
  "patches": [
    {
      "filePath": "path/relative/to/repo/root.css",
      "oldContent": "exact string to find — must appear exactly once in the file",
      "newContent": "replacement string"
    }
  ]
}

Rules:
- filePath is relative to the project root (${REPO1_ABS})
- oldContent must be unique in the file — include surrounding lines if needed
- Change as little as possible — do not reformat unrelated code
- The pencil.dev design is always the source of truth`;

  let parsed;
  try {
    console.log(`  Calling Claude Code (reading pencil.dev via MCP)...`);
    const raw = callClaudeCode(prompt, allFiles);
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    fixLog.push({ title: failure.title, status: "error", error: err.message });
    continue;
  }

  console.log(`  Diagnosis (${parsed.confidence}): ${parsed.diagnosis}`);

  let patchedCount = 0;
  for (const patch of parsed.patches ?? []) {
    try {
      applyPatch(patch);
      console.log(`  ✓ Patched: ${patch.filePath}`);
      patchedCount++;
    } catch (err) {
      console.error(`  ✗ Patch failed (${patch.filePath}): ${err.message}`);
    }
  }

  fixLog.push({
    title: failure.title,
    status: patchedCount > 0 ? "patched" : "no-patches-applied",
    diagnosis: parsed.diagnosis,
    confidence: parsed.confidence,
    patchesApplied: patchedCount,
    patches: parsed.patches ?? [],
  });

  console.log();
}

//  Save fix log

fs.mkdirSync(path.dirname(FIXES_LOG_PATH), { recursive: true });
fs.writeFileSync(FIXES_LOG_PATH, JSON.stringify(fixLog, null, 2));

const patched = fixLog.filter((f) => f.status === "patched").length;
const failed = fixLog.filter((f) => f.status !== "patched").length;

console.log("─".repeat(50));
console.log(`Done: ${patched} fixed, ${failed} skipped/failed`);
console.log(`Fix log → reports/ai-fixes.json`);

if (patched > 0) {
  console.log("\nNext: run npx playwright test to verify the fixes.\n");
}
