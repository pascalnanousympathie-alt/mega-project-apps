"""Validate URLs passed to urllib before creating network requests."""
from urllib.parse import urlsplit

_LOCAL_HTTP_HOSTS = {"localhost", "127.0.0.1", "::1"}


def require_safe_http_url(url: str) -> str:
    """Return a checked HTTP(S) URL; plain HTTP is permitted only for loopback tests.

    This prevents urllib's file:// handler and other non-network schemes from
    being reached through an environment-configured endpoint. Endpoint host
    configuration remains an operator responsibility.
    """
    if not isinstance(url, str) or not url or url != url.strip() or len(url) > 4096:
        raise ValueError("Endpoint URL is invalid")
    if any(ord(ch) < 0x20 for ch in url):
        raise ValueError("Endpoint URL contains control characters")
    try:
        parsed = urlsplit(url)
        _ = parsed.port  # Accessing this validates the port syntax.
    except ValueError as exc:
        raise ValueError("Endpoint URL is invalid") from exc
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("Endpoint URL must contain a host and no embedded credentials")
    if parsed.fragment:
        raise ValueError("Endpoint URL must not contain a fragment")
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and parsed.hostname.lower() in _LOCAL_HTTP_HOSTS:
        return url
    raise ValueError("Endpoint URL must use HTTPS (HTTP is allowed only for loopback tests)")
