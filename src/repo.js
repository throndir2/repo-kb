// Owns: repository identity (owner/repo + root folder), data folder layout, and the known-repo registry.
// Needs: git on PATH (falls back to folder name when the folder is not a git repo).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataRoot() {
  if (process.env.REPO_KB_HOME) return process.env.REPO_KB_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "repo-kb");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "repo-kb");
}

export function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

// Turns a remote URL (https, ssh, scp-like) into "owner/repo".
export function slugFromRemote(url) {
  if (!url) return null;
  const m = url.trim().replace(/\.git$/i, "").match(/[:/]([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function registryPath() {
  return path.join(dataRoot(), "repos.json");
}

export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return {};
  }
}

function remember(repo) {
  const reg = readRegistry();
  if (reg[repo.slug]?.root === repo.root) return;
  reg[repo.slug] = { root: repo.root, lastSeen: new Date().toISOString() };
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
  } catch {
    // The registry is only a convenience for "owner/repo" lookups.
  }
}

// Resolves a repo from an explicit value ("owner/repo" or a path) or from a starting folder.
// An explicit "owner/repo" only works for repos that were opened before on this machine.
export function resolveRepo(spec, cwd = process.cwd()) {
  let start = cwd;
  if (spec) {
    if (SLUG_RE.test(spec) && !fs.existsSync(path.resolve(cwd, spec))) {
      const hit = Object.entries(readRegistry()).find(([k]) => k.toLowerCase() === spec.toLowerCase());
      if (!hit) {
        throw new Error(`Unknown repo "${spec}". Run repo-kb once inside that repo, or pass its folder path.`);
      }
      start = hit[1].root;
    } else {
      start = path.resolve(cwd, spec);
    }
  }
  if (!fs.existsSync(start)) throw new Error(`Folder does not exist: ${start}`);
  const top = git(start, ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(top || start);
  const slug = slugFromRemote(git(root, ["remote", "get-url", "origin"])) || `local/${path.basename(root)}`;
  const [owner, name] = slug.split("/");
  const safe = (s) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = path.join(dataRoot(), safe(owner), safe(name));
  // Each checkout (main clone or worktree) gets its own file manifest; the embedding cache is shared per repo.
  const treeId = createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 10);
  const repo = { slug, root, isGit: !!top, dir, treeDir: path.join(dir, "trees", treeId) };
  remember(repo);
  return repo;
}
