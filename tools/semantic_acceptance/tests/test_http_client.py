from __future__ import annotations

import unittest

from tools.semantic_acceptance.http_client import (
    validate_base_url,
    validate_secret_env_name,
)


class HttpClientSafetyTest(unittest.TestCase):
    def test_allows_loopback_http_and_remote_https(self) -> None:
        self.assertEqual(
            validate_base_url("http://127.0.0.1:3000/api/v1/"),
            "http://127.0.0.1:3000/api/v1",
        )
        self.assertEqual(
            validate_base_url("https://acceptance.example.test/api/v1"),
            "https://acceptance.example.test/api/v1",
        )

    def test_rejects_credentials_redirectable_query_and_remote_plaintext(self) -> None:
        with self.assertRaisesRegex(ValueError, "embedded"):
            validate_base_url("https://token@example.test/api")
        with self.assertRaisesRegex(ValueError, "query"):
            validate_base_url("https://example.test/api?token=value")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_base_url("http://192.0.2.10/api")

    def test_secret_name_cannot_be_a_value_or_shell_expression(self) -> None:
        self.assertEqual(
            validate_secret_env_name("SEMANTIC_ACCEPTANCE_API_TOKEN"),
            "SEMANTIC_ACCEPTANCE_API_TOKEN",
        )
        with self.assertRaises(ValueError):
            validate_secret_env_name("secret-token-value")
        with self.assertRaises(ValueError):
            validate_secret_env_name("$env:TOKEN")


if __name__ == "__main__":
    unittest.main()
