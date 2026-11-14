#!/usr/bin/env node
// CLI entry point. Commands: search, read, index, status, repos, eval, mcp.
import { parseArgs } from "node:util";
import { KnowledgeBase } from "../src/kb.js";
import { formatResults } from "../src/mcp.js";
import { readRegistry, resolveRepo } from "../src/repo.js";
import { runEval } from "../src/eval.js";

const HELP = `repo-kb - local per-repo knowledge base (keyword + local embeddings) over Markdown docs

Usage:
  repo-kb search "<question>" [--top 5] [--prefix docs/x/] [--keyword] [--json]
  repo-kb read <path> [--heading "<text>" | --line <n>]
  repo-kb index [--full] [--no-embed]     Build or update the index (embeddings included)
  repo-kb status                          Show the selected repo and index size
  repo-kb repos                           List repos with an index on this machine
  repo-kb eval <questions.json> [--wkb <name>] [--keyword] [--json]
  repo-kb mcp [--no-embed]                Start the MCP server (stdio)

Common options:
  --repo <owner/repo | path>   Select a repo (default: the git repo of the current folder)
  --no-embed                   Keyword search only (no embedding model)

Index data: %LOCALAPPDATA%\\repo-kb (Windows) or ~/.cache/repo-kb; override with REPO_KB_HOME.`;

const { values: o, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    top: { type: "string" },
    prefix: { type: "string" },
    heading: { type: "string" },
    line: { type: "string" },
    keyword: { type: "boolean" },
    json: { type: "boolean" },
    full: { type: "boolean" },
    "no-embed": { type: "boolean" },
    wkb: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = pos[0];
const embed = !o["no-embed"] && !o.keyword && process.env.REPO_KB_EMBED !== "0";

function progress(label) {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - last > 1000 || done === total) {
      last = now;
      process.stderr.write(`\r${label} ${done}/${total}   `);
      if (done === total) process.stderr.write("\n");
    }
  };
}

async function open() {
  const kb = new KnowledgeBase(resolveRepo(o.repo), { embed, log: (m) => process.stderr.write(`${m}\n`) });
  const stats = kb.refresh({ force: !!o.full });
  return { kb, stats };
}

async function main() {
  if (!cmd || o.help || cmd === "help") return console.log(HELP);
  switch (cmd) {
    case "mcp": {
      const { runMcp } = await import("../src/mcp.js");
      return runMcp({ embed });
    }
    case "search": {
      const q = pos.slice(1).join(" ");
      if (!q) throw new Error('Missing question: repo-kb search "<question>"');
      const { kb } = await open();
      if (embed) await kb.ensureEmbeddings({ wait: true, onProgress: progress("embedding") });
      const r = await kb.search(q, { top: Number(o.top) || 5, pathPrefix: o.prefix, mode: o.keyword ? "keyword" : "auto" });
      return console.log(o.json ? JSON.stringify(r, null, 2) : formatResults(r));
    }
    case "read": {
      if (!pos[1]) throw new Error("Missing path: repo-kb read <path>");
      const kb = new KnowledgeBase(resolveRepo(o.repo), { embed: false });
      const s = kb.readSection(pos[1], { heading: o.heading, line: o.line ? Number(o.line) : undefined });
      return console.log(`${s.path}:${s.line}-${s.endLine}${s.truncated ? " (truncated)" : ""}\n\n${s.text}`);
    }
    case "index": {
      const t0 = Date.now();
      const { kb, stats } = await open();
      console.log(`${kb.repo.slug}: ${stats.total} files (+${stats.added} ~${stats.changed} -${stats.removed}), ${kb.chunks.length} chunks`);
      if (embed) {
        const ok = await kb.ensureEmbeddings({ wait: true, onProgress: progress("embedding") });
        if (!ok && kb.embedError) console.log(`embeddings off: ${kb.embedError.message}`);
        if (o.full && kb.cache) kb.cache.save(new Set(kb.chunks.map((c) => kb.keyOf(c))));
      }
      console.log(JSON.stringify(kb.status(), null, 2));
      return console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    case "status": {
      const { kb } = await open();
      if (embed) await kb.initCache();
      return console.log(JSON.stringify(kb.status(), null, 2));
    }
    case "repos":
      return console.log(JSON.stringify(readRegistry(), null, 2));
    case "eval": {
      if (!pos[1]) throw new Error("Missing file: repo-kb eval <questions.json>");
      const { kb } = await open();
      if (embed) await kb.ensureEmbeddings({ wait: true, onProgress: progress("embedding") });
      return runEval(kb, pos[1], { wkb: o.wkb, keyword: !!o.keyword, json: !!o.json });
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run repo-kb --help.`);
  }
}

main().catch((e) => {
  console.error(`repo-kb: ${e.message}`);
  process.exit(1);
});
