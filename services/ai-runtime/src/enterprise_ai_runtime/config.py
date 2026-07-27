from __future__ import annotations

import os
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

from enterprise_ai_runtime.domain.errors import RuntimeConfigurationError

MANUS_OFFICIAL_HOST = "api.manus.ai"
MANUS_AGENT_PROFILES = frozenset({"manus-1.6", "manus-1.6-lite", "manus-1.6-max"})
RUNTIME_DOTENV_PREFIXES = ("AI_RUNTIME_", "MANUS_")


class RuntimeDriver(StrEnum):
    NOOP = "noop"
    OPENAI_COMPATIBLE = "openai_compatible"
    MANUS = "manus"


class RuntimeEnvironment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class StoreDriver(StrEnum):
    MEMORY = "memory"
    POSTGRES = "postgres"


class EmbeddingDriver(StrEnum):
    DISABLED = "disabled"
    OPENAI_COMPATIBLE = "openai_compatible"


class RerankDriver(StrEnum):
    DISABLED = "disabled"
    COHERE_COMPATIBLE = "cohere_compatible"


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    environment: RuntimeEnvironment
    driver: RuntimeDriver
    store_driver: StoreDriver = StoreDriver.MEMORY
    openai_base_url: str | None = None
    openai_api_key: str | None = field(default=None, repr=False)
    openai_model: str | None = None
    manus_api_key: str | None = field(default=None, repr=False)
    manus_api_base_url: str = "https://api.manus.ai"
    manus_proxy_url: str | None = field(default=None, repr=False)
    manus_agent_profile: str = "manus-1.6-lite"
    manus_project_id: str | None = None
    manus_poll_interval_seconds: float = 2.0
    manus_max_wait_seconds: float = 120.0
    embedding_driver: EmbeddingDriver = EmbeddingDriver.DISABLED
    embedding_base_url: str | None = None
    embedding_api_key: str | None = field(default=None, repr=False)
    embedding_model: str | None = None
    embedding_dimensions: int = 1536
    embedding_timeout_seconds: float = 30.0
    rerank_driver: RerankDriver = RerankDriver.DISABLED
    rerank_base_url: str | None = None
    rerank_api_key: str | None = field(default=None, repr=False)
    rerank_model: str | None = None
    rerank_timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        if self.environment == RuntimeEnvironment.PRODUCTION and self.driver == RuntimeDriver.NOOP:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_DRIVER=noop is forbidden in the production environment"
            )
        if (
            self.environment == RuntimeEnvironment.PRODUCTION
            and self.store_driver == StoreDriver.MEMORY
        ):
            raise RuntimeConfigurationError(
                "AI_RUNTIME_STORE_DRIVER=memory is forbidden in the production environment"
            )

        if self.driver == RuntimeDriver.OPENAI_COMPATIBLE:
            self._validate_openai_compatible()
        elif self.driver == RuntimeDriver.MANUS:
            self._validate_manus()
        self._validate_knowledge_providers()

    def _validate_openai_compatible(self) -> None:
        missing = [
            name
            for name, value in (
                ("AI_RUNTIME_OPENAI_BASE_URL", self.openai_base_url),
                ("AI_RUNTIME_OPENAI_API_KEY", self.openai_api_key),
                ("AI_RUNTIME_OPENAI_MODEL", self.openai_model),
            )
            if not value
        ]
        if missing:
            raise RuntimeConfigurationError(
                f"missing configuration for openai_compatible driver: {', '.join(missing)}"
            )

        parsed = urlsplit(self.openai_base_url or "")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_OPENAI_BASE_URL must be an absolute HTTP(S) URL"
            )
        if parsed.username or parsed.password:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_OPENAI_BASE_URL must not contain credentials"
            )
        if self.environment == RuntimeEnvironment.PRODUCTION and parsed.scheme != "https":
            raise RuntimeConfigurationError(
                "AI_RUNTIME_OPENAI_BASE_URL must use HTTPS in production"
            )

    def _validate_manus(self) -> None:
        if not self.manus_api_key:
            raise RuntimeConfigurationError("missing configuration for manus driver: MANUS_API_KEY")

        parsed = urlsplit(self.manus_api_base_url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != MANUS_OFFICIAL_HOST
            or parsed.username
            or parsed.password
            or parsed.path.rstrip("/")
            or parsed.query
            or parsed.fragment
        ):
            raise RuntimeConfigurationError(
                "MANUS_API_BASE_URL must be the official HTTPS API root https://api.manus.ai"
            )
        if self.manus_agent_profile not in MANUS_AGENT_PROFILES:
            raise RuntimeConfigurationError(
                "MANUS_AGENT_PROFILE must be manus-1.6, manus-1.6-lite, or manus-1.6-max"
            )
        if self.manus_proxy_url is not None:
            proxy = urlsplit(self.manus_proxy_url)
            if proxy.scheme not in {"http", "https"} or not proxy.hostname:
                raise RuntimeConfigurationError("MANUS_PROXY_URL must be an absolute HTTP(S) URL")
        if not 1.0 <= self.manus_poll_interval_seconds <= 60.0:
            raise RuntimeConfigurationError("MANUS_POLL_INTERVAL_SECONDS must be between 1 and 60")
        if not self.manus_poll_interval_seconds <= self.manus_max_wait_seconds <= 3_600.0:
            raise RuntimeConfigurationError(
                "MANUS_MAX_WAIT_SECONDS must be between the poll interval and 3600"
            )

    def _validate_knowledge_providers(self) -> None:
        if self.embedding_dimensions != 1536:
            raise RuntimeConfigurationError("AI_RUNTIME_EMBEDDING_DIMENSIONS must be 1536")
        if not 0.1 <= self.embedding_timeout_seconds <= 300:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS must be between 0.1 and 300"
            )
        if not 0.1 <= self.rerank_timeout_seconds <= 300:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_RERANK_TIMEOUT_SECONDS must be between 0.1 and 300"
            )

        for name, model in (
            ("AI_RUNTIME_EMBEDDING_MODEL", self.embedding_model),
            ("AI_RUNTIME_RERANK_MODEL", self.rerank_model),
        ):
            if model is not None and len(model) > 200:
                raise RuntimeConfigurationError(f"{name} must not exceed 200 characters")

        if self.embedding_driver == EmbeddingDriver.OPENAI_COMPATIBLE:
            self._require_knowledge_configuration(
                capability="embedding",
                values=(
                    ("AI_RUNTIME_EMBEDDING_BASE_URL", self.embedding_base_url),
                    ("AI_RUNTIME_EMBEDDING_API_KEY", self.embedding_api_key),
                    ("AI_RUNTIME_EMBEDDING_MODEL", self.embedding_model),
                ),
            )
            self._validate_provider_url(
                "AI_RUNTIME_EMBEDDING_BASE_URL", self.embedding_base_url or ""
            )

        if self.rerank_driver == RerankDriver.COHERE_COMPATIBLE:
            self._require_knowledge_configuration(
                capability="rerank",
                values=(
                    ("AI_RUNTIME_RERANK_BASE_URL", self.rerank_base_url),
                    ("AI_RUNTIME_RERANK_API_KEY", self.rerank_api_key),
                    ("AI_RUNTIME_RERANK_MODEL", self.rerank_model),
                ),
            )
            self._validate_provider_url("AI_RUNTIME_RERANK_BASE_URL", self.rerank_base_url or "")

    def _require_knowledge_configuration(
        self,
        *,
        capability: str,
        values: tuple[tuple[str, str | None], ...],
    ) -> None:
        missing = [name for name, value in values if not value]
        if missing:
            raise RuntimeConfigurationError(
                f"missing configuration for {capability} driver: {', '.join(missing)}"
            )

    def _validate_provider_url(self, name: str, value: str) -> None:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeConfigurationError(f"{name} must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password:
            raise RuntimeConfigurationError(f"{name} must not contain credentials")
        if parsed.query or parsed.fragment:
            raise RuntimeConfigurationError(f"{name} must not contain a query or fragment")
        if self.environment == RuntimeEnvironment.PRODUCTION and parsed.scheme != "https":
            raise RuntimeConfigurationError(f"{name} must use HTTPS in production")

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> RuntimeSettings:
        values = os.environ if environ is None else environ
        try:
            environment = RuntimeEnvironment(
                values.get("AI_RUNTIME_ENVIRONMENT", "development").strip().lower()
            )
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_ENVIRONMENT must be development, test, or production"
            ) from error

        try:
            driver = RuntimeDriver(values.get("AI_RUNTIME_DRIVER", "noop").strip().lower())
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_DRIVER must be noop, openai_compatible, or manus"
            ) from error

        try:
            store_driver = StoreDriver(
                values.get("AI_RUNTIME_STORE_DRIVER", "memory").strip().lower()
            )
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_STORE_DRIVER must be memory or postgres"
            ) from error

        try:
            embedding_driver = EmbeddingDriver(
                values.get("AI_RUNTIME_EMBEDDING_DRIVER", "disabled").strip().lower()
            )
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_EMBEDDING_DRIVER must be disabled or openai_compatible"
            ) from error

        try:
            rerank_driver = RerankDriver(
                values.get("AI_RUNTIME_RERANK_DRIVER", "disabled").strip().lower()
            )
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_RERANK_DRIVER must be disabled or cohere_compatible"
            ) from error

        return cls(
            environment=environment,
            driver=driver,
            store_driver=store_driver,
            openai_base_url=_optional(values.get("AI_RUNTIME_OPENAI_BASE_URL")),
            openai_api_key=_optional(values.get("AI_RUNTIME_OPENAI_API_KEY")),
            openai_model=_optional(values.get("AI_RUNTIME_OPENAI_MODEL")),
            manus_api_key=_optional(values.get("MANUS_API_KEY")),
            manus_api_base_url=_optional(values.get("MANUS_API_BASE_URL"))
            or "https://api.manus.ai",
            manus_proxy_url=_optional(values.get("MANUS_PROXY_URL")),
            manus_agent_profile=_optional(values.get("MANUS_AGENT_PROFILE")) or "manus-1.6-lite",
            manus_project_id=_optional(values.get("MANUS_PROJECT_ID")),
            manus_poll_interval_seconds=_positive_float(
                values.get("MANUS_POLL_INTERVAL_SECONDS"),
                default=2.0,
                name="MANUS_POLL_INTERVAL_SECONDS",
            ),
            manus_max_wait_seconds=_positive_float(
                values.get("MANUS_MAX_WAIT_SECONDS"),
                default=120.0,
                name="MANUS_MAX_WAIT_SECONDS",
            ),
            embedding_driver=embedding_driver,
            embedding_base_url=_optional(values.get("AI_RUNTIME_EMBEDDING_BASE_URL")),
            embedding_api_key=_optional(values.get("AI_RUNTIME_EMBEDDING_API_KEY")),
            embedding_model=_optional(values.get("AI_RUNTIME_EMBEDDING_MODEL")),
            embedding_dimensions=_positive_int(
                values.get("AI_RUNTIME_EMBEDDING_DIMENSIONS"),
                default=1536,
                name="AI_RUNTIME_EMBEDDING_DIMENSIONS",
            ),
            embedding_timeout_seconds=_positive_float(
                values.get("AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS"),
                default=30.0,
                name="AI_RUNTIME_EMBEDDING_TIMEOUT_SECONDS",
            ),
            rerank_driver=rerank_driver,
            rerank_base_url=_optional(values.get("AI_RUNTIME_RERANK_BASE_URL")),
            rerank_api_key=_optional(values.get("AI_RUNTIME_RERANK_API_KEY")),
            rerank_model=_optional(values.get("AI_RUNTIME_RERANK_MODEL")),
            rerank_timeout_seconds=_positive_float(
                values.get("AI_RUNTIME_RERANK_TIMEOUT_SECONDS"),
                default=30.0,
                name="AI_RUNTIME_RERANK_TIMEOUT_SECONDS",
            ),
        )


