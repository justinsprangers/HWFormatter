// HW Formatter (web): the page. Problem detection and PDF building live in
// core.js (loaded after the page so a slow connection still shows the UI).

import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const el = {
  status: $("status"), banner: $("banner"),
  openLbl: $("openLbl"), openInput: $("openInput"), fileName: $("fileName"),
  name: $("fName"), cls: $("fCls"), hw: $("fHw"), date: $("fDate"), pnum: $("fPnum"),
  exportPdf: $("exportPdf"), exportZip: $("exportZip"), settingsBtn: $("settingsBtn"), helpBtn: $("helpBtn"),
  list: $("list"), moveUp: $("moveUp"), moveDown: $("moveDown"), merge: $("merge"), del: $("del"), pngOne: $("pngOne"),
  scale: $("scale"), scaleLbl: $("scaleLbl"), scaleAll: $("scaleAll"),
  boxReplace: $("boxReplace"), boxAdd: $("boxAdd"), boxNew: $("boxNew"),
  prevPage: $("prevPage"), nextPage: $("nextPage"), pageLbl: $("pageLbl"),
  srcWrap: $("srcWrap"), srcCanvas: $("srcCanvas"), srcOverlay: $("srcOverlay"), srcEmpty: $("srcEmpty"),
  outWrap: $("outWrap"), outCanvas: $("outCanvas"), outEmpty: $("outEmpty"), outLbl: $("outLbl"),
  settingsDlg: $("settingsDlg"), helpDlg: $("helpDlg"), bookRows: $("bookRows"),
  bkPrefix: $("bkPrefix"), bkTitle: $("bkTitle"), bkFile: $("bkFile"),
  headings: $("headings"), dpi: $("dpi"), resetSettings: $("resetSettings"),
};

let core = null; // core.js, once loaded
const st = {
  settings: store.loadSettings(),
  doc: null, // the assignment (MuPDF document)
  fileName: "",
  problems: [],
  cur: -1, // selected problem
  srcPage: 0, // page shown on the left
  bounds: [0, 0, 612, 792], // that page's bounds
  zoom: 1, // CSS px per PDF point on the left
  drawn: null, // box the user drew: {doc, page, rect}
};
let books = []; // saved textbooks (records from IndexedDB)
const openBooks = new Map(); // prefix -> {doc, index}
const sessionFiles = new Map(); // prefix -> File the browser couldn't save
const dismissed = new Set(); // banner messages closed for this file
let drag = null; // [x0, y0, x1, y1] while dragging a box

const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const errText = (e) => (e && e.message) || String(e);

