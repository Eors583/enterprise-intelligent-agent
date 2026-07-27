from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from enterprise_ai_runtime.adapters.noop_runtime import NoopRuntime
from enterprise_ai_runtime.adapters.provider_runtime import ProviderRuntime
from enterprise_ai_runtime.config import (
    EmbeddingDriver,
    RerankDriver,
    RuntimeDriver,
    RuntimeEnvironment,
    RuntimeSettings,
    StoreDriver,
    load_runtime_dotenv,
)
from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError
from enterprise_ai_runtime.main import build_runtime, build_store, create_app


def test_noop_is_the_safe_development_default() -> None:
    settings = RuntimeSettings.from_env({})
    assert settings.driver == RuntimeDriver.NOOP
    assert settings.store_driver == StoreDriver.MEMORY
    assert settings.embedding_driver == EmbeddingDriver.DISABLED
    assert settings.rerank_driver == RerankDriver.DISABLED
    assert settings.embedding_dimensions == 1536


def test_knowledge_providers_are_configured_independently_from_run_driver() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "manus-secret",
            "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
            "AI_RUNTIME_EMBEDDING_BASE_URL": "https://embedding.example/v1",
            "AI_RUNTIME_EMBEDDING_API_KEY": "embedding-secret",
            "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
            "AI_RUNTIME_RERANK_DRIVER": "cohere_compatible",
            "AI_RUNTIME_RERANK_BASE_URL": "https://rerank.example/v2",
            "AI_RUNTIME_RERANK_API_KEY": "rerank-secret",
            "AI_RUNTIME_RERANK_MODEL": "rerank-model",
        }
    )
    assert settings.driver == RuntimeDriver.MANUS
    assert settings.embedding_driver == EmbeddingDriver.OPENAI_COMPATIBLE
    assert settings.rerank_driver == RerankDriver.COHERE_COMPATIBLE
    rendered = repr(settings)
    assert "manus-secret" not in rendered
    assert "embedding-secret" not in rendered
    assert "rerank-secret" not in rendered


@pytest.mark.parametrize(
    ("environment", "base_url", "expected"),
    [
        ("development", "not-a-url", "absolute HTTP"),
        ("development", "https://user:password@provider.example/v1", "credentials"),
        ("production", "http://provider.example/v1", "HTTPS"),
    ],
)
def test_embedding_provider_rejects_unsafe_urls(
    environment: str,
    base_url: str,
    expected: str,
) -> None:
    values = {
        "AI_RUNTIME_ENVIRONMENT": environment,
        "AI_RUNTIME_DRIVER": "openai_compatible" if environment == "production" else "noop",
        "AI_RUNTIME_STORE_DRIVER": "postgres" if environment == "production" else "memory",
        "AI_RUNTIME_OPENAI_BASE_URL": "https://chat.example/v1",
        "AI_RUNTIME_OPENAI_API_KEY": "chat-secret",
        "AI_RUNTIME_OPENAI_MODEL": "chat-model",
        "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
        "AI_RUNTIME_EMBEDDING_BASE_URL": base_url,
        "AI_RUNTIME_EMBEDDING_API_KEY": "embedding-secret",
        "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
    }
    with pytest.raises(RuntimeConfigurationError, match=expected):
        RuntimeSettings.from_env(values)


def test_embedding_dimension_is_fixed_and_provider_configuration_is_complete() -> None:
    with pytest.raises(RuntimeConfigurationError, match="must be 1536"):
        RuntimeSettings.from_env({"AI_RUNTIME_EMBEDDING_DIMENSIONS": "768"})
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_EMBEDDING_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_EMBEDDING_DRIVER": "openai_compatible",
                "AI_RUNTIME_EMBEDDING_BASE_URL": "https://embedding.example/v1",
                "AI_RUNTIME_EMBEDDING_MODEL": "embedding-model",
            }
        )
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_RERANK_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_RERANK_DRIVER": "cohere_compatible",
                "AI_RUNTIME_RERANK_BASE_URL": "https://rerank.example/v2",
                "AI_RUNTIME_RERANK_MODEL": "rerank-model",
            }
        )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS", "0.01"),
        ("AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS", "301"),
        ("AI_RUNTIME_RERANK_TIMEOUT_SECONDS", "0.01"),
        ("AI_RUNTIME_RERANK_TIMEOUT_SECONDS", "301"),
    ],
)
def test_knowledge_provider_timeouts_are_bounded(name: str, value: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match=name):
        RuntimeSettings.from_env({name: value})