def load_runtime_dotenv(
    *,
    environ: MutableMapping[str, str] | None = None,
    dotenv_path: Path | None = None,
) -> bool:
    """Load the repository dotenv for local startup without overriding injected values.

    Production deliberately never reads dotenv. Tests can pass an isolated mapping and path;
    the module-level startup can be disabled with AI_RUNTIME_DISABLE_DOTENV for hermetic tests.
    """

    values = os.environ if environ is None else environ
    if _truthy(values.get("AI_RUNTIME_DISABLE_DOTENV")):
        return False

    process_environment = values.get("AI_RUNTIME_ENVIRONMENT", "development").strip().lower()
    if process_environment == RuntimeEnvironment.PRODUCTION.value:
        return False

    path = dotenv_path if dotenv_path is not None else _repository_dotenv_path()
    if path is None or not path.is_file():
        return False
    file_values = dotenv_values(path, interpolate=False)
    file_environment = _optional(file_values.get("AI_RUNTIME_ENVIRONMENT"))
    if file_environment and file_environment.lower() == RuntimeEnvironment.PRODUCTION.value:
        raise RuntimeConfigurationError(
            "AI_RUNTIME_ENVIRONMENT=production must be supplied by the process, not dotenv"
        )

    for key, value in file_values.items():
        if value is not None and key.startswith(RUNTIME_DOTENV_PREFIXES) and key not in values:
            values[key] = value
    return True


def _optional(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _positive_float(value: str | None, *, default: float, name: str) -> float:
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError as error:
        raise RuntimeConfigurationError(f"{name} must be a number") from error
    if parsed <= 0:
        raise RuntimeConfigurationError(f"{name} must be greater than zero")
    return parsed


def _positive_int(value: str | None, *, default: int, name: str) -> int:
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise RuntimeConfigurationError(f"{name} must be an integer") from error
    if parsed <= 0:
        raise RuntimeConfigurationError(f"{name} must be greater than zero")
    return parsed


def _truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def _repository_dotenv_path() -> Path | None:
    source = Path(__file__).resolve()
    for parent in source.parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return parent / ".env"
    return None
