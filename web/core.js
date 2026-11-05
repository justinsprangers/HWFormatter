// HW Formatter (web): find problems in a homework PDF and lay them out on
// engineering paper. Port of hwcore.py + hwbook.py; keep the two in step.
// Uses MuPDF.js, the same PDF engine as PyMuPDF, so text comes out the same.

import * as mupdf from "https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js";

export { mupdf };
// Settings (defaults in store.js): scale, heading_patterns, ...

// Letter page, 612 x 792 pt. Positions are measured from paper.png
// (1545 x 2000 px) and converted to points.
export const PAGE_W = 612, PAGE_H = 792;
const PX = PAGE_W / 1545;
const HEADER_BOTTOM = 90 * PX;
const BOX_NAME = [158 * PX, 545 * PX];
const BOX_CLASS = [545 * PX, 954 * PX];
const BOX_DATE = [954 * PX, 1431 * PX];
const GRID_LEFT = 158 * PX, GRID_RIGHT = 1431 * PX;
const MARGIN = 4; // gap between grid lines and the pasted problem
const SEG_GAP = 4; // gap between stacked pieces of one problem
const PAD = 4; // white space kept around the cropped content
const FOOTER_RE = /^\s*(page\s*)?\d+\s*(of\s*\d+)?\s*$/i;

const GREEN = [27 / 255, 116 / 255, 29 / 255];
const GRID_MAJOR = [206 / 255, 228 / 255, 211 / 255];
const GRID_MINOR = [224 / 255, 234 / 255, 227 / 255];
const CELL = 36.37 * PX; // one small grid square, in points

// Text extraction options = PyMuPDF's defaults for get_text("dict").
const STEXT = "preserve-ligatures=yes,preserve-whitespace=yes,preserve-images=yes," +
  "clip=yes,use-cid-for-unknown-unicode=yes";

// ------------------------------------------------------------------ helpers
// Rects are [x0, y0, x1, y1] in page coordinates (origin top-left, y down).

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
export const isEmpty = (r) => r[0] >= r[2] || r[1] >= r[3];
const area = (r) => (isEmpty(r) ? 0 : (r[2] - r[0]) * (r[3] - r[1]));
const width = (r) => r[2] - r[0];
const height = (r) => r[3] - r[1];
const pad = (r, bounds, p = PAD) => intersect([r[0] - p, r[1] - p, r[2] + p, r[3] + p], bounds);

// Python's round() (half to even), so items sort in the same order.
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
const byPosition = (a, b) => pyRound(a.rect[1]) - pyRound(b.rect[1]) || a.rect[0] - b.rect[0];

const tick = () => new Promise((r) => setTimeout(r, 0));

export class Problem {
  // One problem = one or more cropped rectangles (segments) of source PDFs.
  constructor(title, number, segments, scale) {
    this.title = title; // e.g. "HW#3.1"
    this.number = number; // e.g. "1", used for "P1" in the header
    this.segments = segments; // [{doc, page, rect}]
    this.scale = scale;
  }
}

// ------------------------------------------------------------------ reading pages

// Ascender/descender MuPDF uses for a Type3 font: the y range of FontBBox
// transformed by FontMatrix. MuPDF names unnamed Type3 fonts "Type3 (N 0 R)",
// so the font dictionary is object N. null if it can't be read.
const type3Cache = new WeakMap(); // doc -> Map(font name -> [asc, dsc] | null)
function type3Metrics(doc, name) {
  let m = type3Cache.get(doc);
  if (!m) type3Cache.set(doc, (m = new Map()));
  if (m.has(name)) return m.get(name);
  let v = null;
  const ref = /\((\d+) \d+ R\)/.exec(name);
  if (ref) {
    try {
      const f = doc.asPDF().newIndirect(+ref[1]).resolve();
      const bb = f.get("FontBBox"), fm = f.get("FontMatrix");
      if (bb.isArray() && fm.isArray()) {
        const b = [0, 1, 2, 3].map((i) => bb.get(i).asNumber());
        const M = [0, 1, 2, 3, 4, 5].map((i) => fm.get(i).asNumber());
        const ys = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => M[1] * x + M[3] * y + M[5]);
        v = [Math.max(...ys), Math.min(...ys)];
      }
    } catch {
      v = null;
    }
  }
  m.set(name, v);
  return v;
}