def test_noop_is_forbidden_in_production() -> None:
    with pytest.raises(RuntimeConfigurationError, match="forbidden"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_ENVIRONMENT": "production",
                "AI_RUNTIME_DRIVER": "noop",
            }
        )


def test_openai_driver_requires_complete_configuration() -> None:
    with pytest.raises(RuntimeConfigurationError, match="AI_RUNTIME_OPENAI_API_KEY"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "openai_compatible",
                "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
                "AI_RUNTIME_OPENAI_MODEL": "model-a",
            }
        )


def test_api_key_is_excluded_from_settings_repr() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "openai_compatible",
            "AI_RUNTIME_OPENAI_BASE_URL": "https://provider.example/v1",
            "AI_RUNTIME_OPENAI_API_KEY": "top-secret-key",
            "AI_RUNTIME_OPENAI_MODEL": "model-a",
        }
    )
    assert "top-secret-key" not in repr(settings)


def test_manus_driver_requires_key_and_uses_safe_defaults() -> None:
    with pytest.raises(RuntimeConfigurationError, match="MANUS_API_KEY"):
        RuntimeSettings.from_env({"AI_RUNTIME_DRIVER": "manus"})

    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "dummy-manus-key",
        }
    )
    assert settings.driver == RuntimeDriver.MANUS
    assert settings.manus_api_base_url == "https://api.manus.ai"
    assert settings.manus_agent_profile == "manus-1.6-lite"
    assert settings.manus_poll_interval_seconds == 2
    assert settings.manus_max_wait_seconds == 120
    assert "dummy-manus-key" not in repr(settings)

    runtime = build_runtime(settings)
    assert isinstance(runtime, ProviderRuntime)
    asyncio.run(runtime.aclose())


def test_manus_driver_accepts_an_explicit_http_proxy() -> None:
    settings = RuntimeSettings.from_env(
        {
            "AI_RUNTIME_DRIVER": "manus",
            "MANUS_API_KEY": "dummy-manus-key",
            "MANUS_PROXY_URL": "http://127.0.0.1:10837",
        }
    )
    assert settings.manus_proxy_url == "http://127.0.0.1:10837"
    assert "127.0.0.1:10837" not in repr(settings)

    runtime = build_runtime(settings)
    assert isinstance(runtime, ProviderRuntime)
    asyncio.run(runtime.aclose())


@pytest.mark.parametrize("proxy_url", ["127.0.0.1:10837", "socks5://127.0.0.1:10837"])
def test_manus_driver_rejects_invalid_proxy_urls(proxy_url: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="MANUS_PROXY_URL"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                "MANUS_PROXY_URL": proxy_url,
            }
        )


@pytest.mark.parametrize(
    "base_url",
    [
        "http://api.manus.ai",
        "https://api.manus.ai.evil.example",
        "https://user:password@api.manus.ai",
        "https://api.manus.ai/v2",
        "https://api.manus.ai?redirect=evil",
    ],
)
def test_manus_driver_only_sends_key_to_official_api_root(base_url: str) -> None:
    with pytest.raises(RuntimeConfigurationError, match="official HTTPS API root"):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                "MANUS_API_BASE_URL": base_url,
            }
        )


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"MANUS_AGENT_PROFILE": "unknown"}, "MANUS_AGENT_PROFILE"),
        ({"MANUS_POLL_INTERVAL_SECONDS": "0.5"}, "MANUS_POLL_INTERVAL_SECONDS"),
        ({"MANUS_MAX_WAIT_SECONDS": "1"}, "MANUS_MAX_WAIT_SECONDS"),
        ({"MANUS_MAX_WAIT_SECONDS": "not-a-number"}, "MANUS_MAX_WAIT_SECONDS"),
    ],
)
def test_manus_driver_rejects_invalid_bounds(
    overrides: dict[str, str],
    expected: str,
) -> None:
    with pytest.raises(RuntimeConfigurationError, match=expected):
        RuntimeSettings.from_env(
            {
                "AI_RUNTIME_DRIVER": "manus",
                "MANUS_API_KEY": "dummy-manus-key",
                **overrides,
            }
        )


