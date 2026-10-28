import os
import sys
import unittest
from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1])
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from agents.url_safety import require_safe_http_url


class UrlSafetyTests(unittest.TestCase):
    def test_https_endpoint_is_allowed(self):
        self.assertEqual(
            require_safe_http_url("https://llm.bankr.bot/v1/chat/completions"),
            "https://llm.bankr.bot/v1/chat/completions",
        )

    def test_loopback_http_is_allowed_for_local_tests(self):
        self.assertEqual(
            require_safe_http_url("http://127.0.0.1:8080/mock"),
            "http://127.0.0.1:8080/mock",
        )
        self.assertEqual(
            require_safe_http_url("http://localhost:8080/mock"),
            "http://localhost:8080/mock",
        )

    def test_non_network_schemes_are_rejected(self):
        for url in ("file:///etc/passwd", "ftp://example.com/data", "data:text/plain,secret"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    require_safe_http_url(url)

    def test_external_plain_http_is_rejected(self):
        with self.assertRaises(ValueError):
            require_safe_http_url("http://example.com/api")

    def test_embedded_credentials_fragments_and_bad_ports_are_rejected(self):
        cases = (
            "https://" + "user" + ":" + "pass" + "@example.com/api",
            "https://example.com/api#fragment",
            "https://example.com:invalid/api",
            " https://example.com/api",
        )
        for url in cases:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    require_safe_http_url(url)


if __name__ == "__main__":
    unittest.main()