function status(msg, error = false) {
  el.status.textContent = msg || "";
  el.status.hidden = !msg;
  el.status.classList.toggle("error", !!error);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

// ------------------------------------------------------------------ textbooks

const bookAccess = {
  get prefixes() {
    return books.map((b) => b.prefix);
  },
  async get(prefix) {
    if (openBooks.has(prefix)) return openBooks.get(prefix);
    const rec = books.find((b) => b.prefix === prefix);
    const file = sessionFiles.get(prefix) || rec?.blob;
    if (!rec || !file) return null;
    let doc;
    try {
      doc = core.openPdf(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      status(`Couldn't open the ${prefix} textbook: ${errText(e)}`, true);
      return null;
    }
    const tag = store.bookTag(rec);
    let index = await store.getIndex(tag);
    if (!index) {
      index = await core.buildIndex(doc, (done, total) =>
        status(`Indexing the ${prefix} textbook (one time): ${Math.floor((100 * done) / total)}%`));
      await store.putIndex(tag, index);
    }
    const b = { doc, index };
    openBooks.set(prefix, b);
    return b;
  },
};

async function saveBook(prefix, title, file) {
  const rec = { prefix, title: title || prefix, fileName: file.name, size: file.size, lastModified: file.lastModified, blob: file };
  const saved = await store.putBook(rec);
  if (saved) sessionFiles.delete(prefix);
  else sessionFiles.set(prefix, file);
  openBooks.delete(prefix);
  books = await store.listBooks();
  store.persist();
  renderBooks();
  const b = await bookAccess.get(prefix);
  if (!b) return;
  const n = Object.keys(b.index).length;
  status(n
    ? `${prefix} textbook ready: ${n} problems found.` + (saved ? "" : " The browser couldn't save the PDF, so it works until you close this page.")
    : `No problems were found in that PDF. It needs selectable text and "Problems" headings (see Help).`, !n);
  renderBooks();
  if (st.doc) await detect();
}

async function removeBook(prefix) {
  if (!confirm(`Remove the ${prefix} textbook from this browser?`)) return;
  await store.deleteBook(prefix);
  openBooks.delete(prefix);
  sessionFiles.delete(prefix);
  books = await store.listBooks();
  renderBooks();
  if (st.doc) await detect();
}

function pickFile(onPick) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.onchange = () => input.files[0] && onPick(input.files[0]);
  input.click();
}

function chooseBookFile(prefix) {
  const rec = books.find((b) => b.prefix === prefix);
  pickFile((f) => saveBook(prefix, rec?.title || prefix, f));
}

function renderBooks() {
  el.bookRows.replaceChildren(
    ...books.map((b) => {
      const tr = document.createElement("tr");
      const td = (text, cls) => {
        const c = document.createElement("td");
        if (cls) c.className = cls;
        c.textContent = text;
        tr.append(c);
        return c;
      };
      td(b.prefix);
      td(b.title || "");
      const here = b.blob || sessionFiles.has(b.prefix);
      td(`${b.fileName} (${(b.size / 1e6).toFixed(1)} MB)` + (here ? "" : " — not on this device, choose it again"), "file");
      const act = td("", "act");
      const rep = document.createElement("button");
      rep.type = "button";
      rep.textContent = here ? "Replace PDF" : "Choose PDF";
      rep.onclick = () => chooseBookFile(b.prefix);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Remove";
      rm.onclick = () => removeBook(b.prefix);
      act.append(rep, " ", rm);
      return tr;
    }),
  );
}

// ------------------------------------------------------------------ opening a PDF

async function openFile(file) {
  if (!core || !file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    status(`${file.name} isn't a PDF.`, true);
    return;
  }
  let doc;
  try {
    doc = core.openPdf(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    status(`Couldn't open the PDF: ${errText(e)}`, true);
    return;
  }
  const old = st.doc;
  st.doc = doc;
  st.fileName = file.name;
  st.problems = [];
  st.cur = -1;
  st.srcPage = 0;
  dismissed.clear();
  old?.destroy();
  el.fileName.textContent = file.name;
  el.fileName.title = file.name;
  const [cls, hw] = core.guessHeader(doc, file.name, st.settings);
  el.cls.value = cls;
  el.hw.value = hw;
  await detect();
}

async function detect() {
  status("Reading problems…");
  await nextFrame();
  let ok = true;
  try {
    st.problems = await core.detectProblems(st.doc, st.settings, bookAccess);
  } catch (e) {
    console.error(e);
    st.problems = [];
    status(`Couldn't read the problems: ${errText(e)}`, true);
    ok = false;
  }
  if (ok) status(st.problems.length ? "" : "No problems found. Drag a box on the page, then click New problem from box.");
  updateBanner();
  select(0);
}

function updateBanner() {
  const items = [];
  if (st.doc) {
    const missing = new Set(st.problems.filter((p) => p.title.includes("(textbook PDF missing)")).map((p) => p.title.split(" ")[0]));
    for (const p of missing) {
      items.push({ key: `missing:${p}`, text: `The ${p} textbook PDF isn't in this browser, so its problems are missing.`, label: `Choose ${p} PDF…`, act: () => chooseBookFile(p) });
    }
    for (const p of core.citedPrefixes(st.doc, bookAccess.prefixes)) {
      items.push({ key: `cited:${p}`, text: `This assignment cites ${p} textbook problems. Add the textbook to pull each one in.`, label: `Add the ${p} textbook…`, act: () => openSettings(p) });
    }
  }
  const item = items.find((i) => !dismissed.has(i.key));
  el.banner.hidden = !item;
  if (!item) return;
  const msg = document.createElement("span");
  msg.textContent = item.text;
  const go = document.createElement("button");
  go.className = "primary";
  go.textContent = item.label;
  go.onclick = item.act;
  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.setAttribute("aria-label", "Dismiss");
  x.onclick = () => {
    dismissed.add(item.key);
    updateBanner();
  };
  el.banner.replaceChildren(msg, go, x);
}

// ------------------------------------------------------------------ problem list

function refreshList() {
  el.list.replaceChildren(
    ...st.problems.map((p, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const pages = core.layout(p).length;
      b.textContent = p.title + (pages > 1 ? `  (${pages} pages)` : "");
      if (i === st.cur) {
        b.className = "sel";
        b.setAttribute("aria-current", "true");
      }
      b.onclick = () => select(i);
      li.append(b);
      return li;
    }),
  );
  el.list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function select(i) {
  st.cur = st.problems.length ? clamp(i, 0, st.problems.length - 1) : -1;
  const p = st.problems[st.cur];
  if (p) {
    el.scale.value = Math.round(p.scale * 100);
    el.scaleLbl.textContent = `${Math.round(p.scale * 100)}%`;
  } else {
    el.scaleLbl.textContent = "";
  }
  refreshList();
  const own = p ? p.segments.filter((s) => s.doc === st.doc).map((s) => s.page) : [];
  showSrc(own.length ? own[0] : st.srcPage);
  refreshOutput();
}

function move(d) {
  const i = st.cur;
  if (i < 0 || i + d < 0 || i + d >= st.problems.length) return;
  [st.problems[i], st.problems[i + d]] = [st.problems[i + d], st.problems[i]];
  select(i + d);
}

function mergeNext() {
  const i = st.cur;
  if (i < 0 || i + 1 >= st.problems.length) return;
  st.problems[i].segments.push(...st.problems.splice(i + 1, 1)[0].segments);
  select(i);
}

function deleteProblem() {
  if (st.cur < 0) return;
  st.problems.splice(st.cur, 1);
  select(st.cur);
}

function scaleChanged() {
  const p = st.problems[st.cur];
  if (!p) return;
  p.scale = Math.round(+el.scale.value) / 100;
  el.scaleLbl.textContent = `${Math.round(p.scale * 100)}%`;
  refreshList();
  refreshOutput();
}

function scaleAll() {
  const s = Math.round(+el.scale.value) / 100;
  for (const p of st.problems) p.scale = s;
  refreshList();
  refreshOutput();
}

function boxReplace() {
  const p = st.problems[st.cur];
  if (!p || !st.drawn) return;
  p.segments = [st.drawn];
  select(st.cur);
}

function boxAdd() {
  const p = st.problems[st.cur];
  if (!p || !st.drawn) return;
  p.segments.push(st.drawn);
  select(st.cur);
}

function boxNew() {
  if (!st.drawn) return;
  const base = st.problems[st.cur];
  const p = new core.Problem(base ? `${base.title} (part)` : "Problem", base ? base.number : "", [st.drawn], base ? base.scale : st.settings.scale);
  const at = st.cur + 1;
  st.problems.splice(at, 0, p);
  select(at);
}

function enable() {
  const n = st.problems.length, i = st.cur, has = i >= 0;
  el.exportPdf.disabled = el.exportZip.disabled = el.pngOne.disabled = !has;
  el.moveUp.disabled = !has || i === 0;
  el.moveDown.disabled = el.merge.disabled = !has || i >= n - 1;
  el.del.disabled = el.scale.disabled = el.scaleAll.disabled = !has;
  el.boxReplace.disabled = el.boxAdd.disabled = !has || !st.drawn;
  el.boxNew.disabled = !st.drawn;
}

// ------------------------------------------------------------------ drawing pages

// CSS width for a page in a column: the column width, but on wide screens
// no taller than the window.
function fitWidth(wrap, b) {
  const avail = wrap.clientWidth || 400;
  const pw = b[2] - b[0], ph = b[3] - b[1];
  if (window.innerWidth > 640) return Math.min(avail, (Math.max(360, window.innerHeight - 110) * pw) / ph);
  return avail;
}

function drawPage(canvas, page, zoom) {
  const M = core.mupdf;
  const dpr = window.devicePixelRatio || 1;
  const z = zoom * dpr;
  const pix = page.toPixmap(M.Matrix.scale(z, z), M.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), n = stride / w;
  const src = pix.getPixels();
  const img = new ImageData(w, h);
  const dst = img.data;
  for (let y = 0; y < h; y++) {
    let si = y * stride, di = y * w * 4;
    for (let x = 0; x < w; x++, si += n, di += 4) {
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
  pix.destroy();
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w / dpr}px`;
  canvas.style.height = `${h / dpr}px`;
  canvas.getContext("2d").putImageData(img, 0, 0);
}

function clearCanvas(canvas) {
  canvas.removeAttribute("width");
  canvas.removeAttribute("height");
  canvas.style.width = canvas.style.height = "";
}

function showSrc(n, keepDrawn = false) {
  if (!keepDrawn) st.drawn = null;
  drag = null;
  if (!st.doc) {
    clearCanvas(el.srcCanvas);
    clearCanvas(el.srcOverlay);
    el.srcEmpty.hidden = false;
    el.pageLbl.textContent = "Original";
    el.prevPage.disabled = el.nextPage.disabled = true;
    enable();
    return;
  }
  const count = st.doc.countPages();
  n = clamp(n, 0, count - 1);
  st.srcPage = n;
  const page = st.doc.loadPage(n);
  st.bounds = page.getBounds();
  st.zoom = fitWidth(el.srcWrap, st.bounds) / (st.bounds[2] - st.bounds[0]);
  drawPage(el.srcCanvas, page, st.zoom);
  page.destroy();
  const o = el.srcOverlay;
  o.width = el.srcCanvas.width;
  o.height = el.srcCanvas.height;
  o.style.width = el.srcCanvas.style.width;
  o.style.height = el.srcCanvas.style.height;
  el.srcEmpty.hidden = true;
  el.pageLbl.textContent = `Original — page ${n + 1} / ${count}`;
  el.prevPage.disabled = n <= 0;
  el.nextPage.disabled = n >= count - 1;
  drawOverlay();
  enable();
}

const normRect = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

function drawOverlay() {
  const o = el.srcOverlay;
  if (!o.hasAttribute("width")) return;
  const ctx = o.getContext("2d");
  const k = (o.width / parseFloat(o.style.width)) * st.zoom; // device px per PDF point
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  ctx.setTransform(k, 0, 0, k, -st.bounds[0] * k, -st.bounds[1] * k);
  const box = (r, color, w, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w / st.zoom;
    ctx.setLineDash(dash ? [4 / st.zoom, 2 / st.zoom] : []);
    ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  };
  st.problems.forEach((p, i) => {
    for (const s of p.segments) {
      if (s.doc === st.doc && s.page === st.srcPage) box(s.rect, i === st.cur ? "#d22" : "#69c", i === st.cur ? 2 : 1);
    }
  });
  const r = drag ? normRect(drag) : st.drawn && st.drawn.page === st.srcPage ? st.drawn.rect : null;
  if (r) box(r, "#2a2", 2, true);
}

function toPdf(e) {
  const r = el.srcOverlay.getBoundingClientRect();
  const b = st.bounds;
  return [clamp(b[0] + (e.clientX - r.left) / st.zoom, b[0], b[2]), clamp(b[1] + (e.clientY - r.top) / st.zoom, b[1], b[3])];
}

el.srcOverlay.addEventListener("pointerdown", (e) => {
  if (!st.doc || e.button > 0) return;
  e.preventDefault();
  el.srcOverlay.setPointerCapture(e.pointerId);
  const p = toPdf(e);
  drag = [p[0], p[1], p[0], p[1]];
  st.drawn = null;
  drawOverlay();
  enable();
});
el.srcOverlay.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = toPdf(e);
  drag[2] = p[0];
  drag[3] = p[1];
  drawOverlay();
});
const endDrag = () => {
  if (!drag) return;
  const r = normRect(drag);
  drag = null;
  const big = (r[2] - r[0]) * st.zoom >= 8 && (r[3] - r[1]) * st.zoom >= 8;
  st.drawn = big ? { doc: st.doc, page: st.srcPage, rect: r } : null;
  drawOverlay();
  enable();
};
el.srcOverlay.addEventListener("pointerup", endDrag);
el.srcOverlay.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------ output preview

const header = () => ({
  name: el.name.value.trim(),
  cls: el.cls.value.trim(),
  hw: el.hw.value.trim(),
  date: el.date.value.trim(),
  problem_in_header: el.pnum.checked,
});

let outQueued = false;
function refreshOutput() {
  if (outQueued) return;
  outQueued = true;
  setTimeout(() => {
    outQueued = false;
    renderOutput();
  }, 0);
}

function renderOutput() {
  const p = st.problems[st.cur];
  if (!core || !st.doc || !p) {
    clearCanvas(el.outCanvas);
    el.outEmpty.hidden = false;
    el.outLbl.textContent = "Output preview";
    return;
  }
  let out = null;
  try {
    out = core.buildPdf([p], header());
    const n = out.doc.countPages();
    const page = out.doc.loadPage(0);
    drawPage(el.outCanvas, page, fitWidth(el.outWrap, [0, 0, core.PAGE_W, core.PAGE_H]) / core.PAGE_W);
    page.destroy();
    el.outEmpty.hidden = true;
    el.outLbl.textContent = `Output preview: ${p.title}` + (n > 1 ? ` (+${n - 1} more page${n > 2 ? "s" : ""})` : "");
  } catch (e) {
    console.error(e);
    status(`Couldn't draw the preview: ${errText(e)}`, true);
  } finally {
    out?.destroy();
  }
}

// ------------------------------------------------------------------ export

const baseName = () => st.fileName.replace(/\.pdf$/i, "") || "homework";
const pngName = (p, i) => `${String(i + 1).padStart(2, "0")}_${p.title.replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "") || `problem${i + 1}`}.png`;

function rememberSettings() {
  const h = header();
  Object.assign(st.settings, {
    name: h.name,
    last_class: h.cls,
    problem_in_header: h.problem_in_header,
    scale: st.problems[0]?.scale ?? st.settings.scale,
  });
  store.saveSettings(st.settings);
}

async function exportPdf() {
  if (!st.problems.length) return;
  status("Building the PDF…");
  await nextFrame();
  let out = null;
  try {
    out = core.buildPdf(st.problems, header());
    const name = `${baseName()}_formatted.pdf`;
    store.download(new Blob([out.save()], { type: "application/pdf" }), name);
    status(`Saved ${name} (check your downloads).`);
    rememberSettings();
  } catch (e) {
    console.error(e);
    status(`Export failed: ${errText(e)}`, true);
  } finally {
    out?.destroy();
  }
}

async function exportZip() {
  if (!st.problems.length) return;
  try {
    const files = [];
    for (let i = 0; i < st.problems.length; i++) {
      status(`Making pictures: ${i + 1} / ${st.problems.length}`);
      await nextFrame();
      files.push({ name: pngName(st.problems[i], i), data: core.problemPng(st.problems[i], st.settings.png_dpi) });
    }
    const name = `${baseName()}_problems.zip`;
    store.download(store.makeZip(files), name);
    status(`Saved ${name} (check your downloads).`);
    rememberSettings();
  } catch (e) {
    console.error(e);
    status(`Couldn't make the pictures: ${errText(e)}`, true);
  }
}

function savePngOne() {
  const p = st.problems[st.cur];
  if (!p) return;
  try {
    store.download(new Blob([core.problemPng(p, st.settings.png_dpi)], { type: "image/png" }), pngName(p, st.cur));
  } catch (e) {
    status(`Couldn't make the picture: ${errText(e)}`, true);
  }
}

// ------------------------------------------------------------------ settings dialog

function fillFields() {
  el.name.value = st.settings.name || "";
  el.pnum.checked = !!st.settings.problem_in_header;
  el.headings.value = st.settings.heading_patterns.join("\n");
  el.dpi.value = st.settings.png_dpi;
}

function openSettings(prefix) {
  renderBooks();
  fillFields();
  if (prefix) el.bkPrefix.value = prefix;
  el.settingsDlg.showModal();
}

el.bkFile.addEventListener("change", () => {
  const f = el.bkFile.files[0];
  el.bkFile.value = "";
  if (!f) return;
  const prefix = el.bkPrefix.value.trim();
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(prefix)) {
    alert("Enter the prefix your class uses first (letters, like FPE).");
    return;
  }
  saveBook(prefix, el.bkTitle.value.trim(), f);
  el.bkTitle.value = "";
});

el.headings.addEventListener("change", () => {
  const lines = el.headings.value.split("\n").map((s) => s.trim()).filter(Boolean);
  const bad = lines.filter((l) => {
    try {
      new RegExp(l);
      return false;
    } catch {
      return true;
    }
  });
  st.settings.heading_patterns = lines.length ? lines : structuredClone(store.DEFAULT_SETTINGS.heading_patterns);
  store.saveSettings(st.settings);
  status(bad.length ? `Not a valid pattern (ignored): ${bad.join("  ")}` : "Headings saved. They're used the next time you open a PDF.", !!bad.length);
});

el.dpi.addEventListener("change", () => {
  st.settings.png_dpi = clamp(Math.round(+el.dpi.value) || 200, 72, 600);
  el.dpi.value = st.settings.png_dpi;
  store.saveSettings(st.settings);
});

el.resetSettings.addEventListener("click", () => {
  if (!confirm("Reset your name, problem size, headings and PNG resolution to the defaults? Textbooks are kept.")) return;
  st.settings = structuredClone(store.DEFAULT_SETTINGS);
  store.saveSettings(st.settings);
  fillFields();
  refreshOutput();
});

// ------------------------------------------------------------------ wiring

el.openInput.addEventListener("change", () => {
  const f = el.openInput.files[0];
  el.openInput.value = "";
  openFile(f);
});
for (const k of ["name", "cls", "hw", "date"]) el[k].addEventListener("input", refreshOutput);
el.name.addEventListener("change", () => {
  st.settings.name = el.name.value.trim();
  store.saveSettings(st.settings);
});
el.pnum.addEventListener("change", () => {
  st.settings.problem_in_header = el.pnum.checked;
  store.saveSettings(st.settings);
  refreshOutput();
});
el.exportPdf.onclick = exportPdf;
el.exportZip.onclick = exportZip;
el.pngOne.onclick = savePngOne;
el.settingsBtn.onclick = () => openSettings();
el.helpBtn.onclick = () => el.helpDlg.showModal();
el.moveUp.onclick = () => move(-1);
el.moveDown.onclick = () => move(1);
el.merge.onclick = mergeNext;
el.del.onclick = deleteProblem;
el.scale.addEventListener("input", scaleChanged);
el.scaleAll.onclick = scaleAll;
el.boxReplace.onclick = boxReplace;
el.boxAdd.onclick = boxAdd;
el.boxNew.onclick = boxNew;
el.prevPage.onclick = () => showSrc(st.srcPage - 1);
el.nextPage.onclick = () => showSrc(st.srcPage + 1);

window.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  document.body.classList.remove("dragging");
  openFile(e.dataTransfer.files[0]);
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!st.doc) return;
    showSrc(st.srcPage, true);
    refreshOutput();
  }, 150);
});

async function init() {
  fillFields();
  el.date.value = today();
  try {
    core = await import("./core.js");
  } catch (e) {
    console.error(e);
    status("Couldn't load the PDF engine. It downloads the first time you use the page, so check your internet connection and reload.", true);
    return;
  }
  books = await store.listBooks().catch(() => []);
  el.openInput.disabled = false;
  el.openLbl.removeAttribute("aria-disabled");
  status("");
}

init();
