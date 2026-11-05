# CLAUDE.md: HW Formatter

Crops each problem out of a homework PDF and places it on engineering paper with a filled header. Two front ends with the same logic: a desktop app (Python + Tkinter + PyMuPDF) and a static web app (`index.html` + `web/`, MuPDF.js) for GitHub Pages. User docs: [README.md](README.md).

**Public repo (MIT).** No personal info (name, class numbers), textbook content, or local paths in commits. `settings.json`, `books.json`, `book_cache/`, and `__test__/` are gitignored; `books.example.json` is the committed template.

## Desktop (Python)
- `hwcore.py`: detection (`detect_problems`), layout (`layout`, `build_pdf`), and export. Has no GUI code.
- `hwformat.py`: Tkinter window plus the `--auto` command line.
- `hwbook.py` + `books.json`: when an assignment cites textbook problems (prefix + number, e.g. "FPE 5.3"), crops come from the textbook. The index (problem -> page crops) is cached in `book_cache/`. Tuned on the FPE 8th ed. PDF: Problems sections start at big-font "Problems..." headings, numbers must run in sequence, Type3 fonts are math, and figure captions "for Problem X" move figures to X. Textbooks are referenced by path, never copied into this repo.
- In a textbook assignment, the next sequentially numbered item that cites no book ("4. This problem builds on...") becomes its own problem (prefix None, assignment text only).
- Segments are `(source doc, page, rect)`, so one problem can mix the assignment PDF and the textbook.

## Web (`index.html`, `web/`)
- `web/core.js` is a line-for-line port of `hwcore.py` + `hwbook.py`. **Change both together.** `web/app.js` = UI (port of `hwformat.py`), `web/store.js` = settings (localStorage), textbooks + indexes (IndexedDB, PDF blob saved per device), downloads, store-only zip writer.
- MuPDF.js `mupdf@1.28.1` from jsDelivr (same engine as PyMuPDF 1.28.x). `app.js` imports `core.js` dynamically so the page shows an error instead of nothing if the CDN fails.
- Text must match PyMuPDF's `get_text("dict")`, or detection drifts. `readPage` walks chars and rebuilds boxes the way PyMuPDF's `JM_char_quad` (extra.i) does: if a font's ascender - descender < 1, the char box becomes exactly 1 em, keeping the ratio. Type3 asc/dsc = y range of FontBBox x FontMatrix (font name "Type3 (N 0 R)" gives the object). Regular fonts: the median box of the font on the page (stretched Arial chars on FPE page index 1369 broke a per-char rule). Lines missing the page are skipped, and so are chars whose box misses it (`JM_rects_overlap`). Without this, Type3 brackets in FPE made 14 em boxes and crops ran to the page edge.
- Verified 2026-11-05: web index of FPE = Python `book_cache` exactly (418 problems, 639 crops, 0 pt difference, ~5 s); HW9 and a synthetic "Problem N" assignment detect identically; exported PDFs pixel-match Python's except anti-aliasing.
- Output pages paste source pages as Form XObjects (own `show_pdf_page`): one graft map per source document (MuPDF refuses mixing). Header font is non-embedded Helvetica; widths from `new mupdf.Font("Helvetica")`.
- CSS: `[hidden] { display: none !important }` is needed, since `.banner`/`.empty` set display.

## Shared
- `paper.png`: the user's engineering paper (1545 x 2000 px), kept as the measuring reference. Header and grid positions are measured from it, and `draw_paper`/`drawPaper` redraw it as vector lines. Not used at runtime.
- Problems are pasted as vector, so text stays sharp at any scale. PNG exports are for inserting as movable pictures, since Samsung Notes flattens imported PDFs.
- Already tried and dropped: image annotations (Samsung Notes flattens or drops them), and a header-only "blank pages" export (too manual; the user prefers flattened pages sized with the slider).
- The user's format: one problem per page, crop at the top-left of the grid, header = name | class over HW (+ "P#") | date | page count (left blank; they write it).

## Testing
- Desktop: `python hwformat.py <pdf> --auto` on a copy in `__test__/`, never on files in Downloads directly.
- Web: serve a parent folder that holds both this repo and the textbook with a local static server (the workspace has a launch config for that), so the test page can `fetch` the textbook. Drive the real inputs with `DataTransfer` (`input.files = dt.files` + `change`). Capture downloads by overriding `HTMLAnchorElement.prototype.click`. Compare `buildIndex` with `book_cache/*.json`. The pane is often hidden (0x0 viewport): set a size with `resize_window`. Clear test data afterwards (IndexedDB `hwformatter`, localStorage `hwformatter.settings.v1`); deleting the DB needs the app page closed.
