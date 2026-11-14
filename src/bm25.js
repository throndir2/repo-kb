// Owns: tokenizing text and BM25F-style keyword ranking over chunks.
// A document has weighted fields (path, title, heading, body); weighted term counts feed one BM25 score.

const STOP = new Set(
  ("a an and are as at be been being but by can could did do does doing for from had has have how i if in into is it its " +
    "me my of on or our should so than that the their them then there these they this those to too was we were what when " +
    "where which while who whom why will with would you your about after all also any before between both each few more " +
    "most other over same some such only own very just now use used using get gets via per vs etc").split(" "),
);

function undouble(t) {
  return /([b-df-hj-np-rtv-z])\1$/.test(t) && !/(ll|ss|zz)$/.test(t) ? t.slice(0, -1) : t;
}

export function stem(t) {
  if (t.length <= 3 || /\d/.test(t)) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("sses")) return t.slice(0, -2);
  if (t.endsWith("ing") && t.length > 5) return undouble(t.slice(0, -3));
  if (t.endsWith("ed") && t.length > 4 && !t.endsWith("eed")) return undouble(t.slice(0, -2));
  if (t.endsWith("es") && /(?:ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

// Splits on non-alphanumerics and on camelCase / PascalCase boundaries; keeps the joined identifier too.
export function tokenize(text) {
  const out = [];
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  for (const w of words) {
    const parts = w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    const lower = w.toLowerCase();
    if (parts.length > 1 && lower.length <= 40 && !STOP.has(lower)) out.push(stem(lower));
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l.length < 2 && !/\d/.test(l)) continue;
      if (STOP.has(l) || l.length > 40) continue;
      out.push(stem(l));
    }
  }
  return out;
}

export const FIELD_WEIGHTS = { path: 2.5, title: 2, heading: 3, body: 1 };
const K1 = 1.2;
const B = 0.6;

export class Bm25 {
  // docs: array of { path, title, heading, body }
  constructor(docs) {
    this.n = docs.length;
    this.postings = new Map();
    this.len = new Float32Array(this.n);
    let total = 0;
    docs.forEach((d, i) => {
      const tf = new Map();
      let len = 0;
      for (const [field, w] of Object.entries(FIELD_WEIGHTS)) {
        for (const t of tokenize(d[field] || "")) {
          tf.set(t, (tf.get(t) || 0) + w);
          len += w;
        }
      }
      this.len[i] = len;
      total += len;
      for (const [t, f] of tf) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = []));
        p.push(i, f);
      }
    });
    this.avg = total / Math.max(1, this.n);
  }

  idf(term) {
    const p = this.postings.get(term);
    const df = p ? p.length / 2 : 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  // Returns Map(docIndex -> score).
  search(query) {
    const terms = [...new Set(tokenize(query))];
    const scores = new Map();
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = this.idf(t);
      for (let k = 0; k < p.length; k += 2) {
        const i = p[k];
        const f = p[k + 1];
        const s = (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * this.len[i]) / this.avg));
        scores.set(i, (scores.get(i) || 0) + s);
      }
    }
    return { scores, terms };
  }
}
