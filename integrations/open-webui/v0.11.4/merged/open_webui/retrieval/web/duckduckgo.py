from __future__ import annotations

import logging
import os
import threading
import time
import urllib.request

from open_webui.env import USE_SLIM
from open_webui.retrieval.web.main import SearchResult, get_filtered_results

log = logging.getLogger(__name__)

# Both native tools and legacy search call this adapter from worker threads.
# Protect the upstream providers across chats, not just one batch of queries.
_search_lock = threading.Lock()
_next_search_at = 0.0
_min_request_interval = max(0.0, float(os.getenv('DDGS_MIN_REQUEST_INTERVAL', '2.0')))


def search_duckduckgo(
    query: str,
    count: int,
    filter_list: list[str] | None = None,
    concurrent_requests: int | None = None,
    backend: str | None = 'auto',
) -> list[SearchResult]:
    """
    Search using DuckDuckGo's Search API and return the results as a list of SearchResult objects.
    Args:
        query (str): The query to search for
        count (int): The number of results to return
        backend (str): The search backend to use (auto, duckduckgo, google, brave, etc.)

    Returns:
        list[SearchResult]: A list of search results
    """
    if USE_SLIM:
        raise ValueError(
            'DDGS is unavailable in slim. Configure another web search provider in Admin Settings > Web Search.'
        )

    from ddgs import DDGS

    # The ddgs library (primp-based) does not auto-detect proxy env vars.
    # Resolve via stdlib getproxies() — same pattern as the other loaders.
    env_proxies = urllib.request.getproxies()
    proxy = env_proxies.get('https') or env_proxies.get('http')
    global _next_search_at
    with _search_lock:
        delay = _next_search_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        _next_search_at = time.monotonic() + _min_request_interval
        with DDGS(proxy=proxy) as ddgs:
            # DDGS 9.14 reads a class variable, so setting ddgs.threads is ignored.
            ddgs_class = type(ddgs)
            previous_threads = ddgs_class.threads
            ddgs_class.threads = concurrent_requests or 1
            try:
                search_results = ddgs.text(
                    query, safesearch='moderate', max_results=count, backend=backend or 'auto'
                )
            finally:
                ddgs_class.threads = previous_threads
    if filter_list:
        search_results = get_filtered_results(search_results, filter_list)

    # Return the list of search results
    return [
        SearchResult(
            link=result['href'],
            title=result.get('title'),
            snippet=result.get('body'),
        )
        for result in search_results
    ]
