// Owns: one repo checkout's index (file manifest + chunks), incremental refresh, and hybrid search.
// Needs: a resolved repo (repo.js), its config (config.js), the chunker, BM25, and optionally EmbedCache.
// Changes: <data>/<owner>/<repo>/trees/<id>/manifest.json and the shared embedding cache file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Bm25, tokenize } from "./bm25.js";
import { chunkMarkdown, slugify } from "./chunk.js";
import { listFiles, loadConfig, MAX_FILE_BYTES } from "./config.js";
import { EmbedCache, embeddingsAvailable, installRuntime } from "./embed.js";

const INDEX_VERSION = 3;
const RRF_K = 60;

function sha1(s) {
  return createHash("sha1").update(s).digest("hex");
}

export class KnowledgeBase {
  constructor(repo, { embed = true, log = () => {} } = {}) {
    this.repo = repo;
    this.log = log;
    this.wantEmbed = embed;
    this.manifestFile = path.join(repo.treeDir, "manifest.json");
    this.files = {};
    this.chunks = [];
    this.bm25 = null;
    this.lastRefresh = 0;
    this.embedding = null; // running background fill promise
    this.embedProgress = null;
    this.embedError = null;
    this.load();
  }

  load() {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestFile, "utf8"));
      if (m.version === INDEX_VERSION) this.files = m.files;
    } catch {
      this.files = {};
    }
  }

  save() {
    fs.mkdirSync(this.repo.treeDir, { recursive: true });
    const tmp = `${this.manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, repo: this.repo.slug, root: this.repo.root, files: this.files }));
    fs.renameSync(tmp, this.manifestFile);
  }

  // Re-reads only files whose size/mtime changed, and re-chunks only files whose content hash changed.
  // Returns { added, changed, removed, total }.
  refresh({ force = false, minIntervalMs = 0 } = {}) {
    const now = Date.now();
    if (!force && this.bm25 && now - this.lastRefresh < minIntervalMs) return null;
    this.lastRefresh = now;
    const config = loadConfig(this.repo.root);
    const list = listFiles(this.repo, config);
    const next = {};
    const stats = { added: 0, changed: 0, removed: 0, total: 0 };
    for (const rel of list) {
      const abs = path.join(this.repo.root, rel);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const old = force ? null : this.files[rel];
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) {
        next[rel] = old;
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      const hash = sha1(text);
      if (old && old.hash === hash) {
        next[rel] = { ...old, size: st.size, mtimeMs: st.mtimeMs };
        continue;
      }
      const { title, chunks } = chunkMarkdown(text);
      next[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash, title, chunks };
      if (this.files[rel]) stats.changed++;
      else stats.added++;
    }
    for (const rel of Object.keys(this.files)) if (!next[rel]) stats.removed++;
    stats.total = Object.keys(next).length;
    const dirty = force || stats.added || stats.changed || stats.removed || Object.keys(next).some((k) => next[k] !== this.files[k]);
    this.files = next;
    if (dirty || !this.bm25) {
      if (dirty) this.save();
      this.rebuild();
    }
    return stats;
  }

  rebuild() {
    this.chunks = [];
    for (const [rel, f] of Object.entries(this.files)) {
      for (const c of f.chunks) this.chunks.push({ path: rel, title: f.title || "", ...c });
    }
    this.bm25 = new Bm25(
      this.chunks.map((c) => ({
        path: c.path.replace(/\.md$/i, "").replace(/(^|\/)(README|index)$/i, ""),
        title: c.title,
        heading: c.heading,
        body: c.text,
      })),
    );
  }

  keyOf(c) {
    return (c.ek ??= this.cache.key(this.embedText(c)));
  }

  embedText(c) {
    return `${c.path}\n${c.title}\n${c.heading}\n${c.text}`.slice(0, 2000);
  }

  // Starts (or reuses) a background job that embeds every chunk that has no cached vector yet.
  async initCache({ waitInstall = false } = {}) {
    if (!this.wantEmbed || this.embedError) return false;
    if (!this.cache) {
      let state = await embeddingsAvailable(this.log);
      if (state === "installing") {
        this.runtimeState = "installing";
        if (!waitInstall) return false;
        if (await installRuntime(this.log)) state = await embeddingsAvailable(this.log);
      }
      if (state !== "ready") {
        this.runtimeState = null;
        this.embedError = new Error(state === "off" ? "disabled" : "embedding runtime could not be installed");
        return false;
      }
      this.runtimeState = null;
      this.cache = new EmbedCache(this.repo.dir);
    }
    return true;
  }

  async ensureEmbeddings({ wait = false, onProgress } = {}) {
    if (!(await this.initCache({ waitInstall: wait }))) return false;
    const texts = this.chunks.map((c) => this.embedText(c));
    const missing = texts.filter((t) => !this.cache.map.has(this.cache.key(t))).length;
    if (missing === 0) return true;
    if (!this.embedding) {
      this.embedProgress = { done: 0, total: missing };
      this.embedding = this.cache
        .fill(texts, {
          onProgress: (done, total) => {
            this.embedProgress = { done, total };
            onProgress?.(done, total);
          },
        })
        .catch((e) => {
          this.embedError = e;
          this.log(`embedding failed: ${e.message}`);
        })
        .finally(() => {
          this.embedding = null;
        });
    }
    if (wait) {
      await this.embedding;
      return !this.embedError;
    }
    return false;
  }

  vectorsReady() {
    if (!this.cache || this.embedding || this.embedError) return false;
    return this.chunks.every((c) => this.cache.map.has(this.keyOf(c)));
  }

  // Hybrid search. Returns ranked files, each with its best sections.
  async search(query, { top = 5, sectionsPerFile = 3, pathPrefix = null, mode = "auto" } = {}) {
    const t0 = performance.now();
    const { scores, terms } = this.bm25.search(query);
    const allow = (i) => !pathPrefix || this.chunks[i].path.toLowerCase().startsWith(pathPrefix.toLowerCase());

    const kwRank = [...scores.entries()].filter(([i]) => allow(i)).sort((a, b) => b[1] - a[1]).slice(0, 300);
    let dense = [];
    let usedVectors = false;
    if (mode !== "keyword" && this.wantEmbed) {
      await this.ensureEmbeddings({ wait: mode === "hybrid" });
      if (this.vectorsReady()) {
        const [qv] = await this.cache.embed([query], { query: true });
        const sims = [];
        for (let i = 0; i < this.chunks.length; i++) {
          if (!allow(i)) continue;
          const v = this.cache.map.get(this.keyOf(this.chunks[i]));
          let s = 0;
          for (let d = 0; d < v.length; d++) s += v[d] * qv[d];
          sims.push([i, s]);
        }
        dense = sims.sort((a, b) => b[1] - a[1]).slice(0, 300);
        usedVectors = true;
      }
    }

    // Reciprocal-rank fusion of the keyword list and the vector list.
    const fused = new Map();
    const add = (list, w) =>
      list.forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + w / (RRF_K + r + 1)));
    add(kwRank, 1);
    if (usedVectors) add(dense, 1);

    const byFile = new Map();
    for (const [i, s] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
      const c = this.chunks[i];
      let f = byFile.get(c.path);
      if (!f) byFile.set(c.path, (f = { path: c.path, title: c.title, score: 0, sections: [] }));
      if (f.sections.length < sectionsPerFile && !f.sections.some((x) => this.chunks[x.i].heading === c.heading)) f.sections.push({ i, s });
    }
    const files = [...byFile.values()]
      .map((f) => ({ ...f, score: f.sections[0].s + 0.25 * (f.sections[1]?.s || 0) + 0.1 * (f.sections[2]?.s || 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
    const maxScore = files[0]?.score || 1;
    return {
      repo: this.repo.slug,
      mode: usedVectors ? "hybrid" : "keyword",
      ms: Math.round(performance.now() - t0),
      results: files.map((f) => ({
        path: f.path,
        title: f.title,
        score: Math.round((f.score / maxScore) * 1000) / 1000,
        sections: f.sections.map(({ i }, n) => {
          const c = this.chunks[i];
          const s = { heading: c.heading, anchor: c.anchor, line: c.line, endLine: c.endLine };
          if (n === 0) s.snippet = snippet(c.text, terms);
          return s;
        }),
      })),
      embedding: usedVectors || !this.wantEmbed ? undefined : this.runtimeState === "installing" ? "installing the embedding runtime" : this.embedding ? `building ${this.embedProgress.done}/${this.embedProgress.total} chunks` : undefined,
    };
  }

  // Returns the text of one section (by heading text/anchor or by line), including its sub-sections.
  readSection(rel, { heading, line, maxChars = 12000 } = {}) {
    const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const abs = path.join(this.repo.root, norm);
    if (!path.resolve(abs).startsWith(path.resolve(this.repo.root))) throw new Error("Path is outside the repo");
    const lines = fs.readFileSync(abs, "utf8").replace(/\r\n?/g, "\n").split("\n");
    let start = 0;
    let level = 0;
    if (heading || line) {
      const want = heading ? heading.toLowerCase().split(">").pop().trim() : null;
      let fence = false;
      let found = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) fence = !fence;
        const h = !fence && lines[i].match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (line && i + 1 >= line && h) { found = i; level = h[1].length; break; }
        if (line && i + 1 === line) { found = i; break; }
        if (want && h) {
          const text = h[2].replace(/\s+#+\s*$/, "").replace(/[`*_]/g, "").trim().toLowerCase();
          if (text === want || slugify(text) === want.replace(/^#/, "")) { found = i; level = h[1].length; break; }
        }
      }
      if (found < 0) throw new Error(`Section not found in ${norm}: ${heading || `line ${line}`}`);
      start = found;
    }
    let end = lines.length;
    if (level) {
      let fence = false;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) fence = !fence;
        const h = !fence && lines[i].match(/^\s{0,3}(#{1,6})\s/);
        if (h && h[1].length <= level) { end = i; break; }
      }
    }
    let text = lines.slice(start, end).join("\n");
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return { path: norm, line: start + 1, endLine: end, truncated, text };
  }

  status() {
    const cacheCount = this.cache ? this.chunks.filter((c) => this.cache.map.has(this.keyOf(c))).length : 0;
    return {
      repo: this.repo.slug,
      root: this.repo.root,
      indexDir: this.repo.treeDir,
      files: Object.keys(this.files).length,
      chunks: this.chunks.length,
      embeddings: this.wantEmbed
        ? this.embedError
          ? `off (${this.embedError.message})`
          : this.runtimeState === "installing"
            ? "installing runtime"
            : `${cacheCount}/${this.chunks.length}${this.embedding ? " (building)" : ""}`
        : "off",
    };
  }
}

// Picks the ~240-char window of the chunk text with the most query-term hits.
export function snippet(text, terms, width = 220) {
  const clean = text
    .replace(/^#+\s.*\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\u2500-\u257f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= width) return clean;
  const set = new Set(terms);
  const words = clean.split(" ");
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < words.length; i += 4) {
    let s = 0;
    let len = 0;
    for (let j = i; j < words.length && len < width; j++) {
      len += words[j].length + 1;
      if (tokenize(words[j]).some((t) => set.has(t))) s++;
    }
    if (s > bestScore) { bestScore = s; best = i; }
  }
  let out = "";
  for (let j = best; j < words.length && out.length + words[j].length < width; j++) out += (out ? " " : "") + words[j];
  return (best > 0 ? "… " : "") + out + " …";
}
