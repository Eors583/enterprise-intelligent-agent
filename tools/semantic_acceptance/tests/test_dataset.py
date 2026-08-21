from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.semantic_acceptance.dataset import load_dataset, validate_dataset_coverage

KB_ID = "10000000-0000-4000-8000-000000000001"
USER_ID = "20000000-0000-4000-8000-000000000001"
CHUNK_ID = "30000000-0000-4000-8000-000000000001"
OTHER_CHUNK_ID = "30000000-0000-4000-8000-000000000002"


class DatasetTest(unittest.TestCase):
    def test_loads_redacted_jsonl_and_validates_coverage(self) -> None:
        records = [
            _record(
                id="answerable",
                expectedNoAnswer=False,
                semanticRequired=True,
                relevance={CHUNK_ID: 3},
                forbiddenChunkIds=[OTHER_CHUNK_ID],
            ),
            _record(
                id="no-answer",
                expectedNoAnswer=True,
                semanticRequired=True,
                relevance={},
            ),
        ]
        dataset = _dataset(records)

        self.assertEqual(len(dataset.cases), 2)
        self.assertEqual(len(dataset.sha256), 64)
        self.assertEqual(
            validate_dataset_coverage(
                dataset,
                min_cases=2,
                min_answerable=1,
                min_no_answer=1,
                min_acl_cases=1,
            ),
            {
                "total": 2,
                "answerable": 1,
                "noAnswer": 1,
                "acl": 1,
                "semanticRequired": 2,
            },
        )

    def test_rejects_unknown_fields_including_credentials(self) -> None:
        record = _record(apiToken="must-not-live-in-the-dataset")
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            _dataset([record])

    def test_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dataset.jsonl"
            path.write_text('{"id":"one","id":"two"}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
                load_dataset(path)

    def test_rejects_answerable_case_without_semantic_chain(self) -> None:
        record = _record(semanticRequired=False)
        with self.assertRaisesRegex(ValueError, "must require the semantic chain"):
            _dataset([record])

    def test_rejects_no_answer_case_with_relevant_chunks(self) -> None:
        record = _record(expectedNoAnswer=True)
        with self.assertRaisesRegex(ValueError, "must not declare relevant chunks"):
            _dataset([record])

    def test_rejects_relevant_forbidden_overlap(self) -> None:
        record = _record(forbiddenChunkIds=[CHUNK_ID])
        with self.assertRaisesRegex(ValueError, "overlap"):
            _dataset([record])

    def test_rejects_toy_dataset_at_enterprise_coverage_gate(self) -> None:
        dataset = _dataset([_record()])
        with self.assertRaisesRegex(ValueError, "coverage is insufficient"):
            validate_dataset_coverage(
                dataset,
                min_cases=200,
                min_answerable=150,
                min_no_answer=25,
                min_acl_cases=25,
            )


def _record(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "case-1",
        "query": "差旅费用如何报销？",
        "knowledgeBaseId": KB_ID,
        "userId": USER_ID,
        "expectedNoAnswer": False,
        "semanticRequired": True,
        "relevance": {CHUNK_ID: 3},
        "forbiddenChunkIds": [],
        "forbiddenDocumentIds": [],
        "forbiddenKnowledgeBaseIds": [],
        "limit": 10,
    }
    value.update(overrides)
    return value


def _dataset(records: list[dict[str, object]]):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "dataset.jsonl"
        path.write_text(
            "\n".join(json.dumps(record, ensure_ascii=False) for record in records),
            encoding="utf-8",
        )
        return load_dataset(path)


if __name__ == "__main__":
    unittest.main()