// Ascender/descender of a regular (non-Type3) font. MuPDF's box for a
// character is its font's ascender/descender box, so the typical (median) box
// on the page gives them; a few oddly scaled characters don't skew it.
// Remembered per document for pages with only a few characters in the font.
const fontCache = new WeakMap(); // doc -> Map(font name -> [asc, dsc])
function regularMetrics(doc, f) {
  let m = fontCache.get(doc);
  if (!m) fontCache.set(doc, (m = new Map()));
  if (f.boxes.length < 5 && m.has(f.name)) return m.get(f.name);
  if (!f.boxes.length) return null;
  f.boxes.sort((p, q) => p[0] + p[1] - (q[0] + q[1]));
  const [a, d] = f.boxes[f.boxes.length >> 1];
  const v = [a, -d];
  if (f.boxes.length >= 5 || !m.has(f.name)) m.set(f.name, v);
  return v;
}

// Box of one character, sized the way PyMuPDF does it (JM_char_quad in
// PyMuPDF's extra.i): if the font's ascender - descender is under 1 em (true
// for the Type3 math fonts in some textbooks), the box is rebuilt as exactly
// 1 em tall, keeping the ascender:descender ratio. Otherwise MuPDF's box is
// kept. ch = {c, o (origin), size, q (quad), f: {font, metrics: [asc, dsc]}}.
function charBox(ch, horizontal) {
  const { o, size, q } = ch;
  let x0 = Math.min(q[0], q[2], q[4], q[6]), x1 = Math.max(q[0], q[2], q[4], q[6]);
  let y0 = Math.min(q[1], q[3], q[5], q[7]), y1 = Math.max(q[1], q[3], q[5], q[7]);
  if (!horizontal || !(size > 0) || !ch.f.metrics) return [x0, y0, x1, y1];
  let [asc, dsc] = ch.f.metrics;
  let t = asc - dsc + 1.2e-7;
  if (t >= 1 - 1e-6) return [x0, y0, x1, y1]; // no problem
  if (asc < 1e-3) {
    // probably a glyphless font
    asc = 0.9;
    dsc = -0.1;
    t = 1;
  }
  asc /= t;
  dsc /= t;
  y0 = o[1] - asc * size;
  y1 = o[1] - dsc * size;
  if (x0 < o[0]) x0 = o[0];
  if (x1 - x0 < 1e-6) {
    const g = ch.f.font.encodeCharacter(ch.c);
    if (g) x1 = x0 + ch.f.font.advanceGlyph(g) * size;
  }
  return [x0, y0, x1, y1];
}

// PyMuPDF's JM_rects_overlap
const overlaps = (a, b) => !(a[0] >= b[2] || a[1] >= b[3] || a[2] <= b[0] || a[3] <= b[1]);

// Text lines and images of a page, as PyMuPDF's get_text("dict") reports
// them: lines outside the page are skipped, and so are characters whose box
// misses the page. Lines: {rect, text, size, font} (of the first character).
function readPage(page, doc) {
  const bounds = page.getBounds();
  const st = page.toStructuredText(STEXT);
  const fonts = new Map(); // font pointer -> {name, font, metrics, boxes}, for this page
  const raw = [], images = [];
  let cur = null;
  st.walk({
    onImageBlock(bbox) {
      images.push([bbox[0], bbox[1], bbox[2], bbox[3]]);
    },
    beginLine(bbox, wmode, dir) {
      const horizontal = !wmode && Math.abs(dir[0] - 1) < 1e-6 && Math.abs(dir[1]) < 1e-6;
      cur = { bbox: [bbox[0], bbox[1], bbox[2], bbox[3]], horizontal, chars: [] };
    },
    onChar(c, o, font, size, q) {
      let f = fonts.get(font.pointer);
      if (!f) {
        const name = font.getName();
        const t3 = name.includes("Type3");
        f = { name, font, t3, metrics: t3 ? type3Metrics(doc, name) : null, boxes: [] };
        fonts.set(font.pointer, f);
      }
      const ch = { c, o: [o[0], o[1]], size, q: Array.from(q), f };
      cur.chars.push(ch);
      if (!f.t3 && cur.horizontal && size > 0) {
        const ys = [q[1], q[3], q[5], q[7]];
        f.boxes.push([(o[1] - Math.min(...ys)) / size, (Math.max(...ys) - o[1]) / size]);
      }
    },
    endLine() {
      if (cur) raw.push(cur);
      cur = null;
    },
  });
  for (const f of fonts.values()) if (!f.t3) f.metrics = regularMetrics(doc, f);
  const lines = [];
  for (const line of raw) {
    if (isEmpty(intersect(bounds, line.bbox))) continue;
    let rect = null, text = "", font = "", size = 0;
    for (const ch of line.chars) {
      const r = charBox(ch, line.horizontal);
      if (!overlaps(bounds, r)) continue;
      if (!rect) {
        rect = r;
        font = ch.f.name;
        size = ch.size;
      } else {
        rect = union(rect, r);
      }
      text += ch.c;
    }
    if (rect && text.trim()) lines.push({ rect, text, size, font });
  }
  st.destroy();
  return { lines, images };
}

