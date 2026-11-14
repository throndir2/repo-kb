// Owns: the stdio MCP server. One KnowledgeBase per repo is kept in memory and refreshed (cheaply) on each call.
// Repo selection per call: explicit "repo" argument > MCP client roots > REPO_KB_ROOT env > server cwd.
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeBase } from "./kb.js";
import { readRegistry, resolveRepo } from "./repo.js";

const VERSION = "0.1.0";
const REFRESH_MS = 3000;

export async function runMcp({ embed = true } = {}) {
  const log = (m) => process.stderr.write(`[repo-kb] ${m}\n`);
  const kbs = new Map();
  const server = new McpServer({ name: "repo-kb", version: VERSION });

  let rootsCwd;
  async function defaultCwd() {
    if (rootsCwd !== undefined) return rootsCwd;
    rootsCwd = null;
    try {
      if (server.server.getClientCapabilities()?.roots) {
        const { roots } = await server.server.listRoots();
        const file = roots.find((r) => r.uri.startsWith("file:"));
        if (file) rootsCwd = fileURLToPath(file.uri);
      }
    } catch {
      // Client does not support roots.
    }
    return rootsCwd;
  }

  async function getKb(repoArg) {
    const cwd = repoArg ? process.cwd() : (await defaultCwd()) || process.env.REPO_KB_ROOT || process.cwd();
    const repo = resolveRepo(repoArg, cwd);
    let kb = kbs.get(repo.treeDir);
    if (!kb) {
      kb = new KnowledgeBase(repo, { embed, log });
      kbs.set(repo.treeDir, kb);
    }
    const stats = kb.refresh({ minIntervalMs: REFRESH_MS });
    if (stats && (stats.added || stats.changed || stats.removed)) log(`${repo.slug}: +${stats.added} ~${stats.changed} -${stats.removed} files`);
    kb.ensureEmbeddings().catch(() => {});
    return kb;
  }

  const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
  const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
  const repoParam = z
    .string()
    .optional()
    .describe('Repo to use: "owner/repo" (seen before on this machine) or a folder path. Default: the current workspace repo.');

  server.registerTool(
    "kb_search",
    {
      title: "Search the repo knowledge base",
      description:
        "Search this repository's docs (docs/**, README, AGENTS.md, Copilot instructions, skills) BEFORE broad file searches or reading files. " +
        "Returns ranked files with the best matching sections (heading, line range, snippet). Then open only those sections (kb_read_section) or files.",
      inputSchema: {
        query: z.string().describe("Natural-language question or keywords"),
        top: z.number().int().min(1).max(20).optional().describe("Number of files to return (default 5)"),
        path_prefix: z.string().optional().describe('Only search under this path, for example "docs/internal/architecture/"'),
        repo: repoParam,
      },
    },
    async ({ query, top, path_prefix, repo }) => {
      try {
        const kb = await getKb(repo);
        const r = await kb.search(query, { top: top || 5, pathPrefix: path_prefix });
        return text(formatResults(r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kb_read_section",
    {
      title: "Read one doc section",
      description: "Read one section of a doc file (by heading text, anchor, or line number) including its sub-sections, instead of the whole file.",
      inputSchema: {
        path: z.string().describe("Repo-relative file path from kb_search"),
        heading: z.string().optional().describe("Heading text or anchor of the section"),
        line: z.number().int().optional().describe("Start line of the section (from kb_search)"),
        repo: repoParam,
      },
    },
    async ({ path, heading, line, repo }) => {
      try {
        const kb = await getKb(repo);
        const s = kb.readSection(path, { heading, line });
        return text(`${s.path}:${s.line}-${s.endLine}${s.truncated ? " (truncated)" : ""}\n\n${s.text}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kb_status",
    {
      title: "Knowledge base status",
      description: "Show which repo is selected, the index location, and the number of indexed files, chunks, and embeddings.",
      inputSchema: { repo: repoParam },
    },
    async ({ repo }) => {
      try {
        return text((await getKb(repo)).status());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kb_reindex",
    {
      title: "Rebuild the knowledge base index",
      description: "Force a full re-read of all indexed files. Normally not needed: the index refreshes itself on each query.",
      inputSchema: { repo: repoParam },
    },
    async ({ repo }) => {
      try {
        const kb = await getKb(repo);
        const stats = kb.refresh({ force: true });
        kb.ensureEmbeddings().catch(() => {});
        return text({ ...stats, ...kb.status() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "kb_list_repos",
    {
      title: "List known repos",
      description: "List the repos that have a knowledge base on this machine (use the name as the repo argument).",
      inputSchema: {},
    },
    async () => text(Object.entries(readRegistry()).map(([slug, v]) => ({ repo: slug, root: v.root }))),
  );

  await server.connect(new StdioServerTransport());
  log(`MCP server ready (cwd ${process.cwd()})`);
}

export function formatResults(r) {
  const lines = [`repo ${r.repo} | ${r.mode} | ${r.ms} ms`];
  if (r.embedding) lines.push(`(semantic index: ${r.embedding}; keyword results for now)`);
  if (!r.results.length) lines.push("No matches.");
  r.results.forEach((f, n) => {
    lines.push(`${n + 1}. ${f.path}  [${f.score}]${f.title ? `  "${f.title}"` : ""}`);
    for (const s of f.sections) {
      lines.push(`   - L${s.line}-${s.endLine} ${s.heading || "(top)"}${s.anchor ? ` (#${s.anchor})` : ""}`);
      if (s.snippet) lines.push(`     ${s.snippet}`);
    }
  });
  return lines.join("\n");
}
