"""Textbook lookup for HW Formatter.

When an assignment only lists textbook problems (e.g. "FPE 5.4 (b) and (d)"),
this finds each problem in the textbook PDF named in books.json and returns
its crops. A textbook is indexed once (about a minute) and cached in
book_cache/.
"""

import json
import os
import re

import pymupdf as fitz

HERE = os.path.dirname(os.path.abspath(__file__))
BOOKS_PATH = os.path.join(HERE, "books.json")
CACHE_DIR = os.path.join(HERE, "book_cache")

BIG_FONT = 19.5  # section headings ("Problems for Section 5.1") are larger than this
START_RE = re.compile(r"^\W{0,2}\s*(\d{1,2})\.(\d{1,3})\.?(?![.\d])")  # "5.3" or "2.1."
CAPTION_RE = re.compile(r"^Figure\s+\d+\.\d+.*?\bProblems?\s+([\d.,\sand]+)", re.I)
PAD = 4.0


def load_books():
    """{prefix: {"title":..., "pdf": absolute path}} from books.json."""
    try:
        with open(BOOKS_PATH, encoding="utf-8") as f:
            books = json.load(f)
    except (OSError, ValueError):
        return {}
    for b in books.values():
        b["pdf"] = os.path.normpath(os.path.join(HERE, b["pdf"]))
    return books


# ---------------------------------------------------------------- textbook index

def _lines_and_images(page):
    """Content of a page in reading order: (rect, text, font_size, is_bold)."""
    items = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            text = "".join(sp["text"] for sp in line["spans"])
            if not text.strip():
                continue
            sp = line["spans"][0]
            # Type3 fonts are rendered math (huge brackets etc.); size -1 keeps
            # them from looking like headings or problem numbers.
            size = -1 if "Type3" in sp["font"] else sp["size"]
            items.append((fitz.Rect(line["bbox"]), text, size, "Bold" in sp["font"]))
    for info in page.get_image_info():
        r = fitz.Rect(info["bbox"]) & page.rect
        if not r.is_empty:
            items.append((r, "", 0, False))
    items.sort(key=lambda it: (round(it[0].y0), it[0].x0))
    return items


def build_index(doc, progress=None):
    """Map "5.17" -> list of [page, x0, y0, x1, y1] crops, in reading order."""
    items = []      # (page, rect, text, bold) for content inside Problems sections
    owner = []     # problem key for each item (None = not part of a problem)
    in_problems, chapter, last, current = False, None, 0, None
    prev_heading = None  # (page, bottom y) of the last "Problems..." heading line
    for pi, page in enumerate(doc):
        if progress and pi % 50 == 0:
            progress(pi, doc.page_count)
        for rect, text, size, bold in _lines_and_images(page):
            t = text.strip()
            if size > BIG_FONT and rect.y0 >= 0 and re.search(r"[A-Za-z]{3}", t):
                if t.startswith("Problem"):
                    m = re.search(r"Section\s+(\d+)\.", t, re.I)
                    if not in_problems or (m and m.group(1) != chapter):
                        chapter, last = (m.group(1) if m else None), 0
                    in_problems = True
                    prev_heading = (pi, rect.y1)
                elif prev_heading and prev_heading[0] == pi and rect.y0 - prev_heading[1] < 15:
                    prev_heading = (pi, rect.y1)  # second line of a wrapped "Problems for Section..." heading
                else:
                    in_problems = False
                current = None  # headings end the current problem
                continue
            if not in_problems:
                continue
            m = START_RE.match(text) if text and size > 0 and rect.x0 < 250 else None
            # Problems are numbered in order, so only accept the next few numbers
            # (stops "5.51" from a wrapped "Fig. 5.51" reference counting).
            if m and (chapter is None or m.group(1) == chapter) and last < int(m.group(2)) <= last + 3:
                chapter, last = m.group(1), int(m.group(2))
                current = f"{chapter}.{last}"
                # math on the same line can sort just before the number; pull it in
                k = len(items) - 1
                while k >= 0 and items[k][0] == pi and items[k][1].y1 > rect.y0 + 2:
                    owner[k] = current
                    k -= 1
            if current:
                items.append((pi, rect, text, bold))
                owner.append(current)

    # Figures sometimes sit under a neighboring problem: move each captioned
    # figure ("Figure 5.56 ... for Problem 5.17") to the problem it names.
    keys = set(owner)
    i = 0
    while i < len(items):
        pi, rect, text, bold = items[i]
        m = CAPTION_RE.match(text) if bold else None
        if m:
            targets = [t for t in re.findall(r"\d+\.\d+", m.group(1)) if t in keys]
            j = i + 1
            while j < len(items) and items[j][0] == pi and not items[j][2]:
                j += 1  # the images under the caption
            if targets and targets[0] != owner[i]:
                for k in range(i, j):
                    owner[k] = targets[0]
            i = j
        else:
            i += 1

    # Contiguous runs of a problem's items on one page become one crop.
    index, prev_owner = {}, None
    for k, (pi, rect, _, _) in enumerate(items):
        key = owner[k]
        segs = index.setdefault(key, [])
        if segs and segs[-1][0] == pi and prev_owner == key:
            segs[-1][1] |= rect
        else:
            segs.append([pi, fitz.Rect(rect)])
        prev_owner = key
    return {key: [[pi, *(_pad(r, doc[pi].rect))] for pi, r in segs] for key, segs in index.items()}


