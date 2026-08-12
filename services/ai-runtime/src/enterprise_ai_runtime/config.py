from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass, field
from enum import StrEnum
from ipaddress import IPv4Address, IPv6Address, ip_address
from pathlib import Path
from socket import inet_aton
from urllib.parse import SplitResult, parse_qs, urlsplit
from uuid import UUID

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
    LOCAL_FASTEMBED = "local_fastembed"


class RerankDriver(StrEnum):
    DISABLED = "disabled"
    COHERE_COMPATIBLE = "cohere_compatible"
    LOCAL_FASTEMBED = "local_fastembed"


@dataclass(frozen=True, slots=True)
class ModelRouteCatalogEntry:
    route_key: str
    catalog_version_id: UUID
    provider: str
    model: str
    credential_reference: str


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    environment: RuntimeEnvironment
    driver: RuntimeDriver
    store_driver: StoreDriver = StoreDriver.MEMORY
    postgres_dsn: str | None = field(default=None, repr=False)
    postgres_pool_min_size: int = 1
    postgres_pool_max_size: int = 10
    postgres_command_timeout_seconds: float = 10.0
    service_token: str | None = field(default=None, repr=False)
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
    local_model_cache_dir: str = ".data/ai-models"
    local_model_allow_download: bool = False
    local_model_threads: int = 2
    model_route_catalog: tuple[ModelRouteCatalogEntry, ...] = ()
    require_trusted_model_route: bool = False
    evaluation_attestation_secret: str | None = field(default=None, repr=False)

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

        self._validate_store()
        if self.driver == RuntimeDriver.OPENAI_COMPATIBLE:
            self._validate_openai_compatible()
        elif self.driver == RuntimeDriver.MANUS:
            self._validate_manus()
        self._validate_knowledge_providers()
        if self.environment == RuntimeEnvironment.PRODUCTION and self.local_model_allow_download:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_LOCAL_MODEL_ALLOW_DOWNLOAD must be false in production"
            )
        if self.environment == RuntimeEnvironment.PRODUCTION and (
            self.service_token is None or len(self.service_token) < 32
        ):
            raise RuntimeConfigurationError(
                "AI_RUNTIME_SERVICE_TOKEN must contain at least 32 characters in production"
            )
        self._validate_model_route_catalog()
        if (
            self.evaluation_attestation_secret is not None
            and len(self.evaluation_attestation_secret) < 32
        ):
            raise RuntimeConfigurationError(
                "AI_RUNTIME_EVALUATION_ATTESTATION_SECRET must contain at least 32 characters"
            )

    def _validate_model_route_catalog(self) -> None:
        if (
            self.environment == RuntimeEnvironment.PRODUCTION
            and not self.require_trusted_model_route
        ):
            raise RuntimeConfigurationError(
                "AI_RUNTIME_REQUIRE_TRUSTED_MODEL_ROUTE must be enabled in production"
            )
        if self.require_trusted_model_route and not self.model_route_catalog:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_MODEL_ROUTE_CATALOG must define at least one server-side route"
            )
        if self.model_route_catalog and self.driver == RuntimeDriver.NOOP:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_MODEL_ROUTE_CATALOG cannot use the noop runtime driver"
            )
        expected_provider = (
            "OPENAI_COMPATIBLE"
            if self.driver == RuntimeDriver.OPENAI_COMPATIBLE
            else "MANUS"
            if self.driver == RuntimeDriver.MANUS
            else None
        )
        route_keys: set[str] = set()
        catalog_ids: set[UUID] = set()
        for entry in self.model_route_catalog:
            if entry.route_key in route_keys or entry.catalog_version_id in catalog_ids:
                raise RuntimeConfigurationError(
                    "AI_RUNTIME_MODEL_ROUTE_CATALOG routes and catalog versions must be unique"
                )
            route_keys.add(entry.route_key)
            catalog_ids.add(entry.catalog_version_id)
            if entry.provider != expected_provider:
                raise RuntimeConfigurationError(
                    "AI_RUNTIME_MODEL_ROUTE_CATALOG provider must match AI_RUNTIME_DRIVER"
                )
            if self.driver == RuntimeDriver.MANUS and entry.model not in MANUS_AGENT_PROFILES:
                raise RuntimeConfigurationError(
                    "MANUS model routes must use an allowlisted Manus agent profile"
                )

    def _validate_store(self) -> None:
        if self.store_driver != StoreDriver.POSTGRES:
            return
        if not self.postgres_dsn:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_POSTGRES_DSN is required when AI_RUNTIME_STORE_DRIVER=postgres"
            )
        parsed = urlsplit(self.postgres_dsn)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.netloc:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_POSTGRES_DSN must be an absolute PostgreSQL URL"
            )
        if self.environment == RuntimeEnvironment.PRODUCTION:
            query = parse_qs(parsed.query, keep_blank_values=True)
            ssl_modes = {value.lower() for value in query.get("sslmode", [])}
            ssl_values = {value.lower() for value in query.get("ssl", [])}
            safe_ssl_modes = {"require", "verify-ca", "verify-full"}
            truthy_ssl_values = {"true", "1", "yes", "on"}
            tls_required = (
                bool(ssl_modes)
                and ssl_modes.issubset(safe_ssl_modes)
                and (not ssl_values or ssl_values.issubset(truthy_ssl_values))
            ) or (not ssl_modes and bool(ssl_values) and ssl_values.issubset(truthy_ssl_values))
            if not tls_required:
                raise RuntimeConfigurationError(
                    "AI_RUNTIME_POSTGRES_DSN must require TLS in production"
                )
        if not 1 <= self.postgres_pool_min_size <= self.postgres_pool_max_size <= 100:
            raise RuntimeConfigurationError(
                "AI Runtime PostgreSQL pool sizes must satisfy 1 <= min <= max <= 100"
            )
        if not 0.1 <= self.postgres_command_timeout_seconds <= 300:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_POSTGRES_COMMAND_TIMEOUT_SECONDS must be between 0.1 and 300"
            )

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

        parsed = _parse_provider_url(
            "AI_RUNTIME_OPENAI_BASE_URL",
            self.openai_base_url or "",
        )
        if parsed.username is not None or parsed.password is not None:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_OPENAI_BASE_URL must not contain credentials"
            )
        if self.environment == RuntimeEnvironment.PRODUCTION:
            _validate_production_provider_url(
                "AI_RUNTIME_OPENAI_BASE_URL",
                parsed,
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
            proxy = _parse_provider_url("MANUS_PROXY_URL", self.manus_proxy_url)
            if self.environment == RuntimeEnvironment.PRODUCTION:
                _validate_production_provider_url("MANUS_PROXY_URL", proxy)
        if not 1.0 <= self.manus_poll_interval_seconds <= 60.0:
            raise RuntimeConfigurationError("MANUS_POLL_INTERVAL_SECONDS must be between 1 and 60")
        if not self.manus_poll_interval_seconds <= self.manus_max_wait_seconds <= 3_600.0:
            raise RuntimeConfigurationError(
                "MANUS_MAX_WAIT_SECONDS must be between the poll interval and 3600"
            )

    def _validate_knowledge_providers(self) -> None:
        if not 1 <= self.embedding_dimensions <= 16_000:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_EMBEDDING_DIMENSIONS must be between 1 and 16000"
            )
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

        if self.embedding_driver == EmbeddingDriver.LOCAL_FASTEMBED and not self.embedding_model:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_EMBEDDING_MODEL is required for local_fastembed"
            )
        if self.rerank_driver == RerankDriver.LOCAL_FASTEMBED and not self.rerank_model:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_RERANK_MODEL is required for local_fastembed"
            )
        if not self.local_model_cache_dir.strip():
            raise RuntimeConfigurationError("AI_RUNTIME_LOCAL_MODEL_CACHE_DIR must not be empty")
        if not 1 <= self.local_model_threads <= 64:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_LOCAL_MODEL_THREADS must be between 1 and 64"
            )

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
        parsed = _parse_provider_url(name, value)
        if parsed.username is not None or parsed.password is not None:
            raise RuntimeConfigurationError(f"{name} must not contain credentials")
        if parsed.query or parsed.fragment:
            raise RuntimeConfigurationError(f"{name} must not contain a query or fragment")
        if self.environment == RuntimeEnvironment.PRODUCTION:
            _validate_production_provider_url(name, parsed)

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
                "AI_RUNTIME_EMBEDDING_DRIVER must be disabled, openai_compatible, "
                "or local_fastembed"
            ) from error

        try:
            rerank_driver = RerankDriver(
                values.get("AI_RUNTIME_RERANK_DRIVER", "disabled").strip().lower()
            )
        except ValueError as error:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_RERANK_DRIVER must be disabled, cohere_compatible, or local_fastembed"
            ) from error

        return cls(
            environment=environment,
            driver=driver,
            store_driver=store_driver,
            postgres_dsn=_optional(values.get("AI_RUNTIME_POSTGRES_DSN")),
            postgres_pool_min_size=_positive_int(
                values.get("AI_RUNTIME_POSTGRES_POOL_MIN_SIZE"),
                default=1,
                name="AI_RUNTIME_POSTGRES_POOL_MIN_SIZE",
            ),
            postgres_pool_max_size=_positive_int(
                values.get("AI_RUNTIME_POSTGRES_POOL_MAX_SIZE"),
                default=10,
                name="AI_RUNTIME_POSTGRES_POOL_MAX_SIZE",
            ),
            postgres_command_timeout_seconds=_positive_float(
                values.get("AI_RUNTIME_POSTGRES_COMMAND_TIMEOUT_SECONDS"),
                default=10.0,
                name="AI_RUNTIME_POSTGRES_COMMAND_TIMEOUT_SECONDS",
            ),
            service_token=_optional(values.get("AI_RUNTIME_SERVICE_TOKEN")),
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
            embedding_model=_optional(values.get("AI_RUNTIME_EMBEDDING_MODEL"))
            or (
                "BAAI/bge-small-zh-v1.5"
                if embedding_driver == EmbeddingDriver.LOCAL_FASTEMBED
                else None
            ),
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
            rerank_model=_optional(values.get("AI_RUNTIME_RERANK_MODEL"))
            or (
                "BAAI/bge-reranker-base"
                if rerank_driver == RerankDriver.LOCAL_FASTEMBED
                else None
            ),
            rerank_timeout_seconds=_positive_float(
                values.get("AI_RUNTIME_RERANK_TIMEOUT_SECONDS"),
                default=30.0,
                name="AI_RUNTIME_RERANK_TIMEOUT_SECONDS",
            ),
            local_model_cache_dir=_optional(values.get("AI_RUNTIME_LOCAL_MODEL_CACHE_DIR"))
            or ".data/ai-models",
            local_model_allow_download=(
                _truthy(values.get("AI_RUNTIME_LOCAL_MODEL_ALLOW_DOWNLOAD"))
                if values.get("AI_RUNTIME_LOCAL_MODEL_ALLOW_DOWNLOAD") is not None
                else environment != RuntimeEnvironment.PRODUCTION
            ),
            local_model_threads=_positive_int(
                values.get("AI_RUNTIME_LOCAL_MODEL_THREADS"),
                default=2,
                name="AI_RUNTIME_LOCAL_MODEL_THREADS",
            ),
            model_route_catalog=_model_route_catalog(values.get("AI_RUNTIME_MODEL_ROUTE_CATALOG")),
            require_trusted_model_route=_truthy(
                values.get("AI_RUNTIME_REQUIRE_TRUSTED_MODEL_ROUTE")
            )
            or environment == RuntimeEnvironment.PRODUCTION,
            evaluation_attestation_secret=_optional(
                values.get("AI_RUNTIME_EVALUATION_ATTESTATION_SECRET")
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


def _parse_provider_url(name: str, value: str) -> SplitResult:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        # Accessing ``port`` detects malformed or out-of-range explicit ports.
        _ = parsed.port
    except ValueError:
        raise RuntimeConfigurationError(f"{name} must be an absolute HTTP(S) URL") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not hostname:
        raise RuntimeConfigurationError(f"{name} must be an absolute HTTP(S) URL")
    return parsed


def _validate_production_provider_url(name: str, parsed: SplitResult) -> None:
    if parsed.scheme != "https":
        raise RuntimeConfigurationError(f"{name} must use HTTPS in production")
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeConfigurationError(f"{name} must not contain credentials in production")
    if parsed.query or parsed.fragment:
        raise RuntimeConfigurationError(
            f"{name} must not contain a query or fragment in production"
        )

    hostname = parsed.hostname
    if hostname is None:
        raise RuntimeConfigurationError(f"{name} must be an absolute HTTP(S) URL")
    try:
        literal_address = ip_address(hostname)
    except ValueError:
        try:
            # ``inet_aton`` also recognizes legacy shorthand, integer, octal,
            # and hexadecimal IPv4 literals that resolvers may map to a private
            # address even though ``ip_address`` intentionally rejects them.
            literal_address = IPv4Address(inet_aton(hostname))
        except OSError:
            return
    is_mapped = isinstance(literal_address, IPv6Address) and literal_address.ipv4_mapped is not None
    if (
        is_mapped
        or literal_address.is_private
        or literal_address.is_loopback
        or literal_address.is_link_local
    ):
        raise RuntimeConfigurationError(
            f"{name} must not use a private, loopback, link-local, "
            "or IPv4-mapped literal IP in production"
        )


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


def _model_route_catalog(value: str | None) -> tuple[ModelRouteCatalogEntry, ...]:
    if value is None or not value.strip():
        return ()
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise RuntimeConfigurationError(
            "AI_RUNTIME_MODEL_ROUTE_CATALOG must be valid JSON"
        ) from error
    if not isinstance(parsed, list) or not 1 <= len(parsed) <= 100:
        raise RuntimeConfigurationError(
            "AI_RUNTIME_MODEL_ROUTE_CATALOG must contain between 1 and 100 routes"
        )
    allowed = {
        "route_key",
        "catalog_version_id",
        "provider",
        "model",
        "credential_reference",
    }
    entries: list[ModelRouteCatalogEntry] = []
    for item in parsed:
        if not isinstance(item, dict) or set(item) != allowed:
            raise RuntimeConfigurationError(
                "AI_RUNTIME_MODEL_ROUTE_CATALOG entries have an invalid shape"
            )
        route_key = item.get("route_key")
        provider = item.get("provider")
        model = item.get("model")
        credential_reference = item.get("credential_reference")
        if not isinstance(route_key, str) or not re.fullmatch(
            r"[A-Z0-9][A-Z0-9._-]{0,119}", route_key
        ):
            raise RuntimeConfigurationError("model route_key is invalid")
        if provider not in {"OPENAI_COMPATIBLE", "MANUS"}:
            raise RuntimeConfigurationError("model route provider is invalid")
        if not isinstance(model, str) or not 1 <= len(model) <= 256:
            raise RuntimeConfigurationError("model route model is invalid")
        if not isinstance(credential_reference, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}", credential_reference
        ):
            raise RuntimeConfigurationError("model route credential_reference is invalid")
        if re.search(r"(?:secret|token|key)=", credential_reference, re.IGNORECASE):
            raise RuntimeConfigurationError(
                "model route credentials must be references, not plaintext values"
            )
        try:
            catalog_version_id = UUID(str(item.get("catalog_version_id")))
        except ValueError as error:
            raise RuntimeConfigurationError("model route catalog_version_id is invalid") from error
        entries.append(
            ModelRouteCatalogEntry(
                route_key=route_key,
                catalog_version_id=catalog_version_id,
                provider=provider,
                model=model,
                credential_reference=credential_reference,
            )
        )
    return tuple(entries)


def _repository_dotenv_path() -> Path | None:
    source = Path(__file__).resolve()
    for parent in source.parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return parent / ".env"
    return None
