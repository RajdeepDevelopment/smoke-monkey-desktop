"""PDF text + table extraction using PyMuPDF."""
from __future__ import annotations

import logging

import fitz  # PyMuPDF

from src.domain import ParsedDocument, ParsedPage
from src.parsers.ocr import maybe_ocr

logger = logging.getLogger(__name__)


def _tables_to_markdown(page) -> list[str]:
    """Convert page tables into a markdown-ish block so tables stay searchable."""
    blocks: list[str] = []
    try:
        finder = page.find_tables()
        for table in finder.tables:
            rows = table.extract()
            if not rows:
                continue
            header = rows[0]
            lines = [
                "| " + " | ".join(str(c or "") for c in header) + " |",
                "|" + "---|" * len(header),
            ]
            for row in rows[1:]:
                lines.append("| " + " | ".join(str(c or "") for c in row) + " |")
            blocks.append("\n".join(lines))
    except Exception as exc:  # noqa: BLE001 - table extraction is best effort
        # pragma: no cover - table extraction may fail on odd layouts
        logger.debug("table extraction skipped: %s", exc)
    return blocks


async def parse_pdf(path: str, filename: str, ocr_enabled: bool = False) -> ParsedDocument:
    doc = fitz.open(path)
    pages: list[ParsedPage] = []
    try:
        toc = doc.get_toc(simple=True)
        for number in range(doc.page_count):
            page = doc.load_page(number)
            parsed = await maybe_ocr(page, number + 1, ocr_enabled)
            tables = _tables_to_markdown(page)
            if tables:
                parsed.tables = tables
                parsed.text = (parsed.text + "\n\n" + "\n\n".join(tables)).strip()
            pages.append(parsed)
    finally:
        doc.close()

    logger.info("parsed %s: %d pages, %d toc entries", filename, len(pages), len(toc))
    return ParsedDocument(pages=pages, toc=toc, filename=filename)
