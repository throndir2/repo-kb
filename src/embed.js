// Owns: the optional local embedding model (transformers.js, CPU, ONNX int8) and the per-repo embedding cache.
// Needs: the "@huggingface/transformers" package. It is not a package dependency (it is ~450 MB of native
// binaries), so `npx` starts fast. On first use it is installed once into <data>/runtime in the background;
// until then search is keyword-only. Set REPO_KB_EMBED=0 to never use embeddings.
// The cache maps sha1(model + text) -> vector, so unchanged chunks are never embedded twice, across worktrees too.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataRoot } from "./repo.js";

export const DEFAULT_MODEL = process.env.REPO_KB_MODEL || "Xenova/bge-small-en-v1.5";
const TRANSFORMERS_SPEC = "@huggingface/transformers@4";
const QUERY_PREFIX = {
  "Xenova/bge-small-en-v1.5": "Represent this sentence for searching relevant passages: ",
  "Xenova/bge-base-en-v1.5": "Represent this sentence for searching relevant passages: ",
};

let pipePromise = null;
let loadError = null;
let modulePromise = null;
let installPromise = null;

function runtimeDir() {
  return path.join(dataRoot(), "runtime");
}

async function importTransformers() {
  try {
    return await import("@huggingface/transformers");
  } catch {
    const req = createRequire(path.join(runtimeDir(), "package.json"));
    return import(pathToFileURL(req.resolve("@huggingface/transformers")).href);
  }
}

// Installs transformers.js into <data>/runtime once. Resolves true on success.
export function installRuntime(log = () => {}) {
  if (installPromise) return installPromise;
  installPromise = new Promise((resolve) => {
    const dir = runtimeDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, "package.json"))) fs.writeFileSync(path.join(dir, "package.json"), '{ "private": true }\n');
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const [cmd, args] = fs.existsSync(npmCli)
      ? [process.execPath, [npmCli]]
      : [process.platform === "win32" ? "npm.cmd" : "npm", []];
    log(`installing ${TRANSFORMERS_SPEC} into ${dir} (one time, ~450 MB) ...`);
    const p = spawn(cmd, [...args, "install", TRANSFORMERS_SPEC, "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: !fs.existsSync(npmCli) && process.platform === "win32",
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { log(`runtime install failed: ${e.message}`); resolve(false); });
    p.on("close", (code) => {
      if (code !== 0) log(`runtime install failed (${code}): ${err.slice(-500)}`);
      else log("embedding runtime installed");
      modulePromise = null;
      resolve(code === 0);
    });
  });
  return installPromise;
}

async function getPipe(model) {
  if (loadError) throw loadError;
  if (!pipePromise) {
    pipePromise = (async () => {
      const t = await importTransformers();
      t.env.cacheDir = process.env.REPO_KB_MODEL_CACHE || path.join(dataRoot(), "models");
      return t.pipeline("feature-extraction", model, { dtype: "q8", device: "cpu" });
    })().catch((e) => {
      loadError = e;
      throw e;
    });
  }
  return pipePromise;
}

// Returns "ready", "installing", or "off". Starts the one-time runtime install when allowed.
export async function embeddingsAvailable(log) {
  if (process.env.REPO_KB_EMBED === "0") return "off";
  modulePromise ??= importTransformers().then(() => true, () => false);
  if (await modulePromise) return "ready";
  if (process.env.REPO_KB_AUTO_INSTALL === "0") return "off";
  installRuntime(log);
  return "installing";
}

export class EmbedCache {
  constructor(repoDir, model = DEFAULT_MODEL) {
    this.model = model;
    this.file = path.join(repoDir, `emb-${model.replace(/[^A-Za-z0-9_.-]/g, "_")}.bin`);
    this.map = new Map();
    this.dim = 0;
    this.dirty = false;
    this.load();
  }

  key(text) {
    return createHash("sha1").update(this.model).update("\0").update(text).digest("hex");
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const buf = fs.readFileSync(this.file);
    const dim = buf.readUInt32LE(0);
    const rec = 20 + dim * 4;
    this.dim = dim;
    for (let off = 4; off + rec <= buf.length; off += rec) {
      const k = buf.subarray(off, off + 20).toString("hex");
      const bytes = new Uint8Array(dim * 4);
      bytes.set(buf.subarray(off + 20, off + rec));
      this.map.set(k, new Float32Array(bytes.buffer));
    }
  }

  // Keeps only the given keys (drops vectors of deleted chunks), then writes the file.
  save(keep) {
    if (keep) {
      for (const k of this.map.keys()) if (!keep.has(k)) { this.map.delete(k); this.dirty = true; }
    }
    if (!this.dirty || !this.dim) return;
    const rec = 20 + this.dim * 4;
    const buf = Buffer.alloc(4 + rec * this.map.size);
    buf.writeUInt32LE(this.dim, 0);
    let off = 4;
    for (const [k, v] of this.map) {
      Buffer.from(k, "hex").copy(buf, off);
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, off + 20);
      off += rec;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  async embed(texts, { query = false } = {}) {
    const pipe = await getPipe(this.model);
    const input = query ? texts.map((t) => (QUERY_PREFIX[this.model] || "") + t) : texts;
    const out = await pipe(input, { pooling: this.model.includes("MiniLM") ? "mean" : "cls", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    this.dim = dim;
    const res = [];
    for (let i = 0; i < texts.length; i++) res.push(Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
    return res;
  }

  // Embeds every text that is not cached yet. Calls onProgress(done, total) between batches.
  async fill(texts, { batch = 16, onProgress, shouldStop } = {}) {
    const todo = [];
    const seen = new Set();
    for (const t of texts) {
      const k = this.key(t);
      if (!this.map.has(k) && !seen.has(k)) { seen.add(k); todo.push([k, t]); }
    }
    for (let i = 0; i < todo.length; i += batch) {
      if (shouldStop?.()) break;
      const part = todo.slice(i, i + batch);
      const vecs = await this.embed(part.map((p) => p[1]));
      part.forEach(([k], j) => this.map.set(k, vecs[j]));
      this.dirty = true;
      onProgress?.(Math.min(i + batch, todo.length), todo.length);
      if ((i / batch) % 40 === 39) this.save();
    }
    this.save();
    return todo.length;
  }
}
