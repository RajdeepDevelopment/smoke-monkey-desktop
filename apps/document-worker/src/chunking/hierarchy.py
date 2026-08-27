"""Parent-child chunking.

Parent  = a full PDF page (or a heading-delimited section) — kept for context
          expansion at query time (no embedding, cheap to store).
Children = recursive splits of the parent with ~10% overlap — embedded and
          searched, and each one carries its source page number for citations.
"""
from __future__ import annotations

from dataclasses import dataclass

from src.chunking.recursive import RecursiveSplitter
from src.domain import ParsedDocument


@dataclass
class ChildChunk:
    content: str
    page_number: int


@dataclass
class ChunkGroup:
    parent_content: str
    section: str
    children: list[ChildChunk]


def _section_map(toc: list[tuple[int, str, int]], page_count: int) -> dict[int, str]:
    """Map each 1-based page number to the most recent heading that precedes it."""
    if not toc:
        return {p: f"Page {p}" for p in range(1, page_count + 1)}
    headings: list[tuple[int, str]] = []
    for level, title, page in toc:
        if level <= 2:
            headings.append((page, title))
    if not headings:
        return {p: f"Page {p}" for p in range(1, page_count + 1)}

    mapping: dict[int, str] = {}
    current = headings[0][1]
    next_heading = headings[0][0]
    for p in range(1, page_count + 1):
        while next_heading <= p and headings and headings[0][0] <= p:
            current = headings[0][1]
            headings.pop(0)
        mapping[p] = current or f"Page {p}"
    return mapping


def build_chunk_hierarchy(
    doc: ParsedDocument,
    chunk_size: int = 800,
    chunk_overlap: int = 80,
) -> list[ChunkGroup]:
    splitter = RecursiveSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    sections = _section_map(doc.toc, len(doc.pages))
    groups: list[ChunkGroup] = []

    for page in doc.pages:
        text = page.text.strip()
        if not text:
            continue
        children = [
            ChildChunk(content=c, page_number=page.number)
            for c in splitter.split_text(text)
            if c.strip()
        ]
        if not children:
            continue
        groups.append(
            ChunkGroup(
                parent_content=text,
                section=sections.get(page.number, f"Page {page.number}"),
                children=children,
            )
        )
    return groups
