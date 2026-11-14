// Owns: the retrieval evaluation (hit@1, hit@3, hit@5, MRR, latency) for repo-kb and, optionally, WikiKB (`wkb`).
// Input: a JSON file [{ "q": "question", "expect": ["docs/path.md", ...] }]. A hit is any expected path in the top k files.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

// WikiKB page names flatten docs paths: docs/a/b/c.md -> a-b-c, docs/a/README.md -> a, docs/README.md -> Home.
export function wikiKey(docPath) {
  let p = docPath.replace(/\\/g, "/").replace(/^docs\//i, "").replace(/\.md$/i, "");
  p = p.replace(/(^|\/)README$/i, "");
  if (!p) p = "home";
  return p.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function norm(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function score(ranked, expect) {
  const want = new Set(expect.map(norm));
  const rank = ranked.findIndex((p) => want.has(norm(p)));
  return rank < 0 ? null : rank + 1;
}

async function wkbSearch(name, q, top) {
  const bin = process.env.WKB_BIN || "wkb";
  const wargs = [name, "search", q, "--top", String(top * 3)];
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", bin, ...wargs]] : [bin, wargs];
  const { stdout } = await run(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const pages = [];
  for (const m of stdout.matchAll(/^\s+(?:concepts|sources|queries)\/([^\s]+)\.md\s*$/gm)) {
    if (!pages.includes(m[1])) pages.push(m[1]);
  }
  return pages;
}

function summarize(name, rows) {
  const n = rows.length;
  const at = (k) => rows.filter((r) => r.rank && r.rank <= k).length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    system: name,
    questions: n,
    "hit@1": +(at(1) / n).toFixed(3),
    "hit@3": +(at(3) / n).toFixed(3),
    "hit@5": +(at(5) / n).toFixed(3),
    mrr: +(rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n).toFixed(3),
    p50_ms: ms[Math.floor(n / 2)],
    max_ms: ms[n - 1],
  };
}

export async function runEval(kb, file, { wkb, keyword = false, json = false, top = 5 } = {}) {
  const questions = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = [];
  for (const { q, expect } of questions) {
    const t0 = performance.now();
    const r = await kb.search(q, { top, mode: keyword ? "keyword" : "auto" });
    const ms = Math.round(performance.now() - t0);
    const paths = r.results.map((x) => x.path);
    rows.push({ q, expect, rank: score(paths, expect), ms, got: paths.slice(0, 3), mode: r.mode });
  }
  const report = { repoKb: summarize(`repo-kb (${rows[0]?.mode})`, rows), misses: rows.filter((r) => !r.rank || r.rank > 1) };

  if (wkb) {
    const byKey = new Map(Object.keys(kb.files).map((p) => [wikiKey(p), p]));
    const wrows = [];
    for (const { q, expect } of questions) {
      const t0 = performance.now();
      let pages = [];
      try {
        pages = await wkbSearch(wkb, q, top);
      } catch (e) {
        process.stderr.write(`wkb failed for "${q}": ${e.message}\n`);
      }
      const ms = Math.round(performance.now() - t0);
      const paths = pages.map((p) => byKey.get(p.toLowerCase().replace(/[^a-z0-9]+/g, "")) || `wiki:${p}`).slice(0, top);
      wrows.push({ q, expect, rank: score(paths, expect), ms, got: paths.slice(0, 3) });
      process.stderr.write(`\rwkb ${wrows.length}/${questions.length}   `);
    }
    process.stderr.write("\n");
    report.wkb = summarize("wkb search (process per query)", wrows);
    report.wkbMisses = wrows.filter((r) => !r.rank || r.rank > 1);
  }

  if (json) return console.log(JSON.stringify(report, null, 2));
  console.table([report.repoKb, report.wkb].filter(Boolean));
  const show = (label, misses) => {
    if (!misses?.length) return;
    console.log(`\n${label} not at rank 1:`);
    for (const m of misses) console.log(`- [${m.rank ?? "miss"}] ${m.q}\n    want ${m.expect[0]}\n    got  ${m.got.join(" | ")}`);
  };
  show("repo-kb", report.misses);
  show("wkb", report.wkbMisses);
}
