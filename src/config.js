// Owns: which files of a repo are indexed (include/exclude globs) and listing them.
// Needs: the repo root. Reads an optional ".repo-kb.json" in the repo root to override the defaults.
import fs from "node:fs";
import path from "node:path";
import { git } from "./repo.js";

export const DEFAULT_INCLUDE = [
  "docs/**/*.md",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  ".github/copilot-instructions.md",
  ".github/instructions/**/*.md",
  ".github/skills/**/*.md",
  ".github/agents/**/*.md",
];
export const DEFAULT_EXCLUDE = ["**/node_modules/**"];
export const MAX_FILE_BYTES = 512 * 1024;

export function loadConfig(root) {
  let user = {};
  const file = path.join(root, ".repo-kb.json");
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Invalid ${file}: ${e.message}`);
    }
  }
  return {
    include: user.include || DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(user.exclude || [])],
  };
}

// Converts a glob (**, *, ?) to a regex over forward-slash relative paths.
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function walk(root, dir = "", out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Lists tracked plus untracked-but-not-ignored files that match the config.
export function listFiles(repo, config) {
  let files;
  if (repo.isGit) {
    const out = git(repo.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    files = out === null ? walk(repo.root) : [...new Set(out.split("\0").filter(Boolean))];
  } else files = walk(repo.root);
  const inc = config.include.map(globToRegex);
  const exc = config.exclude.map(globToRegex);
  return files.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f))).sort();
}
