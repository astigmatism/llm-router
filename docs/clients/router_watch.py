"""Reference client for LLM Router capability changes (Python 3.9+, standard library only).

Copy this file into a project, or port it. One RouterWatch per process; share it.

    watch = RouterWatch("http://192.168.1.4:11434", on_change=lambda doc: log(doc["configuration"]))
    watch.fetch()                                    # at startup; tolerate failure
    threading.Thread(target=watch.run_forever, daemon=True).start()

    service = resolve(watch.doc, "nighttime", ["daytime"])          # by name, with fallbacks
    service = pick_service(watch.doc, nsfw=True, fallback_any=True)  # or by capability
    if service == WAIT: ...                          # router draining: wait, do not switch
    elif service == UNAVAILABLE: ...                 # nothing usable: retry later
    else: limits = model_for(watch.doc, service)     # send `service` as the model ID

On a failed request, classify_error(status, body) says what to do next.
Contract: docs/CAPABILITIES.md in https://github.com/astigmatism/llm-router.
"""
import json
import threading
import time
import urllib.error
import urllib.request

WAIT = "wait"                # router draining or in maintenance: hold the request, keep the model
UNAVAILABLE = "unavailable"  # no preferred or fallback service is usable right now

FALLBACK = "fallback"        # this service cannot serve now; resolve again (the fallback is chosen)
RETRY = "retry"              # transient; retry the same service with backoff
FAIL = "fail"                # the request itself is wrong; do not retry or switch

_FALLBACK_CODES = {"SERVICE_OFFLINE", "BACKEND_UNAVAILABLE", "MODEL_NOT_FOUND"}
_WAIT_CODES = {"BACKEND_DRAINING", "MAINTENANCE_MODE"}


def resolve(doc, preferred, fallbacks=()):
    """Return the stable service ID to send, WAIT, or UNAVAILABLE.

    With no document yet (router unreachable at startup), return the preferred
    ID and let classify_error() decide after the request.
    """
    if doc is None:
        return preferred
    if not doc["router"]["accepting_requests"]:
        return WAIT
    for service in (preferred, *fallbacks):
        model = next((m for m in doc["models"] if service == m["id"] or service in m["aliases"]), None)
        if model and model["available"]:
            return service
    return UNAVAILABLE


_FEATURES = {
    "vision": lambda m: "image" in (m.get("input_modalities") or []),
    "tools": lambda m: "tools" in (m.get("capabilities") or []),
    "reasoning": lambda m: "thinking" in (m.get("capabilities") or []),
}


def pick_service(doc, *, nsfw=None, require=(), exclude=(), fallback_any=False):
    """The most capable usable service matching the filters, WAIT, or UNAVAILABLE.

    nsfw: True selects only models declared NSFW (abliterated), False only models
    declared not NSFW, None either. require: features the request needs, from
    "vision", "tools", "reasoning". exclude: service IDs that just failed.
    fallback_any: when no model matches `nsfw`, use the most capable usable model.
    Models rank by capability_score, then context_window.
    """
    if doc is None:
        return UNAVAILABLE
    if not doc["router"]["accepting_requests"]:
        return WAIT
    unknown = [feature for feature in require if feature not in _FEATURES]
    if unknown:
        raise ValueError("unknown required feature: " + ", ".join(unknown))
    usable = [m for m in doc["models"] if m["available"] and m["service"] not in exclude
              and m["id"] not in exclude and all(_FEATURES[f](m) for f in require)]
    rank = lambda m: (m.get("capability_score") is not None, m.get("capability_score") or 0, m.get("context_window") or 0)
    matching = [m for m in usable if nsfw is None or m.get("nsfw") is nsfw]
    candidates = matching or (usable if fallback_any else [])
    return max(candidates, key=rank)["service"] if candidates else UNAVAILABLE


def model_for(doc, service):
    """Limits and capabilities of the model a stable ID targets right now, or None."""
    canonical = (doc or {}).get("ids", {}).get(service)
    return next((m for m in (doc or {}).get("models", []) if m["id"] == canonical), None)


def error_code(body):
    """The router's error code from a JSON error body, or None (legacy string errors)."""
    try:
        if isinstance(body, (bytes, str)):
            body = json.loads(body)
        error = body.get("error") if isinstance(body, dict) else None
        return error.get("code") if isinstance(error, dict) else None
    except (ValueError, AttributeError):
        return None


def classify_error(status, body=None):
    """FALLBACK, WAIT, RETRY, or FAIL for an HTTP status (None = network error) and body."""
    code = error_code(body)
    if code in _WAIT_CODES:
        return WAIT
    if code in _FALLBACK_CODES:
        return FALLBACK
    if status is None or status in (408, 429) or status >= 500:
        return RETRY
    return FAIL


class RouterWatch:
    def __init__(self, base_url="http://192.168.1.4:11434", on_change=None, poll_seconds=30):
        self.base = base_url.rstrip("/")
        self.on_change = on_change or (lambda doc: None)
        self.poll_seconds = poll_seconds
        self.doc = None
        self._etag = None
        self._lock = threading.Lock()

    def _set(self, doc):
        with self._lock:
            changed = self.doc is None or doc["revision"] != self.doc["revision"]
            self.doc = doc
        if changed:
            self.on_change(doc)

    def fetch(self):
        """GET the document. Use at startup and as the fallback while the stream is down."""
        headers = {"Accept": "application/json"}
        if self._etag:
            headers["If-None-Match"] = self._etag
        request = urllib.request.Request(self.base + "/v1/router/capabilities", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                self._etag = response.headers.get("ETag")
                self._set(json.load(response))
        except urllib.error.HTTPError as error:
            if error.code != 304:
                raise
        return self.doc

    def _follow(self, stop=None):
        """Read /v1/router/events until it ends or `stop` is set. Returns the retry hint in seconds.

        The router sends a keepalive every 15 s, so a stop request is seen within that time.
        """
        retry = 3
        request = urllib.request.Request(self.base + "/v1/router/events", headers={"Accept": "text/event-stream"})
        # Keepalives arrive every 15 s; 60 s of silence means the connection is dead.
        with urllib.request.urlopen(request, timeout=60) as stream:
            event, data = None, []
            for raw in stream:
                if stop is not None and stop.is_set():
                    break
                line = raw.decode("utf-8").rstrip("\r\n")
                if line == "":
                    if event == "capabilities" and data:
                        self._set(json.loads("\n".join(data)))
                    event, data = None, []
                elif line.startswith(":"):
                    continue
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip(" "))
                elif line.startswith("retry:"):
                    retry = max(1, int(line[6:].strip()) // 1000)
        return retry

    def run_forever(self, stop=None):
        """Follow the event stream; while it is down, poll and reconnect with backoff.

        Run it in a daemon thread. Setting `stop` ends it within one keepalive interval.
        """
        delay = 3
        while not (stop and stop.is_set()):
            try:
                delay = self._follow(stop)
            except Exception:
                delay = min(delay * 2, self.poll_seconds)
            try:
                self.fetch()
            except Exception:
                pass
            if stop is not None:
                if stop.wait(delay):
                    return
            else:
                time.sleep(delay)