// Bounding boxes of vector drawings (lines, boxes, filled shapes).
function pageDrawings(page) {
  const rects = [];
  const add = (path, m) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pt = (x, y) => {
      const X = x * m[0] + y * m[2] + m[4], Y = x * m[1] + y * m[3] + m[5];
      if (X < x0) x0 = X;
      if (X > x1) x1 = X;
      if (Y < y0) y0 = Y;
      if (Y > y1) y1 = Y;
    };
    path.walk({ moveTo: pt, lineTo: pt, curveTo(a, b, c, d, e, f) { pt(a, b); pt(c, d); pt(e, f); } });
    if (x0 <= x1) rects.push([x0, y0, x1, y1]);
  };
  const dev = new mupdf.Device({
    fillPath(path, evenOdd, ctm) { add(path, ctm); },
    strokePath(path, stroke, ctm) { add(path, ctm); },
  });
  page.runPageContents(dev, mupdf.Matrix.identity);
  dev.close();
  return rects;
}

// Content of a page in reading order: {rect, text, size, bold} (hwbook._lines_and_images).
function linesAndImages(page, doc) {
  const bounds = page.getBounds();
  const { lines, images } = readPage(page, doc);
  const items = lines.map((l) => ({
    rect: l.rect,
    text: l.text,
    // Type3 fonts are rendered math (huge brackets etc.); size -1 keeps
    // them from looking like headings or problem numbers.
    size: l.font.includes("Type3") ? -1 : l.size,
    bold: l.font.includes("Bold"),
  }));
  for (const im of images) {
    const r = intersect(im, bounds);
    if (!isEmpty(r)) items.push({ rect: r, text: "", size: 0, bold: false });
  }
  items.sort(byPosition);
  return items;
}

// Visible content on a page as {rect, text}; text is "" for graphics (hwcore._page_items).
function pageItems(page, doc) {
  const bounds = page.getBounds();
  const h = height(bounds);
  const { lines, images } = readPage(page, doc);
  const items = [];
  for (const l of lines) {
    if (l.rect[1] > h * 0.9 && FOOTER_RE.test(l.text)) continue; // "Page 2 of 5" footer
    items.push({ rect: l.rect, text: l.text });
  }
  for (const im of images) {
    const r = intersect(im, bounds);
    if (!isEmpty(r)) items.push({ rect: r, text: "" });
  }
  const pageArea = area(bounds);
  for (const d of pageDrawings(page)) {
    const r = intersect(d, bounds);
    if (isEmpty(r) || area(r) > 0.8 * pageArea) continue; // skip page borders
    items.push({ rect: r, text: "" });
  }
  items.sort(byPosition);
  return items;
}

function pageText(doc, i) {
  const page = doc.loadPage(i);
  const st = page.toStructuredText(STEXT);
  const t = st.asText();
  st.destroy();
  page.destroy();
  return t;
}

// ------------------------------------------------------------------ textbook index

const BIG_FONT = 19.5; // section headings ("Problems for Section 5.1") are larger than this
const START_RE = /^[^\p{L}\p{N}_]{0,2}\s*(\d{1,2})\.(\d{1,3})\.?(?![.\d])/u; // "5.3" or "2.1."
const CAPTION_RE = /^Figure\s+\d+\.\d+.*?\bProblems?\s+([\d.,\sand]+)/i;

