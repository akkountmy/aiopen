"""PDF → PNG по страницам, чтобы смотреть деку глазами (единственный рендерер в проекте).

    python scripts/pdf2png.py <pdf> <каталог> [масштаб]

Масштаб 1.2 даёт примерно 1440 px по ширине слайда 1600×900 — хватает, чтобы
проверить раскладку и не читать пиксели на глаз.
"""
import sys
from pathlib import Path

import pymupdf


def main() -> int:
    pdf = Path(sys.argv[1])
    out = Path(sys.argv[2])
    zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    out.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(pdf)
    for index, page in enumerate(doc, start=1):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        pix.save(out / f"p{index:02d}.png")
    print(f"страниц: {doc.page_count}, снимки в {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
