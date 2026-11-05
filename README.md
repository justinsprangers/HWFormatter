# HW Formatter

Turns a homework PDF into ready-to-write pages: each problem is cropped and placed at the top of a sheet of engineering paper, and the header (name, class + HW, date) is filled in. The page box in the top-right corner is left blank for you to fill in.

## Use it

1. Drag the homework PDF onto **`HW Formatter.bat`**, or double-click the .bat and click **Open PDF...**.
2. Check the problem list on the left. The red box on the original page shows what was cropped.
3. Fix anything that's off (see below), then click **Export**.

Export saves two things next to the original PDF:

- **`<name>_formatted.pdf`**: one page per problem (more if a problem is long). Import this into Samsung Notes.
- **`<name>_problems\`**: each problem as a PNG. Insert one as a picture in Samsung Notes when you want a problem you can still move and resize on the page.

## Fixing things

| To... | Do this |
|---|---|
| Make a problem bigger/smaller | Drag the **Problem size** slider. **Use this size for all** applies it to every problem. |
| Change the header | Edit Name / Class / HW / Date at the top. Untick **Problem # in header** to drop "P1". |
| Fix a crop | Drag a box on the original page, then click **Replace crop with box**. Use **<** **>** to change pages. |
| Add a piece from another page | Drag a box, then click **Add box to this problem**. |
| Split one problem into two pages (e.g. 6-30 and 6-31) | Replace the crop with the first part, drag a box around the second part, then click **New problem from box**. |
| Join two problems | Select the first one and click **Merge with next**. |
| Remove a problem | Click **Delete**. |

Nothing changes in the original PDF.

## How detection works

A new problem starts at any line beginning with something like `HW#3.1`, `HW5.2:`, `Problem 4`, or `Question 2`. Everything after it, including figures and following pages, belongs to that problem until the next heading. "Page X of Y" footers and the assignment title above the first problem are skipped. Pages of a different size than page 1 (e.g. appended notes) are ignored.

If a class labels problems differently, add a pattern (a regular expression) to `heading_patterns` in `settings.json`. If no headings are found, each page becomes one problem.

Scanned PDFs (pictures of pages with no selectable text) can't be detected automatically. Each page becomes one problem; draw the boxes yourself.

## Textbook problems

Some assignments only list textbook problems ("FPE 5.4 (b) and (d)"). If a line starts with a book prefix from `books.json`, each problem is pulled straight from that textbook's PDF. Each page gets the assignment's own note for that problem (e.g. "Part (a) corresponds to Rule 2...") with the textbook problem and its figure underneath. Anything after a line containing "optional" is skipped.

- The first time a textbook is used, it's indexed (about 30 s, progress shown at the top). After that it's instant. The index is saved in `book_cache\`; delete that folder to force a re-index.
- The whole textbook problem is included even if you're only assigned some parts; the note above it says which parts.
- A problem the tool can't find shows "(not found in book)" in the list. Known one: FPE 7.14, which the book's text misnumbers as "7.4".

**Adding a book:** copy `books.example.json` to `books.json` (it isn't committed, since it holds your local paths), then add an entry with the prefix your class uses and the PDF path (absolute, or relative to this folder):

```json
"FPE": { "title": "Feedback Control of Dynamic Systems, 8th ed.", "pdf": "path/to/your/textbook.pdf" }
```

No textbook PDFs are included; use your own copy.

The book needs selectable text, a large "Problems" (or "Problems for Section 5.1") heading before each chapter's problems, and problems that start with their number ("5.3 ..."). This was built and tested on FPE; another book may need tweaks in `hwbook.py`.

## Settings (`settings.json`)

Created on your first export. Remembers your name, last class, problem size, and the "Problem # in header" choice. `png_dpi` sets the resolution of the PNGs.

## Command line

```
python hwformat.py homework.pdf --auto
```

Exports with no window, using the automatic detection.

## Files

- `hwformat.py`: the window and command line.
- `hwcore.py`: problem detection, layout, and export.
- `hwbook.py`: textbook lookup (`books.json` lists the books).
- The engineering paper is drawn as vector lines by `draw_paper` in `hwcore.py`, so it stays sharp at any zoom. Line positions and colors are set near it (`BOX_*`, `GRID_*`, `CELL`, `GRID_MAJOR`, ...). `paper.png` is only the reference image those positions were measured from.

Needs Python 3 with PyMuPDF (`pip install pymupdf`). Tkinter comes with Python.

## License

MIT. See [LICENSE](LICENSE).
