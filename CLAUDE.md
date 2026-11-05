# CLAUDE.md: HW Formatter

Desktop tool (Python + Tkinter + PyMuPDF) that crops each problem out of a homework PDF and places it on engineering paper with a filled header. User docs: [README.md](README.md).

**Public repo (MIT).** No personal info (name, class numbers), textbook content, or local paths in commits. `settings.json`, `books.json`, and `book_cache/` are gitignored; `books.example.json` is the committed template.

- `hwcore.py`: detection (`detect_problems`), layout (`layout`, `build_pdf`), and export. Has no GUI code.
- `hwformat.py`: Tkinter window plus the `--auto` command line.
- `hwbook.py` + `books.json`: when an assignment cites textbook problems (prefix + number, e.g. "FPE 5.3"), crops come from the textbook. The index (problem -> page crops) is cached in `book_cache/` (gitignored). Tuned on the FPE 8th ed. PDF: Problems sections start at big-font "Problems..." headings, numbers must run in sequence, Type3 fonts are math, and figure captions "for Problem X" move figures to X. Textbooks are referenced by path, never copied into this repo.
- Segments are `(source doc, page, rect)`, so one problem can mix the assignment PDF and the textbook.
- `paper.png`: the user's engineering paper (1545 x 2000 px), kept as the measuring reference. Header and grid positions in `hwcore.py` are measured from it, and `draw_paper` redraws it as vector lines (the raster was blurry when zoomed). It is no longer used at runtime.
- Problems are pasted as vector (`show_pdf_page`), so text stays sharp at any scale. PNG exports are for inserting as movable pictures, since Samsung Notes flattens imported PDFs.
- Already tried and dropped: image annotations (Samsung Notes flattens or drops them), and a header-only "blank pages" export (too manual; the user prefers flattened pages sized with the slider).
- The user's format: one problem per page, crop at the top-left of the grid, header = name | class over HW (+ "P#") | date | page count (left blank; they write it).
- Test with `python hwformat.py <pdf> --auto` on a copy, never on files in Downloads directly.