// Map "5.17" -> list of [page, x0, y0, x1, y1] crops, in reading order.
// progress(done, total) is called now and then; this yields to the browser so
// the page stays responsive while a big textbook is read.
export async function buildIndex(doc, progress) {
  const items = []; // {page, rect, text, bold} for content inside Problems sections
  const owner = []; // problem key for each item
  const bounds = [];
  let inProblems = false, chapter = null, last = 0, current = null;
  let prevHeading = null; // [page, bottom y] of the last "Problems..." heading line
  const n = doc.countPages();
  for (let pi = 0; pi < n; pi++) {
    if (pi % 25 === 0) {
      progress?.(pi, n);
      await tick();
    }
    const page = doc.loadPage(pi);
    bounds[pi] = page.getBounds();
    const its = linesAndImages(page, doc);
    page.destroy();
    for (const { rect, text, size, bold } of its) {
      const t = text.trim();
      if (size > BIG_FONT && rect[1] >= 0 && /[A-Za-z]{3}/.test(t)) {
        if (t.startsWith("Problem")) {
          const m = /Section\s+(\d+)\./i.exec(t);
          if (!inProblems || (m && m[1] !== chapter)) {
            chapter = m ? m[1] : null;
            last = 0;
          }
          inProblems = true;
          prevHeading = [pi, rect[3]];
        } else if (prevHeading && prevHeading[0] === pi && rect[1] - prevHeading[1] < 15) {
          prevHeading = [pi, rect[3]]; // second line of a wrapped "Problems for Section..." heading
        } else {
          inProblems = false;
        }
        current = null; // headings end the current problem
        continue;
      }
      if (!inProblems) continue;
      const m = text && size > 0 && rect[0] < 250 ? START_RE.exec(text) : null;
      // Problems are numbered in order, so only accept the next few numbers
      // (stops "5.51" from a wrapped "Fig. 5.51" reference counting).
      if (m && (chapter === null || m[1] === chapter) && last < +m[2] && +m[2] <= last + 3) {
        chapter = m[1];
        last = +m[2];
        current = `${chapter}.${last}`;
        // math on the same line can sort just before the number; pull it in
        let k = items.length - 1;
        while (k >= 0 && items[k].page === pi && items[k].rect[3] > rect[1] + 2) {
          owner[k] = current;
          k--;
        }
      }
      if (current) {
        items.push({ page: pi, rect, text, bold });
        owner.push(current);
      }
    }
  }
  progress?.(n, n);

  // Figures sometimes sit under a neighboring problem: move each captioned
  // figure ("Figure 5.56 ... for Problem 5.17") to the problem it names.
  const keys = new Set(owner);
  let i = 0;
  while (i < items.length) {
    const { page, text, bold } = items[i];
    const m = bold ? CAPTION_RE.exec(text) : null;
    if (m) {
      const targets = (m[1].match(/\d+\.\d+/g) || []).filter((t) => keys.has(t));
      let j = i + 1;
      while (j < items.length && items[j].page === page && !items[j].text) j++; // the images under the caption
      if (targets.length && targets[0] !== owner[i]) for (let k = i; k < j; k++) owner[k] = targets[0];
      i = j;
    } else {
      i++;
    }
  }

  // Contiguous runs of a problem's items on one page become one crop.
  const index = {};
  let prevOwner = null;
  items.forEach(({ page, rect }, k) => {
    const key = owner[k];
    const segs = (index[key] ??= []);
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg[0] === page && prevOwner === key) lastSeg[1] = union(lastSeg[1], rect);
    else segs.push([page, rect.slice()]);
    prevOwner = key;
  });
  const out = {};
  for (const [key, segs] of Object.entries(index)) {
    out[key] = segs.map(([p, r]) => [p, ...pad(r, bounds[p]).map((v) => Math.round(v * 10) / 10)]);
  }
  return out;
}

// ------------------------------------------------------------------ assignment

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refNumber = (ref) => (/^\d+$/.test(ref.number) ? +ref.number : -1);

// Find textbook references in an assignment. Returns [{prefix, key, label,
// number, block: [page, rect]}], where block is the assignment's own text for
// that item (e.g. "1. FPE 5.3  Part (a) corresponds to Rule 2..."). A numbered
// item that cites no book gets prefix null. Anything after a line containing
// "optional" is skipped.
export function findRefs(doc, prefixes) {
  if (!prefixes.length) return [];
  const refRe = new RegExp(String.raw`^\s*(?:(\d+)\s*[.)]\s*)?(` + prefixes.map(escapeRe).join("|") + String.raw`)\s*(\d+\.\d+)`);
  const itemRe = /^\s*(\d+)\s*[.)]\s+\S/; // "4. This problem builds on..."
  const refs = [];
  const bounds = [];
  let stop = false;
  for (let pi = 0; pi < doc.countPages() && !stop; pi++) {
    const page = doc.loadPage(pi);
    bounds[pi] = page.getBounds();
    const h = height(bounds[pi]);
    const lines = linesAndImages(page, doc).filter((it) => it.text);
    page.destroy();
    for (const { rect, text } of lines) {
      if (/\boptional\b/i.test(text)) {
        stop = true;
        break;
      }
      const m = refRe.exec(text);
      const n = m ? null : itemRe.exec(text);
      const last = refs[refs.length - 1];
      // A numbered item that cites no book is its own problem (assignment
      // text only), but only if it's the next number, so numbered notes
      // inside an item don't split it.
      if (n && +n[1] === (last ? refNumber(last) + 1 : 1)) {
        refs.push({ prefix: null, key: null, number: n[1], label: `Problem ${n[1]}`, block: [pi, rect.slice()] });
      } else if (m) {
        refs.push({ prefix: m[2], key: m[3], number: m[1] || String(refs.length + 1), label: `${m[2]} ${m[3]}`, block: [pi, rect.slice()] });
      } else if (last && last.block[0] === pi && !(rect[1] > h * 0.9 && FOOTER_RE.test(text))) {
        last.block[1] = union(last.block[1], rect); // notes under the reference line
      }
    }
  }
  if (!refs.some((r) => r.prefix)) return [];
  for (const r of refs) r.block[1] = pad(r.block[1], bounds[r.block[0]]);
  return refs;
}

