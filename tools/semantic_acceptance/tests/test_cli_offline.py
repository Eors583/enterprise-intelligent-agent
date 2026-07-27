from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from tools.semantic_acceptance.cli import main


class CliOfflineTest(unittest.TestCase):
    def test_dataset_validation_mode_never_constructs_an_http_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "questions.jsonl"
            dataset.write_text(
                json.dumps(
                    {
                        "id": "offline-case",
                        "query": "差旅费用如何报销？",
                        "knowledgeBaseId": "10000000-0000-4000-8000-000000000001",
                        "userId": "20000000-0000-4000-8000-000000000001",
                        "expectedNoAnswer": False,
                        "semanticRequired": True,
                        "relevance": {"30000000-0000-4000-8000-000000000001": 3},
                        "forbiddenChunkIds": ["30000000-0000-4000-8000-000000000002"],
                        "forbiddenDocumentIds": [],
                        "forbiddenKnowledgeBaseIds": [],
                        "limit": 10,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            output = io.StringIO()
            with (
                patch(
                    "tools.semantic_acceptance.cli.JsonHttpClient",
                    side_effect=AssertionError(
                        "network client must not be constructed"
                    ),
                ),
                redirect_stdout(output),
            ):
                exit_code = main(
                    [
                        "--validate-dataset-only",
                        "--dataset",
                        str(dataset),
                        "--min-cases",
                        "1",
                        "--min-answerable",
                        "1",
                        "--min-no-answer",
                        "0",
                        "--min-acl-cases",
                        "1",
                    ]
                )

        self.assertEqual(exit_code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "dataset-valid")
        self.assertFalse(result["networkAccessed"])

    def test_provider_smoke_failure_skips_problem_set_requests_and_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "questions.jsonl"
            report = Path(directory) / "report.json"
            dataset.write_text(
                json.dumps(_record(), ensure_ascii=False), encoding="utf-8"
            )
            fake_client = Mock(safe_base_url="https://acceptance.example.test")
            output = io.StringIO()
            with (
                patch.dict(
                    "os.environ",
                    {"SEMANTIC_ACCEPTANCE_API_TOKEN": "short-lived"},
                    clear=False,
                ),
                patch(
                    "tools.semantic_acceptance.cli.JsonHttpClient",
                    return_value=fake_client,
                ),
                patch(
                    "tools.semantic_acceptance.cli.run_provider_smoke",
                    side_effect=RuntimeError("provider unavailable"),
                ),
                patch("tools.semantic_acceptance.cli.run_evaluation_case") as run_case,
                redirect_stdout(output),
            ):
                exit_code = main(
                    [
                        "--allow-network",
                        "--dataset",
                        str(dataset),
                        "--tenant-id",
                        "00000000-0000-4000-8000-000000000001",
                        "--expected-embedding-model",
                        "embedding-v1",
                        "--expected-rerank-model",
                        "rerank-v1",
                        "--report",
                        str(report),
                        "--min-cases",
                        "1",
                        "--min-answerable",
                        "1",
                        "--min-no-answer",
                        "0",
                        "--min-acl-cases",
                        "1",
                    ]
                )

            self.assertEqual(exit_code, 1)
            run_case.assert_not_called()
            report_text = report.read_text(encoding="utf-8")
            report_body = json.loads(report_text)
            self.assertEqual(report_body["status"], "FAIL")
            self.assertEqual(
                report_body["evaluationSkippedReason"], "PROVIDER_SMOKE_FAILED"
            )
            self.assertNotIn("差旅费用如何报销", report_text)


def _record() -> dict[str, object]:
    return {
        "id": "offline-case",
        "query": "差旅费用如何报销？",
        "knowledgeBaseId": "10000000-0000-4000-8000-000000000001",
        "userId": "20000000-0000-4000-8000-000000000001",
        "expectedNoAnswer": False,
        "semanticRequired": True,
        "relevance": {"30000000-0000-4000-8000-000000000001": 3},
        "forbiddenChunkIds": ["30000000-0000-4000-8000-000000000002"],
        "forbiddenDocumentIds": [],
        "forbiddenKnowledgeBaseIds": [],
        "limit": 10,
    }


if __name__ == "__main__":
    unittest.main()
