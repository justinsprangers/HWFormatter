// HW Formatter (web): settings, textbooks saved in this browser, and file
// downloads. Nothing here leaves the device.

// ------------------------------------------------------------------ settings

export const DEFAULT_SETTINGS = {
  name: "",
  last_class: "",
  scale: 0.75, // problem size on the paper (1.0 = original size)
  problem_in_header: true, // adds "P1", "P2", ... after the HW label
  png_dpi: 200,
  // A line that starts with one of these begins a new problem (regular expressions).
  heading_patterns: [
    String.raw`HW\s*#?\s*\d+\s*\.\s*\d+`,
    String.raw`(?:Problem|Prob\.|Question)\s*#?\s*\d+(?:\s*[.\-]\s*\d+)?`,
  ],
};

const SETTINGS_KEY = "hwformatter.settings.v1";

export function loadSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  try {
    Object.assign(s, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch {
    /* private window or blocked storage: use defaults */
  }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* not saved; still works for this visit */
  }
}

// ------------------------------------------------------------------ textbooks (IndexedDB)
// books:   {prefix, title, fileName, size, lastModified, blob?}
// indexes: {tag, problems}  (tag = file name | size | last modified)

const memory = { books: new Map(), indexes: new Map() }; // fallback when IndexedDB is unavailable
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open("hwformatter", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("books", { keyPath: "prefix" });
        req.result.createObjectStore("indexes", { keyPath: "tag" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  if (!d) return fn(null, memory[store]);
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store), null);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const bookTag = (b) => `${b.fileName}|${b.size}|${b.lastModified}`;

export async function listBooks() {
  const all = await run("books", "readonly", (s, mem) => (s ? s.getAll() : { result: [...mem.values()] }));
  return (all || []).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// Saves the record; if the browser refuses the PDF itself (storage full),
// saves it without the file and returns false.
export async function putBook(rec) {
  try {
    await run("books", "readwrite", (s, mem) => (s ? s.put(rec) : mem.set(rec.prefix, rec)));
    return true;
  } catch {
    const { blob, ...meta } = rec;
    await run("books", "readwrite", (s, mem) => (s ? s.put(meta) : mem.set(meta.prefix, meta)));
    return false;
  }
}

export async function deleteBook(prefix) {
  const all = await listBooks();
  const rec = all.find((b) => b.prefix === prefix);
  await run("books", "readwrite", (s, mem) => (s ? s.delete(prefix) : mem.delete(prefix)));
  if (rec && !all.some((b) => b.prefix !== prefix && bookTag(b) === bookTag(rec))) {
    await run("indexes", "readwrite", (s, mem) => (s ? s.delete(bookTag(rec)) : mem.delete(bookTag(rec))));
  }
}

export async function getIndex(tag) {
  try {
    const rec = await run("indexes", "readonly", (s, mem) => (s ? s.get(tag) : { result: mem.get(tag) }));
    return rec ? rec.problems : null;
  } catch {
    return null;
  }
}

export async function putIndex(tag, problems) {
  try {
    await run("indexes", "readwrite", (s, mem) => (s ? s.put({ tag, problems }) : mem.set(tag, { tag, problems })));
  } catch {
    /* rebuilt next time */
  }
}

// Ask the browser not to clear saved textbooks when space runs low.
export async function persist() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* fine */
  }
}

// ------------------------------------------------------------------ downloads

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A .zip (stored, no compression: PNGs are already compressed) of [{name, data}].
export function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((t, a) => t + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
