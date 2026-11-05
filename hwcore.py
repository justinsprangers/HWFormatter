"""Core logic for HW Formatter: find problems in a homework PDF and lay them
out on engineering paper. The GUI (hwformat.py) and command line both use this."""

import datetime
import json
import os
import re

import pymupdf as fitz

import hwbook

HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.path.join(HERE, "settings.json")

DEFAULT_SETTINGS = {
    "name": "",
    "last_class": "",
    "scale": 0.75,              # problem size on the paper (1.0 = original size)
    "problem_in_header": True,  # adds "P1", "P2", ... after the HW label
    "png_dpi": 200,
    # A line that starts with one of these begins a new problem.
    "heading_patterns": [
        r"HW\s*#?\s*\d+\s*\.\s*\d+",
        r"(?:Problem|Prob\.|Question)\s*#?\s*\d+(?:\s*[.\-]\s*\d+)?",
    ],
}

# Letter page, 612 x 792 pt. Positions below are measured from paper.png
# (1545 x 2000 px) and converted to points.
PAGE_W, PAGE_H = 612.0, 792.0
_PX = PAGE_W / 1545.0
HEADER_BOTTOM = 90 * _PX
BOX_NAME = (158 * _PX, 545 * _PX)
BOX_CLASS = (545 * _PX, 954 * _PX)
BOX_DATE = (954 * _PX, 1431 * _PX)
GRID_LEFT, GRID_RIGHT = 158 * _PX, 1431 * _PX
MARGIN = 4.0      # gap between grid lines and the pasted problem
SEG_GAP = 4.0     # gap between stacked pieces of one problem
PAD = 4.0         # white space kept around the cropped content
FOOTER_RE = re.compile(r"^\s*(page\s*)?\d+\s*(of\s*\d+)?\s*$", re.I)


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            s.update(json.load(f))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


class Problem:
    """One problem = one or more cropped rectangles (segments) of the source PDF."""

    def __init__(self, title, number, segments, scale):
        self.title = title          # e.g. "HW#3.1"
        self.number = number        # e.g. "1", used for "P1" in the header
        self.segments = segments    # list of (source doc, page_index, fitz.Rect)
        self.scale = scale


# ---------------------------------------------------------------- detection

def _page_items(page):
    """Visible content on a page as (rect, text) pairs; text is '' for graphics."""
    items = []
    h = page.rect.height
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            text = "".join(sp["text"] for sp in line["spans"])
            if not text.strip():
                continue
            r = fitz.Rect(line["bbox"])
            if r.y0 > h * 0.9 and FOOTER_RE.match(text):
                continue  # "Page 2 of 5" footer
            items.append((r, text))
    for info in page.get_image_info():
        r = fitz.Rect(info["bbox"]) & page.rect
        if not r.is_empty:
            items.append((r, ""))
    page_area = abs(page.rect)
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"]) & page.rect
        if r.is_empty or abs(r) > 0.8 * page_area:
            continue  # skip page borders
        items.append((r, ""))
    items.sort(key=lambda it: (round(it[0].y0), it[0].x0))
    return items


def detect_problems(doc, settings, progress=None):
    """Split an assignment into problems. If it cites textbook problems listed in
    books.json (e.g. "FPE 5.3"), each one is pulled from the textbook instead.
    progress(done, total) is called while a textbook is indexed the first time."""
    refs = hwbook.find_refs(doc, hwbook.load_books())
    if refs:
        return _book_problems(doc, refs, settings["scale"], progress)

    heading_res = [re.compile(r"^\s*(" + p + r")", re.I) for p in settings["heading_patterns"]]
    scale = settings["scale"]
    problems = []
    current = None  # dict page_index -> Rect for the problem being collected

    def finish():
        if current is not None:
            p = current["problem"]
            p.segments = [(pi, r) for pi, r in sorted(current["rects"].items())]
            if p.segments:
                problems.append(p)

    first_size = doc[0].rect if doc.page_count else None
    for pi, page in enumerate(doc):
        if abs(page.rect.width - first_size.width) > 2 or abs(page.rect.height - first_size.height) > 2:
            continue  # different page size: not part of the assignment (e.g. appended notes)
        for rect, text in _page_items(page):
            m = None
            if text:
                for rx in heading_res:
                    m = rx.match(text)
                    if m:
                        break
            if m:
                finish()
                title = re.sub(r"\s+", "", m.group(1))
                nums = re.findall(r"\d+", title)
                current = {"problem": Problem(title, nums[-1] if nums else "", [], scale),
                           "rects": {}}
            if current is None:
                continue  # assignment title etc. before the first problem
            rects = current["rects"]
            rects[pi] = rects[pi] | rect if pi in rects else fitz.Rect(rect)
    finish()

    if not problems:  # no headings found: one problem per page
        for pi, page in enumerate(doc):
            items = _page_items(page)
            if items:
                r = fitz.Rect(items[0][0])
                for it in items[1:]:
                    r |= it[0]
                problems.append(Problem(f"Page {pi + 1}", str(pi + 1), [(pi, r)], scale))

    for p in problems:
        p.segments = [(doc, pi, _pad(r, doc[pi].rect)) for pi, r in p.segments]
    return problems


