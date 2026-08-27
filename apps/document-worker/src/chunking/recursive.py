"""Recursive character splitting with overlap (LangChain-style, self-contained)."""
from __future__ import annotations

DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]


class RecursiveSplitter:
    def __init__(self, chunk_size: int = 800, chunk_overlap: int = 80) -> None:
        self.chunk_size = chunk_size
        self.chunk_overlap = max(0, min(chunk_overlap, chunk_size - 1))

    def split_text(self, text: str, separators: list[str] | None = None) -> list[str]:
        text = text.strip()
        if not text:
            return []
        if len(text) <= self.chunk_size:
            return [text]

        seps = separators or DEFAULT_SEPARATORS
        final_chunks: list[str] = []
        # _split produces (text, parent_splits) where parent_splits is the path of separators
        # used to reach this text; we flatten them for simplicity.
        for chunk, _ in self._split(text, seps):
            final_chunks.extend(self._merge_splits(chunk.split("\n"), "\n"))
        return [c for c in final_chunks if c.strip()]

    def _split(self, text: str, separators: list[str]) -> list[tuple[str, list[str]]]:
        final_chunks: list[tuple[str, list[str]]] = []
        separator = separators[-1]
        new_separators: list[str] = []
        for i, sep in enumerate(separators):
            if sep == "":
                separator = sep
                break
            if sep in text:
                separator = sep
                new_separators = separators[i + 1 :]
                break

        if separator:
            splits = text.split(separator)
        else:
            splits = list(text)

        good_splits: list[str] = []
        for s in splits:
            if len(s) < self.chunk_size:
                good_splits.append(s)
            else:
                if good_splits:
                    merged = self._merge_splits(good_splits, separator)
                    final_chunks.extend((m, [separator]) for m in merged)
                    good_splits = []
                if not new_separators:
                    final_chunks.append((s, []))
                else:
                    final_chunks.extend(self._split(s, new_separators))
        if good_splits:
            merged = self._merge_splits(good_splits, separator)
            final_chunks.extend((m, [separator]) for m in merged)
        return final_chunks

    def _merge_splits(self, splits: list[str], separator: str) -> list[str]:
        separator_len = len(separator)
        docs: list[str] = []
        current: list[str] = []
        total = 0

        for d in splits:
            add_len = len(d) + (separator_len if current else 0)
            if total + add_len > self.chunk_size and total > 0:
                if total > self.chunk_size:
                    # A single piece is larger than the target; keep it whole.
                    docs.append("".join(current) or d)
                    current = [d]
                    total = len(d)
                    continue
                docs.append(separator.join(current))
                # Carry overlap from the tail of the current chunk.
                carry = self._overlap_text(separator.join(current))
                current = [carry] if carry else []
                total = len(current[0]) if current else 0
            current.append(d)
            total += add_len

        if current:
            docs.append(separator.join(current))
        return [d for d in docs if d.strip()]

    def _overlap_text(self, text: str) -> str:
        if self.chunk_overlap <= 0 or len(text) <= self.chunk_overlap:
            return ""
        return text[-self.chunk_overlap :]
