/**
 * sync-pencil.mjs
 *
 * Uses Claude Code + pencil MCP to:
 *   1. Get the currently open .pen file path
 *   2. List all top-level nodes
 *   3. Match them to Storybook story IDs by name
 *   4. Export matched nodes as PNGs into tests/snapshots/
 *
 * These exported PNGs become the VRT baselines — meaning
 * Playwright compares Storybook screenshots against the
 * actual pencil.dev design, not a previous Storybook screenshot.
 *
 * Requirements:
 *   - Claude Code installed and authenticated
 *   - pencil MCP active (pencil.dev must be open)
 *   - Storybook running at localhost:6006
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORIES_URL = process.env.STORYBOOK_URL ?? "http://localhost:6006";
console.log("here it is", process.env.STORYBOOK_URL);
const SNAPSHOTS = path.join(ROOT, "tests/snapshots/stories.spec.ts");
const PROJECTS = ["desktop", "mobile"];

// Colours

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const fail = (m) => console.error(`${c.red}✗${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`);
const step = (m) =>
  console.log(`\n${c.cyan}▶${c.reset} ${c.bold}${m}${c.reset}`);

//Check Claude Code and pencil MCP

try {
  execSync("claude --version", { stdio: "pipe" });
} catch {
  fail("Claude Code is not installed or not in PATH.");
  fail("Install from: https://claude.ai/code then run: claude login");
  process.exit(1);
}

const mcpCheck = spawnSync(
  "claude",
  ["--print", "list your active MCP servers"],
  {
    encoding: "utf-8",
  },
);

if (!mcpCheck.stdout?.toLowerCase().includes("pencil")) {
  fail("pencil MCP server is not active.");
  fail("Make sure pencil.dev is open and connected to Claude Code.");
  process.exit(1);
}

ok("pencil MCP is active");

//  2. Fetch story IDs from Storybook

step("Fetching stories from Storybook");

let storyEntries;
try {
  const res = await fetch(`${STORIES_URL}/index.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const all = Object.values(json.stories ?? json.entries ?? {});
  storyEntries = all.filter((e) => e.type === "story" || e.type === undefined);
} catch (err) {
  fail(`Could not reach Storybook at ${STORIES_URL}: ${err.message}`);
  fail("Make sure Storybook is running before syncing.");
  process.exit(1);
}

ok(`Found ${storyEntries.length} stories`);

// Normalise names for matching ──

function normalise(str) {
  return str
    .toLowerCase()
    .replace(/^example-/, "")
    .replace(/--/g, "-")
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const storyMap = {};
for (const story of storyEntries) {
  const combined = `${story.title ?? ""}/${story.name ?? ""}`;
  storyMap[normalise(combined)] = story.id;
}

// Ask Claude Code to list all pencil nodes and export matches

step("Asking Claude Code to read pencil.dev nodes and export matches");

for (const project of PROJECTS) {
  fs.mkdirSync(path.join(SNAPSHOTS, project), { recursive: true });
}

const storyMapJson = JSON.stringify(storyMap, null, 2);

const storyIdList = JSON.stringify(
  storyEntries.map((s) => s.id),
  null,
  2,
);

const prompt = `You are a sync agent for a Visual Regression Testing system.

Your job is to export design nodes from pencil.dev as PNG baseline images.

## Step 1 — Get the open .pen file
Use the pencil MCP tool get_editor_state to find the currently open .pen file path.

## Step 2 — List all top-level nodes
Use batch_get with no nodeIds and no patterns to get all top-level nodes from that .pen file.
This returns the document's frames/components with their IDs and names.

## Step 3 — Match nodes to Storybook stories

Here is the list of Storybook story IDs:
${JSON.stringify(
  storyEntries.map((s) => s.id),
  null,
  2,
)}

For each pencil node:
- Normalise its name: lowercase, replace spaces with dashes, remove special chars
- Check if the normalised name appears as a SUBSTRING of any story ID
- Example: "Frame 74" normalises to "frame-74", which matches 
  "components-frame74--default" because "frame74" is contained within it
- One pencil node can match MULTIPLE stories (all states of that component)
- Record ALL matches for each node

## Step 4 — Export matched nodes
For each match, use export_nodes to export the node as a PNG to these two directories:
- ${path.join(SNAPSHOTS, "desktop")}
- ${path.join(SNAPSHOTS, "mobile")}

Use scale: 2 and format: "png".
After exporting, rename each file from its node ID filename to the story's snapshot filename.
The snapshot filename for a story is the story ID with all non-alphanumeric chars replaced by dashes.
Example: story ID "example-button--primary" → filename "example-button-primary.png"

## Step 5 — Return results
Respond ONLY with this JSON — no explanation, no markdown:

{
  "penFilePath": "path to the .pen file",
  "totalNodes": 0,
  "matched": [
  {
    "nodeName": "name in pencil",
    "nodeId": "the pencil node ID used as the exported filename",
    "storyId": "example-button--primary",
    "filename": "example-button-primary.png",
    "exported": true
  }
  ],
  "unmatched": [
    {
      "nodeName": "name in pencil that had no matching story"
    }
  ],
  "storiesWithNoNode": [
    "story-id-with-no-matching-pencil-node"
  ]
}`;

const result = spawnSync("claude", ["--print", "--output-format", "json"], {
  input: prompt,
  encoding: "utf-8",
  maxBuffer: 10 * 1024 * 1024,
});

if (result.status !== 0) {
  fail(`Claude Code failed: ${result.stderr?.trim()}`);
  process.exit(1);
}

// Parse response

let parsed;
try {
  const wrapper = JSON.parse(result.stdout.trim());
  const text = wrapper.result ?? wrapper.content ?? result.stdout;
  const jsonMatch =
    raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/);
  const clean = jsonMatch ? jsonMatch[1].trim() : raw.trim();
  parsed = JSON.parse(clean);
} catch (err) {
  fail(`Could not parse Claude Code response: ${err.message}`);
  console.error("Raw output:", result.stdout.slice(0, 500));
  process.exit(1);
}

// Summary

console.log();
console.log("─".repeat(55));
console.log(`${c.bold}Pencil Sync Summary${c.reset}`);
console.log("─".repeat(55));
console.log(`  Pen file   : ${parsed.penFilePath ?? "unknown"}`);
console.log(`  Total nodes: ${parsed.totalNodes ?? "?"}`);
console.log();

if (parsed.matched?.length > 0) {
  console.log("\nRenaming exported files...");

  for (const match of parsed.matched) {
    if (!match.nodeId) continue;

    for (const project of PROJECTS) {
      const dir = path.join(SNAPSHOTS, project);

      // find the file that was exported for this node
      // pencil names it using the node ID
      const files = fs.readdirSync(dir);
      const exported = files.find(
        (f) => f.includes(match.nodeId) || f === `${match.nodeId}.png`,
      );

      if (!exported) {
        warn(
          `  Could not find exported file for node ${match.nodeId} in ${project}`,
        );
        continue;
      }

      const oldPath = path.join(dir, exported);
      const newPath = path.join(dir, match.filename);

      fs.renameSync(oldPath, newPath);
      console.log(`  ✓ ${project}/${exported} → ${match.filename}`);
      match.exported = true;
    }
  }
}

if (parsed.matched?.length > 0) {
  ok(`${parsed.matched.length} node(s) matched and exported as baselines:`);
  for (const m of parsed.matched) {
    const status = m.exported
      ? `${c.green}exported${c.reset}`
      : `${c.yellow}skipped${c.reset}`;
    console.log(`    ${status}  ${m.nodeName} → ${m.filename}`);
  }
}

if (parsed.unmatched?.length > 0) {
  console.log();
  warn(
    `${parsed.unmatched.length} pencil node(s) had no matching Storybook story:`,
  );
  for (const u of parsed.unmatched) {
    console.log(`    - ${u.nodeName}`);
  }
}

if (parsed.storiesWithNoNode?.length > 0) {
  console.log();
  warn(
    `${parsed.storiesWithNoNode.length} Storybook story/stories had no matching pencil node:`,
  );
  for (const s of parsed.storiesWithNoNode) {
    console.log(`    - ${s}`);
  }
  console.log("  These stories will keep their existing baselines.");
}

console.log();

if (parsed.matched?.length > 0) {
  ok("Baselines updated from pencil.dev design");
  console.log(
    "  Next: run npm run vrt:run to compare Storybook against the design.\n",
  );
} else {
  warn(
    "No nodes were matched. Check that pencil.dev node names align with Storybook story names.",
  );
  console.log("  Node names in pencil should loosely match story titles, e.g:");
  console.log(
    '    pencil: "Button/Primary"  ↔  Storybook: "Example/Button > Primary"\n',
  );
}