def _pad(r, bounds):
    r = fitz.Rect(r.x0 - PAD, r.y0 - PAD, r.x1 + PAD, r.y1 + PAD) & bounds
    return [round(v, 1) for v in r]


def get_index(pdf_path, progress=None):
    """Cached index for a textbook; rebuilt if the PDF changes."""
    st = os.stat(pdf_path)
    tag = f"{os.path.basename(pdf_path)}|{st.st_size}|{int(st.st_mtime)}"
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, re.sub(r"[^\w]+", "_", os.path.basename(pdf_path))[:80] + ".json")
    try:
        with open(cache, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("tag") == tag:
            return data["problems"]
    except (OSError, ValueError):
        pass
    with fitz.open(pdf_path) as doc:
        problems = build_index(doc, progress)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump({"tag": tag, "problems": problems}, f)
    return problems


# ---------------------------------------------------------------- assignment

def find_refs(doc, books):
    """Find textbook references in an assignment.

    Returns a list of dicts: {prefix, key, label, number, block: (page, Rect)}
    where block is the assignment's own text for that item (e.g. "1. FPE 5.3
    Part (a) corresponds to Rule 2..."). Anything after a line containing
    "optional" is skipped.
    """
    if not books:
        return []
    prefixes = "|".join(re.escape(p) for p in books)
    ref_re = re.compile(r"^\s*(?:(\d+)\s*[.)]\s*)?(" + prefixes + r")\s*(\d+\.\d+)")
    item_re = re.compile(r"^\s*(\d+)\s*[.)]\s+\S")  # "4. This problem builds on..."
    refs, stop = [], False
    for pi, page in enumerate(doc):
        if stop:
            break
        lines = [(r, t) for r, t, _, _ in _lines_and_images(page) if t]
        for li, (rect, text) in enumerate(lines):
            if re.search(r"\boptional\b", text, re.I):
                stop = True
                break
            m = ref_re.match(text)
            n = None if m else item_re.match(text)
            # A numbered item that cites no book is its own problem (assignment
            # text only), but only if it's the next number, so numbered notes
            # inside an item don't split it.
            if n and int(n.group(1)) == (_num(refs[-1]) + 1 if refs else 1):
                refs.append({"prefix": None, "key": None, "number": n.group(1),
                             "label": f"Problem {n.group(1)}",
                             "block": [pi, fitz.Rect(rect)]})
            elif m:
                refs.append({"prefix": m.group(2), "key": m.group(3),
                             "number": m.group(1) or str(len(refs) + 1),
                             "label": f"{m.group(2)} {m.group(3)}",
                             "block": [pi, fitz.Rect(rect)]})
            elif refs and refs[-1]["block"][0] == pi and not (
                    rect.y0 > page.rect.height * 0.9 and re.match(r"^\s*(page\s*)?\d+(\s*of\s*\d+)?\s*$", text, re.I)):
                refs[-1]["block"][1] |= rect  # notes under the reference line
    if not any(r["prefix"] for r in refs):
        return []
    for r in refs:
        pi, rect = r["block"]
        r["block"] = (pi, fitz.Rect(rect.x0 - PAD, rect.y0 - PAD, rect.x1 + PAD, rect.y1 + PAD) & doc[pi].rect)
    return refs


def _num(ref):
    try:
        return int(ref["number"])
    except ValueError:
        return -1