// Book-style prefixes the assignment cites ("FPE 5.3") that aren't set up yet.
export function citedPrefixes(doc, known) {
  const counts = {};
  const re = /^\s*(?:\d+\s*[.)]\s*)?([A-Z]{2,6})\s*\d+\.\d+/;
  for (let pi = 0; pi < Math.min(doc.countPages(), 5); pi++) {
    for (const line of pageText(doc, pi).split("\n")) {
      const m = re.exec(line);
      if (m && m[1] !== "HW" && !known.includes(m[1])) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
  }
  return Object.keys(counts).filter((p) => counts[p] >= 2);
}

// Split an assignment into problems. If it cites textbook problems (e.g.
// "FPE 5.3") for a book in `books`, each one is pulled from the textbook.
// books = {prefixes: [...], get: async (prefix, progress) => {doc, index} | null}
export async function detectProblems(doc, settings, books, progress) {
  const refs = findRefs(doc, books.prefixes);
  if (refs.length) return bookProblems(doc, refs, settings.scale, books, progress);

  const headingRes = [];
  for (const p of settings.heading_patterns) {
    try {
      headingRes.push(new RegExp(String.raw`^\s*(` + p + ")", "i"));
    } catch {
      /* skip a pattern the browser can't read */
    }
  }
  const scale = settings.scale;
  const problems = [];
  let current = null; // {problem, rects: Map page -> rect}

  const finish = () => {
    if (!current) return;
    const p = current.problem;
    p.segments = [...current.rects.entries()].sort((a, b) => a[0] - b[0]).map(([page, rect]) => ({ doc, page, rect }));
    if (p.segments.length) problems.push(p);
  };

  const n = doc.countPages();
  const first = n ? doc.loadPage(0).getBounds() : null;
  for (let pi = 0; pi < n; pi++) {
    const page = doc.loadPage(pi);
    const b = page.getBounds();
    if (Math.abs(width(b) - width(first)) > 2 || Math.abs(height(b) - height(first)) > 2) {
      page.destroy();
      continue; // different page size: not part of the assignment (e.g. appended notes)
    }
    const items = pageItems(page, doc);
    page.destroy();
    for (const { rect, text } of items) {
      let m = null;
      if (text) {
        for (const rx of headingRes) {
          m = rx.exec(text);
          if (m) break;
        }
      }
      if (m) {
        finish();
        const title = m[1].replace(/\s+/g, "");
        const nums = title.match(/\d+/g) || [];
        current = { problem: new Problem(title, nums.length ? nums[nums.length - 1] : "", [], scale), rects: new Map() };
      }
      if (!current) continue; // assignment title etc. before the first problem
      const rs = current.rects;
      rs.set(pi, rs.has(pi) ? union(rs.get(pi), rect) : rect.slice());
    }
  }
  finish();

  if (!problems.length) {
    // no headings found: one problem per page
    for (let pi = 0; pi < n; pi++) {
      const page = doc.loadPage(pi);
      const items = pageItems(page, doc);
      page.destroy();
      if (items.length) {
        let r = items[0].rect.slice();
        for (const it of items.slice(1)) r = union(r, it.rect);
        problems.push(new Problem(`Page ${pi + 1}`, String(pi + 1), [{ doc, page: pi, rect: r }], scale));
      }
    }
  }

  for (const p of problems) {
    for (const s of p.segments) {
      const page = doc.loadPage(s.page);
      s.rect = pad(s.rect, page.getBounds());
      page.destroy();
    }
  }
  return problems;
}

