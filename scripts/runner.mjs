/**
 * runner.mjs
 *
 * Chains the full VRT pipeline into a single command:
 *
 *   1. Generate tests from Storybook stories
 *   2. Run Playwright tests
 *   3. If failures → run AI fix agent
 *   4. Re-run Playwright to verify fixes
 *
 * Usage:
 *   REPO1_PATH=../your-app node scripts/runner.mjs
 *
 * Flags:
 *   --update-baselines   Re-run with --update-snapshots (sets new baselines)
 *   --skip-generate      Skip the generate step (use existing stories.spec.ts)
 *   --skip-fix           Run tests only, do not attempt AI fixes
 */

import { spawnSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_PATH = path.join(ROOT, "reports/results.json");

const args = process.argv.slice(2);
const UPDATE_BASELINES = args.includes("--update-baselines");
const SKIP_GENERATE = args.includes("--skip-generate");
const SKIP_FIX = args.includes("--skip-fix");

//  Colours

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function log(symbol, color, msg) {
  console.log(`${color}${symbol}${c.reset} ${msg}`);
}

function step(msg) {
  log("\n▶", c.cyan, `${c.bold}${msg}${c.reset}`);
}
function ok(msg) {
  log("✓", c.green, msg);
}
function fail(msg) {
  log("✗", c.red, msg);
}
function warn(msg) {
  log("⚠", c.yellow, msg);
}
function divider() {
  console.log("─".repeat(55));
}

//  Run a child process and return its exit code

function run(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf-8",
    ...options,
  });
  return result.status ?? 1;
}

//  Count failures from results.json ─

function countFailures() {
  if (!fs.existsSync(RESULTS_PATH)) return 0;
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  return results.stats?.unexpected ?? 0;
}
//  Pipeline

divider();
console.log(`${c.bold}VRT Runner${c.reset}`);
divider();

//  Generate tests ─

if (!SKIP_GENERATE) {
  step("Step 1 — Generating tests from Storybook");
  const code = run("node", ["scripts/generateTest.mjs"]);
  if (code !== 0) {
    fail("Test generation failed. Is Storybook running?");
    process.exit(1);
  }
} else {
  warn("Skipping test generation (--skip-generate)");
}

const specStat = fs.statSync(path.join(ROOT, "tests/visual/stories.spec.ts"));
console.log(`stories.spec.ts last modified: ${specStat.mtime}`);
console.log(`stories.spec.ts size: ${specStat.size} bytes`);

const snapshotDir = path.join(ROOT, "tests/snapshots");
console.log("\nBaselines currently in snapshots:");
function listFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full);
    else console.log(" ", path.relative(ROOT, full));
  }
}
listFiles(snapshotDir);
console.log();

// Delete stale results before running so we always read fresh results
if (fs.existsSync(RESULTS_PATH)) {
  fs.unlinkSync(RESULTS_PATH);
  console.log("  Cleared stale results.json");
}

//Run Playwright ─

step("Step 2 — Running Playwright VRT tests");

const playwrightArgs = ["playwright", "test"];
if (UPDATE_BASELINES) {
  playwrightArgs.push("--update-snapshots");
  warn("Updating baselines (--update-baselines)");
}

let playwrightCode = 0;
try {
  execSync(
    `npx playwright test${UPDATE_BASELINES ? " --update-snapshots" : ""}`,
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
} catch (err) {
  playwrightCode = err.status ?? 1;
}

const failureCount = countFailures();
console.log(
  `  Exit code: ${playwrightCode}, Failures in results.json: ${failureCount}`,
);

if (UPDATE_BASELINES) {
  ok("Baselines updated successfully");
  console.log("\nNew baselines saved to tests/snapshots/");
  console.log(
    "Run npm run vrt:run again without --update-baselines to test against them.\n",
  );
  process.exit(0);
}

if (failureCount === 0 && playwrightCode === 0) {
  ok(`All tests passed`);
  divider();
  console.log(
    `\n${c.green}${c.bold}Everything looks good. No fixes needed.${c.reset}\n`,
  );
  process.exit(0);
}

// AI Fix

warn(`${failureCount} test(s) failed`);

if (SKIP_FIX) {
  warn("Skipping AI fix (--skip-fix)");
  console.log("\nRun npm run vrt:report to view the failures.\n");
  process.exit(1);
}

step("Step 3 — Running AI Fix Agent");

if (!process.env.REPO1_PATH) {
  fail("REPO1_PATH is not set — AI fix agent cannot run without it.");
  console.error("  Set it in .env or prefix the command:");
  console.error("  REPO1_PATH=../your-app npm run vrt:run\n");
  process.exit(1);
}

const fixCode = run("node", ["scripts/ai-fix.mjs"]);

if (fixCode !== 0) {
  fail("AI Fix Agent encountered an error. Check the output above.");
  process.exit(1);
}

// Re-run Playwright to verify fixes

step("Step 4 — Verifying fixes");

let verifyCode = 0;
try {
  execSync("npx playwright test", {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (err) {
  verifyCode = err.status ?? 1;
}

const remainingFailures = countFailures();

divider();

if (remainingFailures === 0 && verifyCode === 0) {
  ok(`All ${failureCount} failure(s) fixed and verified`);
  console.log(
    `\n${c.green}${c.bold}Pipeline complete. All tests passing.${c.reset}\n`,
  );
  process.exit(0);
} else {
  fail(`${remainingFailures} test(s) still failing after AI fix`);
  warn("Some fixes may need manual review.");
  console.log("\nRun npm run vrt:report to inspect the remaining failures.\n");
  process.exit(1);
}
