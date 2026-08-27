"""Unit tests for the recursive + parent-child chunking logic."""
from src.chunking.hierarchy import build_chunk_hierarchy
from src.chunking.recursive import RecursiveSplitter
from src.domain import ParsedDocument, ParsedPage


def test_recursive_splitter_respects_size_and_overlap():
    text = "word " * 500  # ~2500 chars
    splitter = RecursiveSplitter(chunk_size=200, chunk_overlap=20)
    chunks = splitter.split_text(text)
    assert len(chunks) >= 2
    assert all(len(c) <= 200 + 25 for c in chunks)
    assert all(c.strip() for c in chunks)


def test_recursive_splitter_short_text():
    splitter = RecursiveSplitter(chunk_size=800, chunk_overlap=80)
    assert splitter.split_text("hello world") == ["hello world"]


def test_recursive_splitter_empty():
    splitter = RecursiveSplitter(chunk_size=800, chunk_overlap=80)
    assert splitter.split_text("") == []


def test_hierarchy_builds_parent_children():
    pages = [
        ParsedPage(number=1, text="Alpha " * 400),
        ParsedPage(number=2, text="Beta " * 400),
    ]
    doc = ParsedDocument(pages=pages, toc=[(1, "Intro", 1)], filename="x.pdf")
    groups = build_chunk_hierarchy(doc, chunk_size=300, chunk_overlap=30)

    assert len(groups) == 2
    assert groups[0].section == "Intro"
    assert groups[0].children
    assert all(c.page_number == 1 for c in groups[0].children)
    assert groups[1].section == "Intro"
