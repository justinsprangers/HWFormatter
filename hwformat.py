"""HW Formatter: turns a homework PDF into one engineering-paper page per problem.

Run:  python hwformat.py [homework.pdf]          (opens the preview window)
      python hwformat.py homework.pdf --auto   (exports with no window)
See README.md for how to use it.
"""

import base64
import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import pymupdf as fitz

import hwcore

VIEW_H = 760  # height in pixels of the two page previews (set from screen size)


def page_photo(page, zoom, clip=None):
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
    return tk.PhotoImage(data=base64.b64encode(pix.tobytes("png")))


class App(tk.Tk):
    def __init__(self, path=None):
        super().__init__()
        global VIEW_H
        VIEW_H = max(500, min(1000, self.winfo_screenheight() - 200))
        self.title("HW Formatter")
        self.settings = hwcore.load_settings()
        self.doc = None
        self.path = None
        self.problems = []
        self.src_page = 0
        self.drag_start = None
        self.drawn = None  # rectangle the user just drew, in PDF points
        self._build()
        if path:
            self.open_pdf(path)

    # ------------------------------------------------------------ layout
    def _build(self):
        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")
        ttk.Button(top, text="Open PDF...", command=self.choose_pdf).pack(side="left")
        self.file_lbl = ttk.Label(top, text="No file open", width=34)
        self.file_lbl.pack(side="left", padx=6)
        self.vars = {}
        for key, label, width in (("name", "Name", 18), ("cls", "Class", 9),
                                  ("hw", "HW", 9), ("date", "Date", 11)):
            ttk.Label(top, text=label).pack(side="left", padx=(8, 2))
            v = tk.StringVar()
            v.trace_add("write", lambda *_: self.refresh_output())
            ttk.Entry(top, textvariable=v, width=width).pack(side="left")
            self.vars[key] = v
        self.vars["name"].set(self.settings["name"])
        self.vars["date"].set(hwcore.today())
        self.pnum = tk.BooleanVar(value=self.settings["problem_in_header"])
        ttk.Checkbutton(top, text="Problem # in header", variable=self.pnum,
                        command=self.refresh_output).pack(side="left", padx=8)
        ttk.Button(top, text="Export", command=self.do_export).pack(side="right")

        body = ttk.Frame(self, padding=6)
        body.pack(fill="both", expand=True)

        # left: problem list and controls
        left = ttk.Frame(body)
        left.pack(side="left", fill="y")
        ttk.Label(left, text="Problems (one per page)").pack(anchor="w")
        self.listbox = tk.Listbox(left, width=24, height=14, exportselection=False)
        self.listbox.pack(fill="y")
        self.listbox.bind("<<ListboxSelect>>", lambda e: self.select(self.current()))
        for text, cmd in (("Move up", lambda: self.move(-1)), ("Move down", lambda: self.move(1)),
                          ("Merge with next", self.merge_next), ("Delete", self.delete)):
            ttk.Button(left, text=text, command=cmd).pack(fill="x", pady=1)

        ttk.Label(left, text="\nProblem size").pack(anchor="w")
        self.scale_var = tk.DoubleVar(value=self.settings["scale"] * 100)
        self.scale_lbl = ttk.Label(left, text="")
        self.scale_lbl.pack(anchor="w")
        ttk.Scale(left, from_=40, to=130, variable=self.scale_var,
                  command=lambda _: self.scale_changed()).pack(fill="x")
        ttk.Button(left, text="Use this size for all", command=self.scale_all).pack(fill="x", pady=1)

        ttk.Label(left, text="\nFix a crop: drag a box on\nthe left page, then:",
                  justify="left").pack(anchor="w")
        for text, cmd in (("Replace crop with box", self.box_replace),
                          ("Add box to this problem", self.box_add),
                          ("New problem from box", self.box_new)):
            ttk.Button(left, text=text, command=cmd).pack(fill="x", pady=1)

        # middle: source page
        mid = ttk.Frame(body)
        mid.pack(side="left", padx=8)
        nav = ttk.Frame(mid)
        nav.pack(fill="x")
        ttk.Button(nav, text="<", width=3, command=lambda: self.show_src(self.src_page - 1)).pack(side="left")
        self.page_lbl = ttk.Label(nav, text="Original")
        self.page_lbl.pack(side="left", padx=6)
        ttk.Button(nav, text=">", width=3, command=lambda: self.show_src(self.src_page + 1)).pack(side="left")
        self.src_canvas = tk.Canvas(mid, width=int(VIEW_H * 612 / 792), height=VIEW_H,
                                    bg="#ddd", highlightthickness=0, cursor="crosshair")
        self.src_canvas.pack()
        self.src_canvas.bind("<ButtonPress-1>", self.drag_begin)
        self.src_canvas.bind("<B1-Motion>", self.drag_move)
        self.src_canvas.bind("<ButtonRelease-1>", self.drag_end)

        # right: output preview
        right = ttk.Frame(body)
        right.pack(side="left")
        self.out_lbl = ttk.Label(right, text="Output preview")
        self.out_lbl.pack(anchor="w")
        self.out_canvas = tk.Canvas(right, width=int(VIEW_H * 612 / 792), height=VIEW_H,
                                    bg="#ddd", highlightthickness=0)
        self.out_canvas.pack()

    # ------------------------------------------------------------ file
    def choose_pdf(self):
        p = filedialog.askopenfilename(filetypes=[("PDF files", "*.pdf")])
        if p:
            self.open_pdf(p)

    def open_pdf(self, path):
        try:
            self.doc = fitz.open(path)
        except Exception as e:
            messagebox.showerror("HW Formatter", f"Couldn't open the PDF:\n{e}")
            return
        self.path = path
        self.file_lbl.config(text="Reading...")
        self.update_idletasks()
        try:
            self.problems = hwcore.detect_problems(self.doc, self.settings, self.index_progress)
        except Exception as e:
            messagebox.showerror("HW Formatter", f"Couldn't read the problems:\n{e}")
            self.problems = []
        self.file_lbl.config(text=os.path.basename(path)[:40])
        cls, hw = hwcore.guess_header(self.doc, path, self.settings)
        self.vars["cls"].set(cls)
        self.vars["hw"].set(hw)
        self.refresh_list()
        self.select(0)

    def index_progress(self, done, total):
        self.file_lbl.config(text=f"Indexing textbook (one time): {100 * done // total}%")
        self.update_idletasks()

    # ------------------------------------------------------------ list
    def current(self):
        sel = self.listbox.curselection()
        return sel[0] if sel else (0 if self.problems else None)

    def refresh_list(self, keep=None):
        self.listbox.delete(0, "end")
        for p in self.problems:
            pages = len(hwcore.layout(p))
            self.listbox.insert("end", p.title + (f"  ({pages} pages)" if pages > 1 else ""))
        if keep is not None and self.problems:
            keep = max(0, min(keep, len(self.problems) - 1))
            self.listbox.selection_set(keep)

    def select(self, i):
        if i is None or not self.problems:
            self.show_src(0)
            self.refresh_output()
            return
        self.listbox.selection_clear(0, "end")
        self.listbox.selection_set(i)
        self.scale_var.set(self.problems[i].scale * 100)
        self.scale_lbl.config(text=f"{self.problems[i].scale * 100:.0f}%")
        own = [pi for d, pi, _ in self.problems[i].segments if d is self.doc]
        self.show_src(own[0] if own else self.src_page)
        self.refresh_output()

    def move(self, d):
        i = self.current()
        if i is None or not 0 <= i + d < len(self.problems):
            return
        self.problems[i], self.problems[i + d] = self.problems[i + d], self.problems[i]
        self.refresh_list(i + d)
        self.select(i + d)

    def merge_next(self):
        i = self.current()
        if i is None or i + 1 >= len(self.problems):
            return
        self.problems[i].segments += self.problems.pop(i + 1).segments
        self.refresh_list(i)
        self.select(i)

    def delete(self):
        i = self.current()
        if i is None:
            return
        self.problems.pop(i)
        self.refresh_list(i)
        self.select(self.current())

    def scale_changed(self):
        i = self.current()
        if i is None:
            return
        self.problems[i].scale = round(self.scale_var.get()) / 100
        self.scale_lbl.config(text=f"{self.problems[i].scale * 100:.0f}%")
        self.refresh_list(i)
        self.refresh_output()

    def scale_all(self):
        s = round(self.scale_var.get()) / 100
        for p in self.problems:
            p.scale = s
        self.refresh_list(self.current())
        self.refresh_output()

    # ------------------------------------------------------------ source view
    def show_src(self, n):
        c = self.src_canvas
        c.delete("all")
        self.drawn = None
        if not self.doc:
            return
        n = max(0, min(n, self.doc.page_count - 1))
        self.src_page = n
        page = self.doc[n]
        self.src_zoom = min(VIEW_H / page.rect.height, int(c["width"]) / page.rect.width)
        self.src_img = page_photo(page, self.src_zoom)
        c.create_image(0, 0, image=self.src_img, anchor="nw")
        self.page_lbl.config(text=f"Original  page {n + 1} / {self.doc.page_count}")
        cur = self.current()
        for k, p in enumerate(self.problems):
            for d, pi, r in p.segments:
                if d is self.doc and pi == n:
                    color, w = ("#d22", 2) if k == cur else ("#69c", 1)
                    c.create_rectangle(*[v * self.src_zoom for v in r], outline=color, width=w)

    def drag_begin(self, e):
        self.drag_start = (e.x, e.y)
        self.src_canvas.delete("drag")

    def drag_move(self, e):
        if self.drag_start:
            self.src_canvas.delete("drag")
            self.src_canvas.create_rectangle(*self.drag_start, e.x, e.y, outline="#2a2",
                                             width=2, dash=(4, 2), tags="drag")

    def drag_end(self, e):
        if not self.drag_start or not self.doc:
            return
        r = fitz.Rect(*self.drag_start, e.x, e.y)
        r.normalize()
        self.drag_start = None
        if r.width < 8 or r.height < 8:
            self.src_canvas.delete("drag")
            self.drawn = None
            return
        self.drawn = (self.doc, self.src_page, r * (1 / self.src_zoom) & self.doc[self.src_page].rect)

    def _need_box(self):
        if not self.drawn:
            messagebox.showinfo("HW Formatter", "First drag a box around the part you want on the left page.")
            return False
        return True

    def box_replace(self):
        i = self.current()
        if i is None or not self._need_box():
            return
        self.problems[i].segments = [self.drawn]
        self.refresh_list(i)
        self.select(i)

    def box_add(self):
        i = self.current()
        if i is None or not self._need_box():
            return
        self.problems[i].segments.append(self.drawn)
        self.refresh_list(i)
        self.select(i)

    def box_new(self):
        if not self._need_box():
            return
        i = self.current()
        i = -1 if i is None else i
        base = self.problems[i] if self.problems else None
        p = hwcore.Problem((base.title + " (part)") if base else "Problem",
                           base.number if base else "",
                           [self.drawn], base.scale if base else self.settings["scale"])
        self.problems.insert(i + 1, p)
        self.refresh_list(i + 1)
        self.select(i + 1)

    # ------------------------------------------------------------ output view
    def header(self):
        return {"name": self.vars["name"].get().strip(), "cls": self.vars["cls"].get().strip(),
                "hw": self.vars["hw"].get().strip(), "date": self.vars["date"].get().strip(),
                "problem_in_header": self.pnum.get()}

    def refresh_output(self):
        if not hasattr(self, "out_canvas"):
            return
        c = self.out_canvas
        c.delete("all")
        i = self.current()
        if not self.doc or i is None or i >= len(self.problems):
            return
        out = hwcore.build_pdf([self.problems[i]], self.header())
        zoom = VIEW_H / out[0].rect.height
        self.out_img = page_photo(out[0], zoom)
        c.create_image(0, 0, image=self.out_img, anchor="nw")
        extra = f" (+{out.page_count - 1} more page)" if out.page_count > 1 else ""
        self.out_lbl.config(text=f"Output preview: {self.problems[i].title}{extra}")

    # ------------------------------------------------------------ export
    def do_export(self):
        if not self.doc or not self.problems:
            return
        h = self.header()
        try:
            pdf, png_dir = hwcore.export(self.path, self.problems, h, self.settings["png_dpi"])
        except Exception as e:
            messagebox.showerror("HW Formatter", f"Export failed:\n{e}")
            return
        self.settings.update(name=h["name"], last_class=h["cls"], problem_in_header=h["problem_in_header"],
                             scale=self.problems[0].scale)
        hwcore.save_settings(self.settings)
        if messagebox.askyesno("HW Formatter", f"Saved:\n{pdf}\n\nProblem pictures:\n{png_dir}\n\nOpen the folder?"):
            os.startfile(os.path.dirname(pdf))


def main():
    try:  # sharp text on high-DPI screens
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--auto" in sys.argv:
        s = hwcore.load_settings()
        for path in args:
            doc = fitz.open(path)
            probs = hwcore.detect_problems(doc, s)
            cls, hw = hwcore.guess_header(doc, path, s)
            h = {"name": s["name"], "cls": cls, "hw": hw, "date": hwcore.today(),
                 "problem_in_header": s["problem_in_header"]}
            print(f"{os.path.basename(path)}: {len(probs)} problems ->",
                  hwcore.export(path, probs, h, s["png_dpi"])[0])
        return
    App(args[0] if args else None).mainloop()


if __name__ == "__main__":
    main()
