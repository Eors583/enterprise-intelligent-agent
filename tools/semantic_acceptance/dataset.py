from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

CASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
ALLOWED_FIELDS = {
    "id",
    "query",
    "knowledgeBaseId",
    "userId",
    "expectedNoAnswer",
    "semanticRequired",
    "relevance",
    "forbiddenChunkIds",
    "forbiddenDocumentIds",
    "forbiddenKnowledgeBaseIds",
    "limit",
}


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    query: str
    knowledge_base_id: str
    user_id: str
    expected_no_answer: bool
    semantic_required: bool
    relevance: dict[str, float]
    forbidden_chunk_ids: frozenset[str]
    forbidden_document_ids: frozenset[str]
    forbidden_knowledge_base_ids: frozenset[str]
    limit: int

    @property
    def has_acl_expectation(self) -> bool:
        return bool(
            self.forbidden_chunk_ids
            or self.forbidden_document_ids
            or self.forbidden_knowledge_base_ids
        )


@dataclass(frozen=True)
class Dataset:
    cases: tuple[EvaluationCase, ...]
    sha256: str


def load_dataset(path: Path) -> Dataset:
    raw = path.read_bytes()
    if not raw:
        raise ValueError("dataset must not be empty")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("dataset must be UTF-8 JSONL") from error

    cases: list[EvaluationCase] = []
    seen_ids: set[str] = set()
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(
                line,
                object_pairs_hook=_object_without_duplicate_keys,
                parse_constant=lambda token: (_ for _ in ()).throw(
                    ValueError(f"non-finite JSON number {token}")
                ),
            )
        except (json.JSONDecodeError, ValueError) as error:
            message = (
                error.msg if isinstance(error, json.JSONDecodeError) else str(error)
            )
            raise ValueError(f"line {line_number}: invalid JSON: {message}") from error
        case = _parse_case(value, line_number)
        if case.case_id in seen_ids:
            raise ValueError(f"line {line_number}: duplicate case id {case.case_id!r}")
        seen_ids.add(case.case_id)
        cases.append(case)
    if not cases:
        raise ValueError("dataset must contain at least one non-empty JSONL record")
    return Dataset(cases=tuple(cases), sha256=hashlib.sha256(raw).hexdigest())


def _parse_case(value: Any, line_number: int) -> EvaluationCase:
    prefix = f"line {line_number}"
    if not isinstance(value, dict):
        raise TypeError(f"{prefix}: record must be an object")
    unknown = set(value) - ALLOWED_FIELDS
    if unknown:
        raise ValueError(f"{prefix}: unknown fields: {', '.join(sorted(unknown))}")

    case_id = _required_string(value, "id", prefix)
    if not CASE_ID_PATTERN.fullmatch(case_id):
        raise ValueError(f"{prefix}: id has an invalid format")
    query = _required_string(value, "query", prefix).strip()
    if not 2 <= len(query) <= 2_000:
        raise ValueError(f"{prefix}: query length must be between 2 and 2000")
    knowledge_base_id = _uuid(value.get("knowledgeBaseId"), "knowledgeBaseId", prefix)
    user_id = _uuid(value.get("userId"), "userId", prefix)
    expected_no_answer = _required_bool(value, "expectedNoAnswer", prefix)
    semantic_required = _required_bool(value, "semanticRequired", prefix)
    relevance = _relevance(value.get("relevance"), prefix)
    forbidden_chunks = _uuid_set(
        value.get("forbiddenChunkIds", []), "forbiddenChunkIds", prefix
    )
    forbidden_documents = _uuid_set(
        value.get("forbiddenDocumentIds", []), "forbiddenDocumentIds", prefix
    )
    forbidden_bases = _uuid_set(
        value.get("forbiddenKnowledgeBaseIds", []), "forbiddenKnowledgeBaseIds", prefix
    )
    limit = value.get("limit", 10)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 10 <= limit <= 20:
        raise ValueError(f"{prefix}: limit must be an integer between 10 and 20")

    if expected_no_answer and relevance:
        raise ValueError(f"{prefix}: no-answer cases must not declare relevant chunks")
    if not expected_no_answer and not relevance:
        raise ValueError(f"{prefix}: answerable cases must declare relevant chunks")
    if not expected_no_answer and not semantic_required:
        raise ValueError(f"{prefix}: answerable cases must require the semantic chain")
    overlap = set(relevance).intersection(forbidden_chunks)
    if overlap:
        raise ValueError(f"{prefix}: relevant and forbidden chunks overlap")
    if not expected_no_answer and knowledge_base_id in forbidden_bases:
        raise ValueError(
            f"{prefix}: an answerable case cannot forbid its target knowledge base"
        )

    return EvaluationCase(
        case_id=case_id,
        query=query,
        knowledge_base_id=knowledge_base_id,
        user_id=user_id,
        expected_no_answer=expected_no_answer,
        semantic_required=semantic_required,
        relevance=relevance,
        forbidden_chunk_ids=frozenset(forbidden_chunks),
        forbidden_document_ids=frozenset(forbidden_documents),
        forbidden_knowledge_base_ids=frozenset(forbidden_bases),
        limit=limit,
    )


