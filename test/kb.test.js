import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chunkMarkdown } from "../src/chunk.js";
import { globToRegex } from "../src/config.js";
import { wikiKey } from "../src/eval.js";
import { KnowledgeBase } from "../src/kb.js";
import { slugFromRemote } from "../src/repo.js";

test("chunks by heading, keeps the trail, ignores headings in code fences", () => {
  const md = "# Title\nintro\n## A\ntext a\n```\n# not a heading\n```\n### A1\ndeep\n## B\ntext b\n";
  const { title, chunks } = chunkMarkdown(md);
  assert.equal(title, "Title");
  assert.deepEqual(chunks.map((c) => c.heading), ["Title", "Title > A", "Title > A > A1", "Title > B"]);
  assert.equal(chunks[1].line, 3);
  assert.equal(chunks[3].anchor, "b");
});

test("globs and remotes", () => {
  assert.ok(globToRegex("docs/**/*.md").test("docs/a/b/c.md"));
  assert.ok(globToRegex("docs/**/*.md").test("docs/c.md"));
  assert.ok(!globToRegex("docs/**/*.md").test("src/docs/c.md"));
  assert.equal(slugFromRemote("git@github.com:owner/name.git"), "owner/name");
  assert.equal(slugFromRemote("https://github.com/owner/name"), "owner/name");
  assert.equal(wikiKey("docs/internal/setup/README.md"), "internalsetup");
  assert.equal(wikiKey("docs/README.md"), "home");
});

test("indexes incrementally and finds the right section", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rkb-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rkb-home-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "saves.md"), "# Saves\n## Unknown items\nLoading skips removed items.\n");
  fs.writeFileSync(path.join(root, "docs", "art.md"), "# Art\n## Palette\nColours.\n");
  const repo = { slug: "t/t", root, isGit: false, dir: home, treeDir: path.join(home, "tree") };
  const kb = new KnowledgeBase(repo, { embed: false });
  assert.equal(kb.refresh().added, 2);
  assert.equal(kb.refresh({}).added, 0);
  const r = await kb.search("what happens to removed items when loading");
  assert.equal(r.results[0].path, "docs/saves.md");
  assert.equal(r.results[0].sections[0].heading, "Saves > Unknown items");
  fs.writeFileSync(path.join(root, "docs", "art.md"), "# Art\n## Palette\nColours and removed hues.\n# Extra\n");
  const s = kb.refresh();
  assert.equal(s.changed, 1);
  assert.equal(kb.readSection("docs/saves.md", { heading: "unknown-items" }).text.trim(), "## Unknown items\nLoading skips removed items.");
});
