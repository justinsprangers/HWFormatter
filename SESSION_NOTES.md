# HWFormatter: session notes

## Status
- Working. Drag a homework PDF onto `HW Formatter.bat` to get one problem per page on engineering paper, with the header filled in.
- Textbook lookup: lines citing `FPE 5.x` pull the full problem and its figure from the FPE PDF set in `books.json` (local only; template is `books.example.json`).
- Own public repo (MIT) as of 2026-11-05, split out of the workspace repo with a fresh history. It found 418 problems in 10 chapters. Optional problems are skipped.

## Next steps
- Known miss: 7.14, which the book misnumbers as "7.4".
- Only the chapter 5 output has been checked by eye. Spot-check other chapters when they're assigned.
- Other textbooks can be added in `books.json`, but each may need detection tweaks.

## Decisions & gotchas
- If the FPE PDF moves or is renamed, update its path in `books.json`.
- Tried and dropped: image annotations, and a header-only pages export. See `CLAUDE.md`.

## Log
- 2026-11-05: Made public: removed hardcoded name, books.json gitignored (books.example.json added), MIT LICENSE
- 2026-10-29: Fix vector paper: horizontal grid lines stopped after 19 rows; now fill the page
- 2026-10-16: Pull textbook problems for assignments that only cite them (88fd0aa)
- 2026-10-16: First version: auto-format homework PDFs onto engineering paper