def validate_dataset_coverage(
    dataset: Dataset,
    *,
    min_cases: int,
    min_answerable: int,
    min_no_answer: int,
    min_acl_cases: int,
) -> dict[str, int]:
    counts = {
        "total": len(dataset.cases),
        "answerable": sum(not case.expected_no_answer for case in dataset.cases),
        "noAnswer": sum(case.expected_no_answer for case in dataset.cases),
        "acl": sum(case.has_acl_expectation for case in dataset.cases),
        "semanticRequired": sum(case.semantic_required for case in dataset.cases),
    }
    requirements = {
        "total": min_cases,
        "answerable": min_answerable,
        "noAnswer": min_no_answer,
        "acl": min_acl_cases,
    }
    failures = [
        f"{name}={counts[name]} is below required {minimum}"
        for name, minimum in requirements.items()
        if counts[name] < minimum
    ]
    if failures:
        raise ValueError("dataset coverage is insufficient: " + "; ".join(failures))
    return counts


def _required_string(value: dict[str, Any], field: str, prefix: str) -> str:
    item = value.get(field)
    if not isinstance(item, str) or not item:
        raise ValueError(f"{prefix}: {field} must be a non-empty string")
    return item


def _required_bool(value: dict[str, Any], field: str, prefix: str) -> bool:
    item = value.get(field)
    if not isinstance(item, bool):
        raise TypeError(f"{prefix}: {field} must be a boolean")
    return item


def _uuid(value: Any, field: str, prefix: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{prefix}: {field} must be a UUID string")
    try:
        return str(UUID(value))
    except ValueError as error:
        raise ValueError(f"{prefix}: {field} must be a UUID string") from error


def _uuid_set(value: Any, field: str, prefix: str) -> set[str]:
    if not isinstance(value, list):
        raise TypeError(f"{prefix}: {field} must be an array")
    return {_uuid(item, field, prefix) for item in value}


def _relevance(value: Any, prefix: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise TypeError(f"{prefix}: relevance must be an object keyed by chunk UUID")
    parsed: dict[str, float] = {}
    for item_id, raw_grade in value.items():
        normalized_id = _uuid(item_id, "relevance key", prefix)
        if normalized_id in parsed:
            raise ValueError(f"{prefix}: relevance contains duplicate normalized UUIDs")
        if isinstance(raw_grade, bool) or not isinstance(raw_grade, (int, float)):
            raise TypeError(f"{prefix}: relevance grades must be numeric")
        grade = float(raw_grade)
        if not 0 < grade <= 3:
            raise ValueError(f"{prefix}: relevance grades must be in (0, 3]")
        parsed[normalized_id] = grade
    return parsed


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result