_open_books = {}  # pdf path -> open textbook, kept open while the app runs


def _book_problems(doc, refs, scale, progress):
    """One problem per textbook reference: the assignment's own note for it
    (e.g. "1. FPE 5.3  Part (a) corresponds to Rule 2...") on top, then the
    problem cropped from the textbook."""
    books = hwbook.load_books()
    problems = []
    for ref in refs:
        segs = [(doc, *ref["block"])]
        title = ref["label"]
        pdf = books[ref["prefix"]]["pdf"]
        if not os.path.exists(pdf):
            title += "  (textbook PDF missing)"
        else:
            index = hwbook.get_index(pdf, progress)
            if ref["key"] not in index:
                title += "  (not found in book)"
            else:
                if pdf not in _open_books:
                    _open_books[pdf] = fitz.open(pdf)
                book = _open_books[pdf]
                segs += [(book, pi, fitz.Rect(r)) for pi, *r in index[ref["key"]]]
        problems.append(Problem(title, ref["number"], segs, scale))
    return problems


def _pad(r, bounds):
    return fitz.Rect(r.x0 - PAD, r.y0 - PAD, r.x1 + PAD, r.y1 + PAD) & bounds


def guess_header(doc, path, settings):
    """Guess (class, hw label) from the file name and first page text."""
    name = os.path.basename(path)
    text = doc[0].get_text()[:1500] if doc.page_count else ""
    cls = settings.get("last_class", "")
    m = re.search(r"\b([A-Z]{2,4})[ _-]?(\d{3})\b", name) or re.search(r"\b([A-Z]{2,4}) ?(\d{3})\b", text)
    if m:
        cls = f"{m.group(1)} {m.group(2)}"
    hw = ""
    m = (re.search(r"HW[ _#-]*(\d+)", name, re.I)
         or re.search(r"Homework\s*(?:Set|Assignment)?\s*#?\s*(\d+)", text, re.I))
    if m:
        hw = f"HW-{int(m.group(1))}"
    return cls, hw


def today():
    return datetime.date.today().strftime("%m/%d/%Y")


# ---------------------------------------------------------------- layout

def layout(problem):
    """Place a problem's segments on paper. Returns a list of output pages,
    each a list of (source doc, page_index, src_rect, dest_rect)."""
    top = HEADER_BOTTOM + MARGIN
    bottom = PAGE_H - MARGIN
    left = GRID_LEFT + MARGIN
    max_w = GRID_RIGHT - MARGIN - left
    pages, cur, y = [], [], top
    for sdoc, pi, src in problem.segments:
        s = problem.scale
        w, h = src.width * s, src.height * s
        if w > max_w:  # never run past the right edge of the grid
            s = max_w / src.width
            w, h = src.width * s, src.height * s
        if h > bottom - top:  # taller than a whole page: shrink to fit
            s = (bottom - top) / src.height
            w, h = src.width * s, src.height * s
        if cur and y + h > bottom:
            pages.append(cur)
            cur, y = [], top
        cur.append((sdoc, pi, src, fitz.Rect(left, y, left + w, y + h)))
        y += h + SEG_GAP
    if cur:
        pages.append(cur)
    return pages


def _draw_header(page, name, cls, hw_label, date):
    y0, y1 = 0, HEADER_BOTTOM

    def centered(text, box, size, y_mid):
        if not text:
            return
        w = fitz.get_text_length(text, fontname="helv", fontsize=size)
        while w > (box[1] - box[0]) - 6 and size > 6:
            size -= 0.5
            w = fitz.get_text_length(text, fontname="helv", fontsize=size)
        x = (box[0] + box[1] - w) / 2
        page.insert_text((x, y_mid + size * 0.35), text, fontname="helv", fontsize=size)

    mid = (y0 + y1) / 2
    centered(name, BOX_NAME, 15, mid)
    if cls and hw_label:
        centered(cls, BOX_CLASS, 12, mid - 7)
        centered(hw_label, BOX_CLASS, 12, mid + 8)
    else:
        centered(cls or hw_label, BOX_CLASS, 13, mid)
    centered(date, BOX_DATE, 15, mid)


