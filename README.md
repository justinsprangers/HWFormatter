# HW Formatter

Turns a homework PDF into ready-to-write pages: each problem is cropped and placed at the top of a sheet of engineering paper, and the header (name, class + HW, date) is filled in. The page box in the top-right corner is left blank for you to fill in.

Two versions, same results:

- **Web app** (`index.html` + `web/`): runs in any modern browser, including a tablet. Nothing to install, and your PDFs never leave your device. Live at **https://justinsprangers.github.io/HWFormatter/** once GitHub Pages is on (see [Publishing](#publishing-the-web-app)).
- **Desktop app** (`hwformat.py`): Python + Tkinter, plus a `--auto` command line.

## Use the web app

1. Open the page and click **Open PDF…**, or drop the homework PDF anywhere on the page.
2. Check the problem list on the left. The red box on the original page shows what was cropped.
3. Fix anything that's off (see below), check Name / Class / HW / Date, then:
   - **Export PDF**: `<name>_formatted.pdf`, one page per problem (more if a problem is long). Import this into Samsung Notes.
   - **PNGs (.zip)** or **Save PNG**: each problem as a picture, for when you want a problem you can still move and resize on the page.

The page needs an internet connection the first time, to download the PDF engine (MuPDF.js, about 4 MB). Your name and settings are remembered in this browser. **Help** on the page has the same instructions.

## Fixing things

| To... | Do this |
|---|---|
| Make a problem bigger/smaller | Drag the **Problem size** slider. **Use this size for all** applies it to every problem. |
| Change the header | Edit Name / Class / HW / Date at the top. Untick **Problem # in header** to drop "P1". |
| Fix a crop | Drag a box on the original page, then click **Replace crop with box**. Use **<** **>** (‹ › on the web) to change pages. |
| Add a piece from another page | Drag a box, then click **Add box to this problem**. |
| Split one problem into two pages (e.g. 6-30 and 6-31) | Replace the crop with the first part, drag a box around the second part, then click **New problem from box**. |
| Join two problems | Select the first one and click **Merge with next**. |
| Remove a problem | Click **Delete**. |

Nothing changes in the original PDF.

## How detection works

A new problem starts at any line beginning with something like `HW#3.1`, `HW5.2:`, `Problem 4`, or `Question 2`. Everything after it, including figures and following pages, belongs to that problem until the next heading. "Page X of Y" footers and the assignment title above the first problem are skipped. Pages of a different size than page 1 (e.g. appended notes) are ignored.

If a class labels problems differently, add a pattern (a regular expression): on the web in **Settings → Problem headings**, on the desktop in `heading_patterns` in `settings.json`. If no headings are found, each page becomes one problem.

Scanned PDFs (pictures of pages with no selectable text) can't be detected automatically. Each page becomes one problem; draw the boxes yourself.

## Textbook problems

Some assignments only list textbook problems ("1. FPE 5.4 (b) and (d)"). If a line starts with a book prefix you've set up, each problem is pulled straight from that textbook's PDF. Each page gets the assignment's own note for that problem (e.g. "Part (a) corresponds to Rule 2...") with the textbook problem and its figure underneath. A numbered item that cites no book ("4. This problem builds on...") stays its own problem with just the assignment's text. Anything after a line containing "optional" is skipped.

**Adding a book**

- **Web:** **Settings → Add a textbook**: type the prefix your class uses (e.g. `FPE`), then **Choose PDF…**. The PDF is saved in this browser (on this device only), so you only do this once per device. If the page says a textbook is missing, it offers to choose it again.
- **Desktop:** copy `books.example.json` to `books.json` (it isn't committed, since it holds your local paths), then add an entry with the prefix and the PDF path (absolute, or relative to this folder):

  ```json
  "FPE": { "title": "Feedback Control of Dynamic Systems, 8th ed.", "pdf": "path/to/your/textbook.pdf" }
  ```

No textbook PDFs are included; use your own copy.

- The first time a textbook is used, it's indexed (a few seconds on the web, about 30 s on the desktop, progress shown at the top). After that it's instant. The desktop keeps the index in `book_cache\` (delete it to force a re-index); the web keeps it in the browser.
- The whole textbook problem is included even if you're only assigned some parts; the note above it says which parts.
- A problem the tool can't find shows "(not found in book)" in the list. Known one: FPE 7.14, which the book's text misnumbers as "7.4".
- The book needs selectable text, a large "Problems" (or "Problems for Section 5.1") heading before each chapter's problems, and problems that start with their number ("5.3 ..."). This was built and tested on FPE; another book may need tweaks in `hwbook.py` and `web/core.js`.

## Desktop app

Drag the homework PDF onto **`HW Formatter.bat`**, or double-click the .bat and click **Open PDF...**. Export saves `<name>_formatted.pdf` and a `<name>_problems\` folder of PNGs next to the original PDF.

`settings.json` is created on your first export. It remembers your name, last class, problem size, and the "Problem # in header" choice. `png_dpi` sets the resolution of the PNGs.

```
python hwformat.py homework.pdf --auto
```

Exports with no window, using the automatic detection.

Needs Python 3 with PyMuPDF (`pip install pymupdf`). Tkinter comes with Python.

## Publishing the web app

The site is plain static files, so GitHub Pages serves it as is:

1. Push this repo to GitHub.
2. On GitHub: **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**, **Save**.
3. After a minute it's at `https://<your-username>.github.io/HWFormatter/`.

To try it locally, serve the folder (opening `index.html` as a file doesn't work, because the browser blocks modules from `file://`):

```
python -m http.server 8000
```

then open http://localhost:8000/.

## Files

- `index.html`, `web/style.css`, `web/app.js`: the web page.
- `web/core.js`: problem detection, textbook index, layout, and PDF/PNG output for the web (a port of `hwcore.py` + `hwbook.py`; keep them in step).
- `web/store.js`: settings and saved textbooks (browser storage), downloads, and the .zip writer.
- `hwformat.py`: the desktop window and command line.
- `hwcore.py`: problem detection, layout, and export.
- `hwbook.py`: textbook lookup (`books.json` lists the books).
- The engineering paper is drawn as vector lines (`draw_paper` in `hwcore.py`, `drawPaper` in `web/core.js`), so it stays sharp at any zoom. Line positions and colors are set near it (`BOX_*`, `GRID_*`, `CELL`, `GRID_MAJOR`, ...). `paper.png` is only the reference image those positions were measured from.

## License

MIT. See [LICENSE](LICENSE). The PDF engines it uses, [PyMuPDF](https://pymupdf.readthedocs.io/) (desktop) and [MuPDF.js](https://mupdf.com/) (web, loaded from the jsDelivr CDN, not included here), are licensed separately by Artifex under the AGPL.
