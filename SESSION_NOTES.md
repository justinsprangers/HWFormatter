# HWFormatter: session notes

## Status
- Working, two versions with the same results:
  - **Web** (`index.html` + `web/`): static page for GitHub Pages, runs in the browser (tablet too), files stay on the device. Textbooks are added once per device in Settings.
  - **Desktop**: drag a homework PDF onto `HW Formatter.bat`.
- Textbook lookup: lines citing `FPE 5.x` pull the full problem and its figure from the FPE PDF (desktop: path in `books.json`, template `books.example.json`; web: saved in the browser). It finds 418 problems in 10 chapters. Optional problems are skipped.
- Own public repo (MIT) since 2026-11-05, split out of the workspace repo with a fresh history.

## Next steps
- Push, then turn on GitHub Pages (Settings > Pages > Deploy from a branch > main / root). Check the live site on the tablet.
- Known miss: 7.14, which the book misnumbers as "7.4".
- Only the chapter 5 and 6 output has been checked by eye. Spot-check other chapters when they're assigned.
- Other textbooks can be added, but each may need detection tweaks (in both `hwbook.py` and `web/core.js`).

## Decisions & gotchas
- `web/core.js` must stay in step with `hwcore.py` + `hwbook.py`. The web text reader copies PyMuPDF's char-box rules (see `CLAUDE.md`); without them FPE crops differ.
- If the FPE PDF moves or is renamed, update its path in `books.json` (desktop only).
- Tried and dropped: image annotations, and a header-only pages export. See `CLAUDE.md`.

## Log
- 2026-11-05: Web version (MuPDF.js): index, detection, and PDF output verified equal to the Python version
- 2026-11-05: Numbered items that cite no textbook become their own problem (HW9 item 4 was merged into FPE 6.4)
- 2026-11-05: Made public: removed hardcoded name, books.json gitignored (books.example.json added), MIT LICENSE
- 2026-10-29: Fix vector paper: horizontal grid lines stopped after 19 rows; now fill the page
- 2026-10-16: Pull textbook problems for assignments that only cite them (88fd0aa)
- 2026-10-16: First version: auto-format homework PDFs onto engineering paper
