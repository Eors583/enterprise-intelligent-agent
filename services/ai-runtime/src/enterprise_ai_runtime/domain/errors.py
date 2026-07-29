from __future__ import annotations


class RunError(Exception):
    """Base class for run-domain errors."""


class RunNotFoundError(RunError):
    """Raised when a run does not exist inside the requested tenant."""

    def __init__(self, run_id: str) -> None:
        super().__init__(f"run {run_id} was not found")
        self.run_id = run_id


class RunStreamReconciliationRequiredError(RunError):
    """A durable RUNNING record has no safe in-process execution to resume."""

    def __init__(self, run_id: str) -> None:
        super().__init__(f"run {run_id} requires reconciliation")
        self.run_id = run_id


class InvalidRunTransitionError(RunError):
    """Raised when a state transition violates the run state machine."""

    def __init__(self, current: str, target: str) -> None:
        super().__init__(f"cannot transition run from {current} to {target}")
        self.current = current
        self.target = target


class RunAlreadyExistsError(RunError):
    """Raised if a store sees a duplicate run id."""

    def __init__(self, run_id: str) -> None:
        super().__init__(f"run {run_id} already exists")
        self.run_id = run_id


class RuntimeConfigurationError(RunError):
    """Raised when runtime configuration is incomplete or unsafe."""


class RuntimeExecutionError(RunError):
    """A sanitized execution error safe to persist and return to internal callers."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.retryable = retryable


class UnsupportedRuntimeInputError(RuntimeExecutionError):
    def __init__(self, message: str = "runtime input is not supported") -> None:
        super().__init__("UNSUPPORTED_RUNTIME_INPUT", message, retryable=False)


class InputTokenBudgetPreflightError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "INPUT_TOKEN_BUDGET_PREFLIGHT_EXCEEDED",
            "input exceeds the conservative preflight token budget",
            retryable=False,
        )


class RuntimeNotConfiguredError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "RUNTIME_NOT_CONFIGURED",
            "no model runtime is configured",
            retryable=False,
        )


class KnowledgeCapabilityDisabledError(RuntimeExecutionError):
    def __init__(self, capability: str) -> None:
        super().__init__(
            "KNOWLEDGE_CAPABILITY_DISABLED",
            f"knowledge {capability} capability is disabled",
            retryable=False,
        )


class ProviderTimeoutError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__("PROVIDER_TIMEOUT", "model provider timed out", retryable=True)


class ProviderAuthenticationError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_AUTHENTICATION_FAILED",
            "model provider rejected its credentials",
            retryable=False,
        )


class ProviderRateLimitError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_RATE_LIMITED",
            "model provider rate limit was reached",
            retryable=True,
        )


class ProviderRequestError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_REQUEST_REJECTED",
            "model provider rejected the request",
            retryable=False,
        )


class ProviderUnavailableError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_UNAVAILABLE",
            "model provider is unavailable",
            retryable=True,
        )


class ProviderResponseError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_INVALID_RESPONSE",
            "model provider returned an invalid response",
            retryable=True,
        )


class ProviderInteractionRequiredError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_INTERACTION_REQUIRED",
            "model provider requires user input or approval",
            retryable=False,
        )


class ProviderTaskError(RuntimeExecutionError):
    def __init__(self) -> None:
        super().__init__(
            "PROVIDER_TASK_FAILED",
            "model provider task failed",
            retryable=True,
        )
