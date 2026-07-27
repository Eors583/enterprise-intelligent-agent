from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# Keep the test process hermetic. Dotenv loading itself is covered with an isolated temp file.
os.environ.setdefault("AI_RUNTIME_DISABLE_DOTENV", "true")

from enterprise_ai_runtime.main import create_app  # noqa: E402


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def run_payload() -> dict[str, object]:
    return {
        "tenant_id": "tenant-a",
        "principal": {
            "principal_id": "user-1",
            "principal_type": "user",
            "roles": ["member"],
            "scopes": ["agent:run"],
        },
        "agent_id": "project-assistant",
        "agent_version": "2026-07-14.1",
        "input": {
            "messages": [{"role": "user", "content": "Summarize the project"}],
            "attachments": [],
            "variables": {"locale": "zh-CN"},
        },
        "budget": {
            "max_input_tokens": 16_000,
            "max_output_tokens": 2_000,
            "max_tool_calls": 5,
            "timeout_ms": 60_000,
            "max_cost_micros": 1_000_000,
        },
        "metadata": {"source": "desktop"},
    }
