"""OCR fallback for scanned (image-only) PDF pages."""
from __future__ import annotations

import io
import logging

import pytesseract
from PIL import Image

from src.domain import ParsedPage

logger = logging.getLogger(__name__)

MIN_TEXT_LENGTH = 20


def _page_needs_ocr(page_text: str) -> bool:
    return len(page_text.strip()) < MIN_TEXT_LENGTH


async def ocr_page_image(page, language: str = "eng") -> str:
    """Render a PyMuPDF page to an image and run Tesseract OCR on it."""
    pix = page.get_pixmap(dpi=300)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    return pytesseract.image_to_string(img, lang=language)


async def maybe_ocr(page, page_number: int, ocr_enabled: bool) -> ParsedPage:
    text = page.get_text("text")
    if _page_needs_ocr(text) and ocr_enabled:
        logger.info("page %d has little embedded text, running OCR", page_number)
        try:
            text = await ocr_page_image(page)
        except Exception as exc:  # noqa: BLE001 - OCR is best effort; a missing Tesseract must not fail the job
            # pragma: no cover - tesseract may be missing
            logger.warning("OCR failed on page %d: %s", page_number, exc)
    return ParsedPage(number=page_number, text=text)