// One problem per textbook reference: the assignment's own note for it on
// top, then the problem cropped from the textbook.
async function bookProblems(doc, refs, scale, books, progress) {
  const problems = [];
  for (const ref of refs) {
    const segs = [{ doc, page: ref.block[0], rect: ref.block[1] }];
    let title = ref.label;
    if (ref.prefix) {
      const book = await books.get(ref.prefix, progress);
      if (!book) title += "  (textbook PDF missing)";
      else if (!(ref.key in book.index)) title += "  (not found in book)";
      else for (const [page, ...r] of book.index[ref.key]) segs.push({ doc: book.doc, page, rect: r });
    }
    problems.push(new Problem(title, ref.number, segs, scale));
  }
  return problems;
}

// Guess [class, hw label] from the file name and first page text.
export function guessHeader(doc, fileName, settings) {
  const text = doc.countPages() ? pageText(doc, 0).slice(0, 1500) : "";
  let cls = settings.last_class || "";
  let m = /\b([A-Z]{2,4})[ _-]?(\d{3})\b/.exec(fileName) || /\b([A-Z]{2,4}) ?(\d{3})\b/.exec(text);
  if (m) cls = `${m[1]} ${m[2]}`;
  let hw = "";
  m = /HW[ _#-]*(\d+)/i.exec(fileName) || /Homework\s*(?:Set|Assignment)?\s*#?\s*(\d+)/i.exec(text);
  if (m) hw = `HW-${parseInt(m[1], 10)}`;
  return [cls, hw];
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

// ------------------------------------------------------------------ layout

// Place a problem's segments on paper. Returns a list of output pages, each a
// list of {doc, page, src, dest}.
export function layout(problem) {
  const top = HEADER_BOTTOM + MARGIN;
  const bottom = PAGE_H - MARGIN;
  const left = GRID_LEFT + MARGIN;
  const maxW = GRID_RIGHT - MARGIN - left;
  const pages = [];
  let cur = [], y = top;
  for (const { doc, page, rect: src } of problem.segments) {
    let s = problem.scale;
    let w = width(src) * s, h = height(src) * s;
    if (w > maxW) {
      // never run past the right edge of the grid
      s = maxW / width(src);
      w = width(src) * s;
      h = height(src) * s;
    }
    if (h > bottom - top) {
      // taller than a whole page: shrink to fit
      s = (bottom - top) / height(src);
      w = width(src) * s;
      h = height(src) * s;
    }
    if (cur.length && y + h > bottom) {
      pages.push(cur);
      cur = [];
      y = top;
    }
    cur.push({ doc, page, src, dest: [left, y, left + w, y + h] });
    y += h + SEG_GAP;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

// ------------------------------------------------------------------ PDF output

const num = (v) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === "-0" ? "0" : s;
};
const rgb = (c) => c.map(num).join(" ");

// a then b (PDF/MuPDF row-vector convention)
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

let helvetica = null;
function textWidth(text, size) {
  helvetica ??= new mupdf.Font("Helvetica");
  let w = 0;
  for (const ch of text) w += helvetica.advanceGlyph(helvetica.encodeCharacter(ch));
  return w * size;
}

// PDF string in WinAnsi (Latin-1 for the common characters).
function pdfString(text) {
  let s = "(";
  for (const ch of text) {
    let c = ch.codePointAt(0);
    if (c > 255) c = 63; // "?"
    if (c === 40 || c === 41 || c === 92) s += "\\" + ch;
    else if (c < 32 || c > 126) s += "\\" + c.toString(8).padStart(3, "0");
    else s += ch;
  }
  return s + ")";
}

// Output document with source pages pasted as vector Form XObjects (like
// PyMuPDF's show_pdf_page), so text stays sharp at any zoom.
class OutPDF {
  constructor() {
    this.doc = new mupdf.PDFDocument();
    this.grafts = new Map(); // source doc -> graft map (copies shared fonts/images once)
    this.forms = new Map(); // source doc -> Map(page -> {ref, xf})
    this.font = null;
  }

  helv() {
    if (!this.font) {
      const d = this.doc;
      const f = d.newDictionary();
      f.put("Type", d.newName("Font"));
      f.put("Subtype", d.newName("Type1"));
      f.put("BaseFont", d.newName("Helvetica"));
      f.put("Encoding", d.newName("WinAnsiEncoding"));
      this.font = d.addObject(f);
    }
    return this.font;
  }

  // The whole source page as a Form XObject, made once per page.
  form(src, pi) {
    let m = this.forms.get(src);
    if (!m) this.forms.set(src, (m = new Map()));
    if (m.has(pi)) return m.get(pi);
    const pdf = src.asPDF();
    const pageObj = pdf.findPage(pi);
    const page = pdf.loadPage(pi);
    const xf = page.getTransform(); // PDF user space -> page coordinates
    page.destroy();
    const buf = new mupdf.Buffer();
    const contents = pageObj.get("Contents");
    if (contents.isArray()) {
      for (let k = 0; k < contents.length; k++) {
        const s = contents.get(k);
        if (s.isStream()) {
          buf.writeBuffer(s.readStream());
          buf.writeByte(10);
        }
      }
    } else if (contents.isStream()) {
      buf.writeBuffer(contents.readStream());
    }
    const d = this.doc;
    const dict = d.newDictionary();
    dict.put("Type", d.newName("XObject"));
    dict.put("Subtype", d.newName("Form"));
    const mb = pageObj.getInheritable("MediaBox");
    const bbox = d.newArray();
    for (let k = 0; k < 4; k++) bbox.push(d.newReal(mb.get(k).asNumber()));
    dict.put("BBox", bbox);
    const res = pageObj.getInheritable("Resources");
    let graft = this.grafts.get(src);
    if (!graft) this.grafts.set(src, (graft = d.newGraftMap()));
    dict.put("Resources", res.isNull() ? d.newDictionary() : graft.graftObject(res));
    const f = { ref: d.addStream(buf, dict), xf };
    m.set(pi, f);
    return f;
  }

  page(w, h) {
    return new PageBuilder(this, w, h);
  }

  save() {
    return this.doc.saveToBuffer("garbage=compact,compress=yes").asUint8Array();
  }

  destroy() {
    this.doc.destroy();
  }
}

class PageBuilder {
  constructor(out, w, h) {
    this.out = out;
    this.w = w;
    this.h = h;
    this.ops = [];
    this.xobjs = [];
    this.usesFont = false;
  }

  // rect in page coordinates -> "x y w h" in PDF user space
  box(r) {
    return `${num(r[0])} ${num(this.h - r[3])} ${num(r[2] - r[0])} ${num(r[3] - r[1])}`;
  }

  lines(segs, color, lineWidth) {
    if (!segs.length) return;
    const o = [`q ${rgb(color)} RG ${num(lineWidth)} w`];
    for (const [x0, y0, x1, y1] of segs) o.push(`${num(x0)} ${num(this.h - y0)} m ${num(x1)} ${num(this.h - y1)} l`);
    o.push("S Q");
    this.ops.push(o.join("\n"));
  }

  circles(centers, r, color, lineWidth) {
    const k = 0.5522847498 * r;
    const o = [`q ${rgb(color)} RG ${num(lineWidth)} w`];
    for (const [cx, cyTop] of centers) {
      const cy = this.h - cyTop;
      const c = (...v) => v.map(num).join(" ");
      o.push(`${c(cx + r, cy)} m`);
      o.push(`${c(cx + r, cy + k, cx + k, cy + r, cx, cy + r)} c`);
      o.push(`${c(cx - k, cy + r, cx - r, cy + k, cx - r, cy)} c`);
      o.push(`${c(cx - r, cy - k, cx - k, cy - r, cx, cy - r)} c`);
      o.push(`${c(cx + k, cy - r, cx + r, cy - k, cx + r, cy)} c h`);
    }
    o.push("S Q");
    this.ops.push(o.join("\n"));
  }

  text(x, baseline, text, size) {
    this.usesFont = true;
    this.ops.push(`BT 0 g /F1 ${num(size)} Tf ${num(x)} ${num(this.h - baseline)} Td ${pdfString(text)} Tj ET`);
  }

  // Paste the src rect of a source page into dest (both in page coordinates).
  paste(srcDoc, pi, src, dest, frame) {
    if (frame) this.ops.push(`q 0.78 0.78 0.78 RG 1 1 1 rg 0.6 w ${this.box(dest)} re B Q`);
    const f = this.out.form(srcDoc, pi);
    let k = this.xobjs.indexOf(f.ref);
    if (k < 0) {
      k = this.xobjs.length;
      this.xobjs.push(f.ref);
    }
    const sx = width(dest) / width(src), sy = height(dest) / height(src);
    const S = [sx, 0, 0, sy, dest[0] - src[0] * sx, dest[1] - src[1] * sy];
    const M = mul(mul(f.xf, S), [1, 0, 0, -1, 0, this.h]);
    this.ops.push(`q ${this.box(dest)} re W n ${M.map(num).join(" ")} cm /X${k} Do Q`);
  }

  finish() {
    const d = this.out.doc;
    const res = d.newDictionary();
    if (this.usesFont) {
      const fonts = d.newDictionary();
      fonts.put("F1", this.out.helv());
      res.put("Font", fonts);
    }
    if (this.xobjs.length) {
      const x = d.newDictionary();
      this.xobjs.forEach((ref, k) => x.put(`X${k}`, ref));
      res.put("XObject", x);
    }
    const pageObj = d.addPage([0, 0, this.w, this.h], 0, res, this.ops.join("\n"));
    d.insertPage(-1, pageObj);
  }
}

function drawHeader(pg, name, cls, hwLabel, date) {
  const centered = (text, box, size, yMid) => {
    if (!text) return;
    let w = textWidth(text, size);
    while (w > box[1] - box[0] - 6 && size > 6) {
      size -= 0.5;
      w = textWidth(text, size);
    }
    pg.text((box[0] + box[1] - w) / 2, yMid + size * 0.35, text, size);
  };
  const mid = HEADER_BOTTOM / 2;
  centered(name, BOX_NAME, 15, mid);
  if (cls && hwLabel) {
    centered(cls, BOX_CLASS, 12, mid - 7);
    centered(hwLabel, BOX_CLASS, 12, mid + 8);
  } else {
    centered(cls || hwLabel, BOX_CLASS, 13, mid);
  }
  centered(date, BOX_DATE, 15, mid);
}

// The engineering paper as vector lines (positions measured from paper.png).
function drawPaper(pg) {
  const xs = [], ys = [];
  for (let i = 1; i < 35; i++) xs.push(GRID_LEFT + i * CELL);
  const rows = Math.floor((PAGE_H - HEADER_BOTTOM) / CELL);
  for (let i = 1; i <= rows; i++) ys.push(HEADER_BOTTOM + i * CELL);
  const vert = (ps) => ps.map((x) => [x, HEADER_BOTTOM, x, PAGE_H]);
  const horiz = (ps) => ps.map((y) => [GRID_LEFT, y, GRID_RIGHT, y]);
  const minor = (ps) => ps.filter((_, i) => (i + 1) % 5);
  const major = (ps) => ps.filter((_, i) => (i + 1) % 5 === 0);
  pg.lines(vert(minor(xs)), GRID_MINOR, 0.25);
  pg.lines(horiz(minor(ys)), GRID_MINOR, 0.25);
  pg.lines(vert(major(xs)), GRID_MAJOR, 0.5);
  pg.lines(horiz(major(ys)), GRID_MAJOR, 0.5);
  const green = [[0, HEADER_BOTTOM, PAGE_W, HEADER_BOTTOM]];
  for (const x of [GRID_LEFT, GRID_RIGHT]) green.push([x, 0, x, PAGE_H]);
  for (const x of [BOX_CLASS[0], BOX_DATE[0]]) green.push([x, 0, x, HEADER_BOTTOM]);
  pg.lines(green, GREEN, 0.6);
  pg.circles([227, 1000, 1773].map((cy) => [68 * PX, cy * PX]), 28.5 * PX, GREEN, 0.6);
}

// header: {name, cls, hw, date, problem_in_header}. Returns an OutPDF; call
// .save() for the bytes and .destroy() when done.
export function buildPdf(problems, header) {
  const out = new OutPDF();
  for (const prob of problems) {
    let hwLabel = header.hw;
    if (header.problem_in_header && prob.number) hwLabel = `${hwLabel} P${prob.number}`.trim();
    for (const placed of layout(prob)) {
      const pg = out.page(PAGE_W, PAGE_H);
      drawPaper(pg);
      drawHeader(pg, header.name, header.cls, hwLabel, header.date);
      for (const { doc, page, src, dest } of placed) pg.paste(doc, page, src, dest, true);
      pg.finish();
    }
  }
  return out;
}

// One PNG of the whole problem (segments stacked) for inserting as a picture.
export function problemPng(problem, dpi) {
  const w = Math.max(...problem.segments.map((s) => width(s.rect)));
  const h = problem.segments.reduce((t, s) => t + height(s.rect), 0) + SEG_GAP * (problem.segments.length - 1);
  const out = new OutPDF();
  const pg = out.page(w, h);
  let y = 0;
  for (const { doc, page, rect } of problem.segments) {
    pg.paste(doc, page, rect, [0, y, width(rect), y + height(rect)], false);
    y += height(rect) + SEG_GAP;
  }
  pg.finish();
  const page = out.doc.loadPage(0);
  const z = dpi / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(z, z), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG().slice();
  pix.destroy();
  page.destroy();
  out.destroy();
  return png;
}

export function openPdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    doc.destroy();
    throw new Error("This PDF is password-protected.");
  }
  if (!doc.isPDF()) {
    doc.destroy();
    throw new Error("Not a PDF file.");
  }
  return doc;
}
