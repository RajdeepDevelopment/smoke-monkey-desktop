"""Live web context across multiple search providers (Tavily, Google, Brave,
Bing, DuckDuckGo).

Every provider is a small adapter behind one interface, and the client queries
*all* configured providers for a request and merges the results — if the user
has keys for several tools, all of them contribute. Key resolution follows the
platform-wide rule: the user's own key wins, else the server default (only the
keyless DuckDuckGo provider has neither).

Credit hygiene matters here — the user's Tavily/Google keys have finite monthly
quotas (Tavily's free tier is ~1k searches/month). So:

- results are cached in Redis (``rag:websearch:v1:{query}:{providers}``) for a
  configurable TTL, so repeated queries never hit a paid API twice;
- search depth for Tavily defaults to ``basic`` (1 credit, not the 2-credit
  ``advanced``);
- providers are only queried when the router asked for web (pipeline-gated).

Every failure degrades to an empty result set, so live context never breaks a
chat turn.
"""
from __future__ import annotations

import asyncio
import hashlib
import html as html_lib
import json
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx

from src.keys import resolve_user_api_key

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(15.0)
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

DDG_INSTANT_ANSWER_URL = "https://api.duckduckgo.com/"
DDG_HTML_URL = "https://html.duckduckgo.com/html/"

_SNIPPET_RE = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class WebSearchResult:
    """One structured web hit. ``score`` is provider-specific relevance (1.0 default)."""

    title: str
    url: str
    content: str
    provider: str
    score: float = 1.0


@dataclass
class WebSearchProvider(ABC):
    """Base class for a web search adapter."""

    id: str = ""
    label: str = ""
    requires_key: bool = True

    @abstractmethod
    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        """Run one search; must never raise (return [] on any failure)."""


def _safe_text(value: Any, limit: int = 300) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit]


class TavilySearchProvider(WebSearchProvider):
    id = "tavily"
    label = "Tavily"
    requires_key = True

    def __init__(self, api_key: str = "", search_depth: str = "basic") -> None:
        self.server_key = api_key
        self.search_depth = search_depth

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        if not api_key:
            return []
        resp = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": api_key,
                "query": query,
                "search_depth": self.search_depth,
                "max_results": top_k,
                "include_answer": False,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        results: list[WebSearchResult] = []
        for item in data.get("results") or []:
            url = str(item.get("url") or "").strip()
            title = _safe_text(item.get("title") or "")
            content = _safe_text(item.get("content") or "")
            if not url and not content:
                continue
            try:
                score = float(item.get("score") or 1.0)
            except (TypeError, ValueError):
                score = 1.0
            results.append(
                WebSearchResult(title=title, url=url, content=content, provider=self.id, score=score)
            )
        return results


class GoogleSearchProvider(WebSearchProvider):
    id = "google"
    label = "Google Custom Search"
    requires_key = True

    def __init__(self, api_key: str = "", cx: str = "") -> None:
        self.server_key = api_key
        self.cx = cx

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        if not api_key or not self.cx:
            return []
        resp = await client.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"key": api_key, "cx": self.cx, "q": query, "num": min(max(1, top_k), 10)},
        )
        resp.raise_for_status()
        data = resp.json()
        results: list[WebSearchResult] = []
        for item in data.get("items") or []:
            url = str(item.get("link") or "").strip()
            title = _safe_text(item.get("title") or "")
            content = _safe_text(item.get("snippet") or "")
            if not url and not content:
                continue
            results.append(
                WebSearchResult(title=title, url=url, content=content, provider=self.id)
            )
        return results


