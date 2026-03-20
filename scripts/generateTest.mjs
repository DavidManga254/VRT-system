#!/usr/bin/env node
/**
 * generate-tests.mjs
 *
 * Fetches stories.json from Storybook and generates
 * tests/visual/stories.spec.ts automatically.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "tests/visual/stories.spec.ts");
const STORYBOOK_URL = process.env.STORYBOOK_URL ?? "http://localhost:6006";

console.log(`\nFetching stories from ${STORYBOOK_URL}/stories.json ...`);

let stories;

try {
  const res = await fetch(`${STORYBOOK_URL}/index.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  stories = json.stories ?? json.entries ?? {};
} catch (err) {
  console.error(`\n Could not reach Storybook at ${STORYBOOK_URL}`);
  console.error("  Make sure Storybook is running before generating tests.");
  console.error(`  Error: ${err.message}\n`);
  process.exit(1);
}

//Parse and filter
const allEntries = Object.values(stories);

const storyEntries = allEntries.filter(
  (entry) => entry.type === "story" || entry.type === undefined,
);

if (storyEntries.length === 0) {
  console.error("✗ No stories found. Check your Storybook setup.");
  process.exit(1);
}

// Group by component title
const groups = storyEntries.reduce((acc, story) => {
  const title = story.title ?? story.kind ?? "Unknown";
  if (!acc[title]) acc[title] = [];
  acc[title].push(story);
  return acc;
}, {});

//Sanitise names for use as filenames
function sanitise(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Build the file content
const componentCount = Object.keys(groups).length;
const storyCount = storyEntries.length;

const blocks = Object.entries(groups)
  .map(([title, stories]) => {
    const tests = stories
      .map((story) => {
        const snapshotName = sanitise(story.id);
        return `
  test('${story.name}', async ({ page }) => {
    await page.goto(storyUrl('${story.id}'))
    await waitForStory(page)
    await expect(page).toHaveScreenshot('${snapshotName}.png')
  })`;
      })
      .join("\n");

    return `
test.describe('${title}', () => {${tests}
})`;
  })
  .join("\n");

const fileContent = `/**
 * stories.spec.ts
 *
 * AUTO-GENERATED — do not edit by hand.
 * Re-generate by running: node scripts/generate-tests.mjs
 *
 * Generated: ${new Date().toISOString()}
 * Components: ${componentCount}
 * Stories:    ${storyCount}
 */

import { test, expect, Page } from '@playwright/test'

//Helpers

async function waitForStory(page: Page) {
  // Wait for the Storybook canvas to mount
  await page.waitForSelector('#storybook-root', { state: 'visible' })
  // Wait for any async data / fonts to settle
  await page.waitForLoadState('networkidle')
  // Small buffer for CSS transitions to finish
  await page.waitForTimeout(300)
}

function storyUrl(id: string) {
  return \`/iframe.html?id=\${id}&viewMode=story\`
}

// Auto-generated test
${blocks}
`;

//save
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, fileContent, "utf-8");

console.log(`✓ Generated ${OUTPUT}`);
console.log(
  `  ${componentCount} component(s), ${storyCount} story/stories found\n`,
);
