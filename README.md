# repo-kb

A local knowledge base for each repository. It indexes the Markdown docs of a repo and answers "where is X documented?" before an agent reads files. This saves tokens: the agent opens one section, not ten files.

- Runs fully local on CPU. No API key, no GPU, no GitHub plan, no network after the first setup.
- Hybrid search: BM25 keyword ranking plus a small local embedding model (`bge-small-en-v1.5`, int8 ONNX), fused by reciprocal rank.
- Markdown is split at headings. Each result gives the file path, the heading trail, the line range, a short snippet, and a score.
- One index per repository. The repo is detected from the git remote of the current folder.
- The index updates itself: each query re-checks file sizes and modification times and re-reads only changed files (by content hash).

## Start it (no install step)

You need Node.js 20 or later and git.

### As an MCP server for one repository

Commit this file as `.github/mcp.json` in the repository:

```json
{
  "mcpServers": {
    "repo-kb": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "github:throndir2/repo-kb", "mcp"],
      "tools": ["*"]
    }
  }
}
```

### As an MCP server for every repository on your machine

Add the same `repo-kb` entry under `mcpServers` in your user MCP config (for Copilot CLI and the Copilot app: `~/.copilot/mcp-config.json`). The server selects the repo of the session's workspace for each call.

### As a CLI

```sh
npx -y github:throndir2/repo-kb search "how are releases published"
```

Or install it once: `npm install -g github:throndir2/repo-kb`, then use `repo-kb ...`.

## First use

1. The first query builds the keyword index (a few seconds for ~700 files). Keyword search works at once.
2. In the background, repo-kb installs the embedding runtime once (`@huggingface/transformers`, about 450 MB, into the data folder) and downloads the model (about 35 MB).
3. Then it embeds all chunks once (roughly 20 to 60 chunks per second on a laptop CPU). Search results say `keyword` until this is done, then `hybrid`.
4. Later queries embed only new or changed chunks.

To do all of this up front, run `repo-kb index` in the repo. To never use embeddings, set `REPO_KB_EMBED=0` or pass `--no-embed`.

## MCP tools

| Tool | Use |
| --- | --- |
| `kb_search` | Search the docs. Arguments: `query`, optional `top` (default 5), `path_prefix`, `repo`. Returns ranked files with their best sections. |
| `kb_read_section` | Read one section (and its sub-sections) of a file by `heading` text, anchor, or `line`. Use it instead of reading the whole file. |
| `kb_status` | Show the selected repo, the index folder, and the number of files, chunks, and embeddings. |
| `kb_reindex` | Force a full re-read. Normally not needed. |
| `kb_list_repos` | List the repos that have an index on this machine. |

Suggested agent instruction: "Before broad file searches, call `kb_search` for the current repo, then read only the returned sections."

## CLI

```text
repo-kb search "<question>" [--top 5] [--prefix docs/x/] [--keyword] [--json]
repo-kb read <path> [--heading "<text>" | --line <n>]
repo-kb index [--full] [--no-embed]
repo-kb status
repo-kb repos
repo-kb eval <questions.json> [--wkb <name>] [--keyword] [--json]
repo-kb mcp [--no-embed]
```

All commands accept `--repo <owner/repo | path>`.

## How per-repo separation works

- The repo identity is `owner/repo` from `git remote get-url origin`. A folder without a remote is `local/<folder name>`.
- Each repo has its own folder: `%LOCALAPPDATA%\repo-kb\<owner>\<repo>` on Windows, `~/.cache/repo-kb/<owner>/<repo>` elsewhere (override with `REPO_KB_HOME`).
- Each checkout (main clone or git worktree) has its own file manifest under `trees/<id>`, because branches can differ. The embedding cache is shared by all checkouts of the repo, keyed by a hash of the chunk text, so a new worktree costs almost nothing.
- A search only uses one repo. In MCP, the repo comes from the `repo` argument, else from the client's workspace root, else from `REPO_KB_ROOT`, else from the server's working folder. `repo: "owner/repo"` works for any repo that was opened before on this machine.
- No index data is written into the repository.

## Choose which files to index

The default set is:

```text
docs/**/*.md, AGENTS.md, README.md, CONTRIBUTING.md, .github/copilot-instructions.md,
.github/instructions/**/*.md, .github/skills/**/*.md, .github/agents/**/*.md
```

Files come from `git ls-files` (tracked plus untracked, not ignored). To change the set, commit a `.repo-kb.json` in the repo root:

```json
{ "include": ["docs/**/*.md", "README.md", "src/**/README.md"], "exclude": ["docs/archive/**"] }
```

## Evaluate retrieval quality

Make a JSON file of questions with the doc paths that answer them:

```json
[{ "q": "How do I cut a release?", "expect": ["docs/setup/releases.md"] }]
```

Run `repo-kb eval questions.json` in the repo. It reports hit@1, hit@3, hit@5, MRR, and latency. Add `--wkb <name>` to run the same questions through WikiKB (`wkb <name> search`) and compare. Wiki page names are mapped back to docs paths (`docs/a/b.md` is page `a-b`; `docs/README.md` is `Home`). Set `WKB_BIN` if `wkb` is not on `PATH`.

Keep evaluation files for private repositories in those repositories, not here.

## Environment variables

| Variable | Effect |
| --- | --- |
| `REPO_KB_HOME` | Data folder (indexes, embedding runtime, model). |
| `REPO_KB_ROOT` | Default repo folder for the MCP server when the client gives no workspace root. |
| `REPO_KB_EMBED=0` | Keyword search only. |
| `REPO_KB_AUTO_INSTALL=0` | Do not install the embedding runtime automatically. |
| `REPO_KB_MODEL` | A different transformers.js feature-extraction model. |
