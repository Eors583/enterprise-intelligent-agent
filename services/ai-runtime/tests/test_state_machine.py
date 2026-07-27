from __future__ import annotations

import pytest

from enterprise_ai_runtime.domain.errors import InvalidRunTransitionError
from enterprise_ai_runtime.domain.models import RunStatus
from enterprise_ai_runtime.domain.state import ALLOWED_TRANSITIONS, ensure_transition_allowed


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (RunStatus.QUEUED, RunStatus.RUNNING),
        (RunStatus.QUEUED, RunStatus.FAILED),
        (RunStatus.QUEUED, RunStatus.CANCELLED),
        (RunStatus.RUNNING, RunStatus.SUCCEEDED),
        (RunStatus.RUNNING, RunStatus.FAILED),
        (RunStatus.RUNNING, RunStatus.CANCELLED),
    ],
)
def test_allowed_transitions(current: RunStatus, target: RunStatus) -> None:
    ensure_transition_allowed(current, target)


@pytest.mark.parametrize(
    "terminal",
    [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED],
)
def test_terminal_states_have_no_outgoing_transitions(terminal: RunStatus) -> None:
    assert not ALLOWED_TRANSITIONS[terminal]
    with pytest.raises(InvalidRunTransitionError):
        ensure_transition_allowed(terminal, RunStatus.RUNNING)