def _paste(page, src_doc, pi, src, dest):
    page.draw_rect(dest, color=(0.78, 0.78, 0.78), fill=(1, 1, 1), width=0.6)
    page.show_pdf_page(dest, src_doc, pi, clip=src)


GREEN = (27 / 255, 116 / 255, 29 / 255)
GRID_MAJOR = (206 / 255, 228 / 255, 211 / 255)
GRID_MINOR = (224 / 255, 234 / 255, 227 / 255)
CELL = 36.37 * _PX  # one small grid square, in points


def draw_paper(page):
    """Draw the engineering paper as vector lines so it stays sharp when zoomed.
    Positions were measured from paper.png."""
    def lines(positions, horizontal, color, width):
        shape = page.new_shape()
        for p in positions:
            if horizontal:
                shape.draw_line((GRID_LEFT, p), (GRID_RIGHT, p))
            else:
                shape.draw_line((p, HEADER_BOTTOM), (p, PAGE_H))
        shape.finish(color=color, width=width)
        shape.commit()

    xs = [GRID_LEFT + i * CELL for i in range(1, 35)]
    ys = [HEADER_BOTTOM + i * CELL for i in range(1, int((PAGE_H - HEADER_BOTTOM) / CELL) + 1)]
    for horizontal, ps in ((False, xs), (True, ys)):
        minor = [p for i, p in enumerate(ps, 1) if i % 5]
        lines(minor, horizontal, GRID_MINOR, 0.25)
    for horizontal, ps in ((False, xs), (True, ys)):
        lines([p for i, p in enumerate(ps, 1) if i % 5 == 0], horizontal, GRID_MAJOR, 0.5)

    shape = page.new_shape()
    shape.draw_line((0, HEADER_BOTTOM), (PAGE_W, HEADER_BOTTOM))
    for x in (GRID_LEFT, GRID_RIGHT):
        shape.draw_line((x, 0), (x, PAGE_H))
    for x in (BOX_CLASS[0], BOX_DATE[0]):
        shape.draw_line((x, 0), (x, HEADER_BOTTOM))
    for cy in (227, 1000, 1773):
        shape.draw_circle((68 * _PX, cy * _PX), 28.5 * _PX)
    shape.finish(color=GREEN, width=0.6)
    shape.commit()


def build_pdf(problems, header):
    """header: dict with name, cls, hw, date, problem_in_header."""
    out = fitz.open()
    for prob in problems:
        hw_label = header["hw"]
        if header.get("problem_in_header") and prob.number:
            hw_label = f"{hw_label} P{prob.number}".strip()
        for placed in layout(prob):
            page = out.new_page(width=PAGE_W, height=PAGE_H)
            draw_paper(page)
            _draw_header(page, header["name"], header["cls"], hw_label, header["date"])
            for sdoc, pi, src, dest in placed:
                _paste(page, sdoc, pi, src, dest)
    return out


def problem_png(problem, dpi):
    """One PNG of the whole problem (segments stacked) for inserting as a picture."""
    w = max(r.width for _, _, r in problem.segments)
    h = sum(r.height for _, _, r in problem.segments) + SEG_GAP * (len(problem.segments) - 1)
    tmp = fitz.open()
    page = tmp.new_page(width=w, height=h)
    y = 0
    for sdoc, pi, r in problem.segments:
        page.show_pdf_page(fitz.Rect(0, y, r.width, y + r.height), sdoc, pi, clip=r)
        y += r.height + SEG_GAP
    return page.get_pixmap(dpi=dpi).tobytes("png")


def export(src_path, problems, header, dpi):
    """Write <name>_formatted.pdf and a <name>_problems folder of PNGs next to
    the source PDF. Returns (pdf_path, png_dir)."""
    base = os.path.splitext(src_path)[0]
    pdf_path = base + "_formatted.pdf"
    png_dir = base + "_problems"
    out = build_pdf(problems, header)
    out.save(pdf_path, garbage=3, deflate=True)
    out.close()
    os.makedirs(png_dir, exist_ok=True)
    for i, prob in enumerate(problems, 1):
        safe = re.sub(r"[^\w.\-]+", "_", prob.title).strip("_") or f"problem{i}"
        with open(os.path.join(png_dir, f"{i:02d}_{safe}.png"), "wb") as f:
            f.write(problem_png(prob, dpi))
    return pdf_path, png_dir