def test_development_dotenv_loads_without_overriding_injected_values(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        "AI_RUNTIME_DRIVER=manus\n"
        "MANUS_API_KEY=dummy-file-key\n"
        "MANUS_AGENT_PROFILE=manus-1.6-max\n"
        "DATABASE_URL=must-not-enter-ai-runtime\n",
        encoding="utf-8",
    )
    environ = {"MANUS_API_KEY": "dummy-process-key"}

    assert load_runtime_dotenv(environ=environ, dotenv_path=dotenv_path) is True
    assert environ["AI_RUNTIME_DRIVER"] == "manus"
    assert environ["MANUS_API_KEY"] == "dummy-process-key"
    assert environ["MANUS_AGENT_PROFILE"] == "manus-1.6-max"
    assert "DATABASE_URL" not in environ
    settings = RuntimeSettings.from_env(environ)
    assert "dummy-file-key" not in repr(settings)
    assert "dummy-process-key" not in repr(settings)


def test_production_never_loads_dotenv(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("SHOULD_NOT_LOAD=yes\n", encoding="utf-8")
    environ = {"AI_RUNTIME_ENVIRONMENT": "production"}

    assert load_runtime_dotenv(environ=environ, dotenv_path=dotenv_path) is False
    assert "SHOULD_NOT_LOAD" not in environ


def test_dotenv_cannot_turn_a_local_process_into_production(tmp_path: Path) -> None:
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("AI_RUNTIME_ENVIRONMENT=production\n", encoding="utf-8")

    with pytest.raises(RuntimeConfigurationError, match="supplied by the process"):
        load_runtime_dotenv(environ={}, dotenv_path=dotenv_path)


def test_production_openai_driver_requires_https_and_no_url_credentials() -> None:
    base = {
        "AI_RUNTIME_ENVIRONMENT": "production",
        "AI_RUNTIME_DRIVER": "openai_compatible",
        "AI_RUNTIME_STORE_DRIVER": "postgres",
        "AI_RUNTIME_OPENAI_API_KEY": "secret",
        "AI_RUNTIME_OPENAI_MODEL": "model-a",
    }
    with pytest.raises(RuntimeConfigurationError, match="HTTPS"):
        RuntimeSettings.from_env(
            {**base, "AI_RUNTIME_OPENAI_BASE_URL": "http://provider.example/v1"}
        )
    with pytest.raises(RuntimeConfigurationError, match="credentials"):
        RuntimeSettings.from_env(
            {**base, "AI_RUNTIME_OPENAI_BASE_URL": "https://user:pass@provider.example/v1"}
        )


def test_memory_store_is_forbidden_in_production() -> None:
    with pytest.raises(RuntimeConfigurationError, match="STORE_DRIVER=memory"):
        RuntimeSettings(
            environment=RuntimeEnvironment.PRODUCTION,
            driver=RuntimeDriver.OPENAI_COMPATIBLE,
            store_driver=StoreDriver.MEMORY,
            openai_base_url="https://provider.example/v1",
            openai_api_key="secret",
            openai_model="model-a",
        )


def test_unimplemented_postgres_store_fails_closed() -> None:
    settings = RuntimeSettings(
        environment=RuntimeEnvironment.DEVELOPMENT,
        driver=RuntimeDriver.NOOP,
        store_driver=StoreDriver.POSTGRES,
    )
    with pytest.raises(RuntimeConfigurationError, match="not implemented"):
        build_store(settings)


class DurableStoreStub:
    """Only used to reach the independent production runtime-injection guard."""


def test_injected_noop_runtime_is_also_forbidden_in_production() -> None:
    settings = RuntimeSettings(
        environment=RuntimeEnvironment.PRODUCTION,
        driver=RuntimeDriver.OPENAI_COMPATIBLE,
        store_driver=StoreDriver.POSTGRES,
        openai_base_url="https://provider.example/v1",
        openai_api_key="top-secret-key",
        openai_model="model-a",
    )
    with pytest.raises(RuntimeConfigurationError, match="NoopRuntime"):
        create_app(
            settings=settings,
            store=DurableStoreStub(),  # type: ignore[arg-type]
            runtime=NoopRuntime(),
        )
