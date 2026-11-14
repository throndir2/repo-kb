// Owns: splitting one Markdown file into heading-based chunks.
// Each chunk has the heading trail (H1 > H2 > ...), 1-based start/end lines, and its text.
// Long sections are split into windows; tiny sections stay separate so headings remain addressable.

const MAX_CHARS = 2400;
const WINDOW_OVERLAP_LINES = 3;

function stripFrontMatter(lines) {
  if (lines[0]?.trim() !== "---") return { title: null, start: 0 };
  for (let i = 1; i < Math.min(lines.length, 80); i++) {
    if (lines[i].trim() === "---") {
      const t = lines.slice(1, i).find((l) => /^title\s*:/i.test(l));
      return { title: t ? t.replace(/^title\s*:\s*/i, "").replace(/^["']|["']$/g, "").trim() : null, start: i + 1 };
    }
  }
  return { title: null, start: 0 };
}

export function cleanHeading(s) {
  return s
    .replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

// GitHub-style anchor for a heading.
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function chunkMarkdown(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fm = stripFrontMatter(lines);
  const sections = [];
  const trail = [];
  let cur = { trail: [], level: 0, start: fm.start, lines: [] };
  let fence = null;
  for (let i = fm.start; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      sections.push(cur);
      const level = h[1].length;
      while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
      trail.push({ level, text: cleanHeading(h[2]) });
      cur = { trail: trail.map((t) => t.text), level, start: i, lines: [line] };
    } else cur.lines.push(line);
  }
  sections.push(cur);

  const title = fm.title || sections.find((s) => s.level === 1)?.trail[0] || null;
  const chunks = [];
  for (const s of sections) {
    const body = s.lines.join("\n");
    if (!body.trim()) continue;
    if (s.level === 0 && !body.replace(/<!--[\s\S]*?-->/g, "").trim()) continue;
    const heading = s.trail.join(" > ");
    if (body.length <= MAX_CHARS) {
      chunks.push({ heading, anchor: s.trail.length ? slugify(s.trail[s.trail.length - 1]) : "", line: s.start + 1, endLine: s.start + s.lines.length, text: body });
      continue;
    }
    let i = 0;
    while (i < s.lines.length) {
      let len = 0;
      let j = i;
      while (j < s.lines.length && (len + s.lines[j].length < MAX_CHARS || j === i)) len += s.lines[j++].length + 1;
      chunks.push({
        heading,
        anchor: s.trail.length ? slugify(s.trail[s.trail.length - 1]) : "",
        line: s.start + i + 1,
        endLine: s.start + j,
        text: s.lines.slice(i, j).join("\n"),
      });
      if (j >= s.lines.length) break;
      i = Math.max(i + 1, j - WINDOW_OVERLAP_LINES);
    }
  }
  return { title, chunks };
}