class BraveSearchProvider(WebSearchProvider):
    id = "brave"
    label = "Brave Search"
    requires_key = True

    def __init__(self, api_key: str = "") -> None:
        self.server_key = api_key

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        if not api_key:
            return []
        resp = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": top_k},
            headers={"X-Subscription-Token": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        results: list[WebSearchResult] = []
        for item in (data.get("web") or {}).get("results") or []:
            url = str(item.get("url") or "").strip()
            title = _safe_text(item.get("title") or "")
            content = _safe_text(item.get("description") or "")
            if not url and not content:
                continue
            results.append(
                WebSearchResult(title=title, url=url, content=content, provider=self.id)
            )
        return results


class BingSearchProvider(WebSearchProvider):
    id = "bing"
    label = "Bing Web Search"
    requires_key = True

    def __init__(self, api_key: str = "") -> None:
        self.server_key = api_key

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        if not api_key:
            return []
        resp = await client.get(
            "https://api.bing.microsoft.com/v7.0/search",
            params={"q": query, "count": top_k},
            headers={"Ocp-Apim-Subscription-Key": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        results: list[WebSearchResult] = []
        for item in (data.get("webPages") or {}).get("value") or []:
            url = str(item.get("url") or "").strip()
            title = _safe_text(item.get("name") or "")
            content = _safe_text(item.get("snippet") or "")
            if not url and not content:
                continue
            results.append(
                WebSearchResult(title=title, url=url, content=content, provider=self.id)
            )
        return results


class DuckDuckGoSearchProvider(WebSearchProvider):
    id = "duckduckgo"
    label = "DuckDuckGo"
    requires_key = False

    @staticmethod
    def _topics_text(topics: list) -> list[WebSearchResult]:
        out: list[WebSearchResult] = []
        for topic in topics:
            if isinstance(topic, dict) and topic.get("Text"):
                out.append(WebSearchResult("", "", _safe_text(topic["Text"], 400), "duckduckgo"))
            if isinstance(topic, dict) and isinstance(topic.get("Topics"), list):
                for sub in topic["Topics"]:
                    if isinstance(sub, dict) and sub.get("Text"):
                        out.append(WebSearchResult("", "", _safe_text(sub["Text"], 400), "duckduckgo"))
        return out

    @staticmethod
    def _snippets_from_html(page: str) -> list[WebSearchResult]:
        out: list[WebSearchResult] = []
        for match in _SNIPPET_RE.findall(page):
            text = html_lib.unescape(_TAG_RE.sub("", match))
            text = " ".join(text.split())
            if text:
                out.append(WebSearchResult("", "", _safe_text(text, 400), "duckduckgo"))
        return out

    async def search(
        self,
        client: httpx.AsyncClient,
        query: str,
        top_k: int,
        api_key: str | None,
    ) -> list[WebSearchResult]:
        try:
            resp = await client.get(
                DDG_INSTANT_ANSWER_URL,
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            )
            resp.raise_for_status()
            data = resp.json()
            results: list[WebSearchResult] = []
            abstract = _safe_text(data.get("AbstractText") or "", 400)
            if abstract:
                results.append(WebSearchResult("", "", abstract, "duckduckgo"))
            definition = _safe_text(data.get("Definition") or "", 400)
            if definition and definition not in [r.content for r in results]:
                results.append(WebSearchResult("", "", definition, "duckduckgo"))
            results.extend(self._topics_text(data.get("RelatedTopics") or []))
            if results:
                return results
        except Exception:  # web context is optional
            logger.debug("duckduckgo instant answer failed", exc_info=True)
        try:
            resp = await client.post(DDG_HTML_URL, data={"q": query, "kl": "us-en"})
            resp.raise_for_status()
            return self._snippets_from_html(resp.text)
        except Exception:  # web context is optional
            logger.debug("duckduckgo html search failed", exc_info=True)
            return []


def format_web_result(result: WebSearchResult) -> str:
    """One formatted live-context line for the generation prompt."""
    if result.title and result.url:
        return f"{result.title} — {result.url}\n{result.content}" if result.content else f"{result.title} — {result.url}"
    if result.url:
        return f"{result.url}\n{result.content}" if result.content else result.url
    return result.content


class WebSearchClient:
    """Queries all configured providers and merges the results.

    Key resolution per provider: user's saved key (Redis, ``rag:user_key``) >
    server default (from settings). Providers without any key are skipped,
    except DuckDuckGo which needs no key and acts as the free fallback when it
    is enabled. Results are cached in Redis for ``cache_ttl`` seconds so repeat
    queries do not burn provider quota.
    """

    def __init__(
        self,
        top_k: int = 5,
        *,
        redis: Any = None,
        providers: list[str] | None = None,
        cache_ttl: int = 21600,
        server_keys: dict[str, str] | None = None,
        google_cx: str = "",
        tavily_search_depth: str = "basic",
    ) -> None:
        self.top_k = top_k
        self._redis = redis
        self._cache_ttl = cache_ttl
        server_keys = server_keys or {}
        self._registry: dict[str, WebSearchProvider] = {
            "tavily": TavilySearchProvider(server_keys.get("tavily", ""), tavily_search_depth),
            "google": GoogleSearchProvider(server_keys.get("google", ""), google_cx),
            "brave": BraveSearchProvider(server_keys.get("brave", "")),
            "bing": BingSearchProvider(server_keys.get("bing", "")),
            "duckduckgo": DuckDuckGoSearchProvider(),
        }
        self._order = [p for p in (providers or ["tavily", "google", "brave", "bing", "duckduckgo"]) if p in self._registry]
        if "duckduckgo" not in self._order:
            self._order.append("duckduckgo")
        self._client = httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=True,
            headers={"user-agent": _UA},
        )

    def _cache_key(self, query: str, active: list[str]) -> str:
        digest = hashlib.sha256(query.encode()).hexdigest()[:16]
        return f"rag:websearch:v2:{digest}:{','.join(active)}"

    @staticmethod
    def _format(result: WebSearchResult) -> str:
        return format_web_result(result)

    async def _provider_key(self, user_id: str | None, provider: WebSearchProvider) -> str | None:
        if not provider.requires_key:
            return None
        return await resolve_user_api_key(
            self._redis,
            user_id,
            provider.id,
            server_default=getattr(provider, "server_key", ""),
        )

    async def search_results(
        self,
        query: str,
        top_k: int | None = None,
        user_id: str | None = None,
    ) -> list[WebSearchResult]:
        """Run the search and return deduped, structured results.

        This is the structured counterpart of :meth:`search` — the pipeline uses
        it to surface web sources in the UI while ``search()`` keeps returning
        the compact formatted lines the system prompt needs.
        """
        limit = top_k or self.top_k
        query = (query or "").strip()
        if not query:
            return []

        # Resolve which providers are actually usable for this request first.
        active: list[str] = []
        tasks: list[tuple[WebSearchProvider, str | None]] = []
        for provider_id in self._order:
            provider = self._registry[provider_id]
            key = await self._provider_key(user_id, provider)
            if provider.requires_key and not key:
                continue
            active.append(provider_id)
            tasks.append((provider, key))
        if not tasks:
            logger.debug("no web search provider available for user=%s", user_id)
            return []

        cache_key = self._cache_key(query, active)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return [WebSearchResult(**item) for item in cached[:limit]]

        raw: list[list[WebSearchResult]] = [[] for _ in tasks]

        async def _run(index: int, provider: WebSearchProvider, key: str | None) -> None:
            try:
                raw[index] = await provider.search(self._client, query, limit, key)
            except Exception:  # web context is optional
                logger.debug("%s web search failed", provider.id, exc_info=True)

        await asyncio.gather(*[_run(i, p, k) for i, (p, k) in enumerate(tasks)])

        seen_urls: set[str] = set()
        seen_text: set[str] = set()
        merged: list[WebSearchResult] = []
        for results in raw:
            for result in results:
                if result.url:
                    if result.url in seen_urls:
                        continue
                    seen_urls.add(result.url)
                else:
                    if result.content in seen_text:
                        continue
                    seen_text.add(result.content)
                merged.append(result)
        merged = merged[:limit]

        if merged and self._redis is not None:
            await self._cache_set(cache_key, [r.__dict__ for r in merged])

        return merged

    async def search(
        self,
        query: str,
        top_k: int | None = None,
        user_id: str | None = None,
    ) -> list[str]:
        """Return merged, deduped, formatted live-context lines for a query."""
        results = await self.search_results(query, top_k, user_id)
        return [self._format(r) for r in results]

    async def _cache_get(self, key: str) -> list[str] | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(key)
            if not raw:
                return None
            value = json.loads(raw)
            return value if isinstance(value, list) else None
        except Exception:  # noqa: BLE001 - caching is best-effort
            return None

    async def _cache_set(self, key: str, value: list[str]) -> None:
        try:
            await self._redis.set(key, json.dumps(value), ex=self._cache_ttl)
        except Exception:  # caching is best-effort
            logger.debug("web search cache write failed", exc_info=True)

    async def aclose(self) -> None:
        await self._client.aclose()


# Re-export for convenience.
PROVIDER_IDS = ("tavily", "google", "brave", "bing", "duckduckgo")


def web_search_user_setting_key(user_id: str | None) -> str:
    return f"rag:user_setting:{user_id}:web_search"


async def web_search_enabled_for(
    redis: Any,
    user_id: str | None,
    require_optin: bool = True,
) -> bool:
    """Whether live web search may run for this user.

    The server-level ``WEB_SEARCH_ENABLED`` gate is checked separately by the
    caller; this only reflects the per-user toggle, so one user can opt in while
    another stays fully offline. When ``require_optin`` is false the feature is
    treated as on for every authenticated user (still off for anonymous ones).
    """
    if redis is None or not user_id:
        return False
    if not require_optin:
        return True
    try:
        value = await redis.get(web_search_user_setting_key(user_id))
        return value == "1"
    except Exception:  # web search setting must never break the request
        logger.debug("web search user setting lookup failed", exc_info=True)
        return False
