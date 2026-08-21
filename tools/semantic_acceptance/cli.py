from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from .dataset import load_dataset, validate_dataset_coverage
from .evaluation import AcceptanceThresholds, evaluate_cases
from .http_client import JsonHttpClient, validate_secret_env_name
from .runner import run_evaluation_case, run_provider_smoke


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Offline-first live acceptance harness for real embeddings, reranking, semantic "
            "retrieval quality, no-answer behavior, latency, and ACL isolation."
        )
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--allow-network",
        action="store_true",
        help="Explicitly permit calls to the configured deployed API and AI Runtime.",
    )
    mode.add_argument(
        "--validate-dataset-only",
        action="store_true",
        help="Validate JSONL structure and coverage without opening a network connection.",
    )
    parser.add_argument(
        "--dataset", type=Path, required=True, help="UTF-8 redacted JSONL file"
    )
    parser.add_argument("--api-base-url", default="http://127.0.0.1:3000/api/v1")
    parser.add_argument("--runtime-base-url", default="http://127.0.0.1:8100")
    parser.add_argument("--tenant-id")
    parser.add_argument("--expected-embedding-model")
    parser.add_argument("--expected-rerank-model")
    parser.add_argument(
        "--api-token-env",
        default="SEMANTIC_ACCEPTANCE_API_TOKEN",
        help="Name of the environment variable containing an admin bearer token.",
    )
    parser.add_argument(
        "--runtime-token-env",
        default="SEMANTIC_ACCEPTANCE_RUNTIME_TOKEN",
        help="Optional environment variable for a private-runtime proxy bearer token.",
    )
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--min-recall-at-5", type=float, default=0.8)
    parser.add_argument("--min-mrr", type=float, default=0.7)
    parser.add_argument("--min-ndcg-at-10", type=float, default=0.7)
    parser.add_argument("--min-no-answer-accuracy", type=float, default=0.9)
    parser.add_argument("--max-p95-ms", type=float, default=3_000.0)
    parser.add_argument("--max-acl-leaks", type=int, default=0)
    parser.add_argument("--min-cases", type=int, default=200)
    parser.add_argument("--min-answerable", type=int, default=150)
    parser.add_argument("--min-no-answer", type=int, default=25)
    parser.add_argument("--min-acl-cases", type=int, default=25)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        dataset = load_dataset(args.dataset)
        counts = validate_dataset_coverage(
            dataset,
            min_cases=_nonnegative(args.min_cases, "min-cases"),
            min_answerable=_nonnegative(args.min_answerable, "min-answerable"),
            min_no_answer=_nonnegative(args.min_no_answer, "min-no-answer"),
            min_acl_cases=_nonnegative(args.min_acl_cases, "min-acl-cases"),
        )
        thresholds = AcceptanceThresholds(
            min_recall_at_5=args.min_recall_at_5,
            min_mrr=args.min_mrr,
            min_ndcg_at_10=args.min_ndcg_at_10,
            min_no_answer_accuracy=args.min_no_answer_accuracy,
            max_p95_ms=args.max_p95_ms,
            max_acl_leaks=args.max_acl_leaks,
        )
    except (OSError, ValueError) as error:
        parser.error(str(error))

    if args.validate_dataset_only:
        print(
            json.dumps(
                {
                    "status": "dataset-valid",
                    "networkAccessed": False,
                    "datasetSha256": dataset.sha256,
                    "counts": counts,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    try:
        if args.report is not None and args.report.resolve() == args.dataset.resolve():
            raise ValueError("--report must not overwrite the input dataset")
        tenant_id = str(UUID(_required(args.tenant_id, "--tenant-id")))
        expected_embedding_model = _required(
            args.expected_embedding_model, "--expected-embedding-model"
        )
        expected_rerank_model = _required(
            args.expected_rerank_model, "--expected-rerank-model"
        )
        api_token_name = validate_secret_env_name(args.api_token_env)
        runtime_token_name = validate_secret_env_name(args.runtime_token_env)
        api_token = _required(os.environ.get(api_token_name), api_token_name)
        runtime_token = os.environ.get(runtime_token_name) or None
        api = JsonHttpClient(
            args.api_base_url,
            timeout_seconds=args.timeout_seconds,
            bearer_token=api_token,
        )
        runtime = JsonHttpClient(
            args.runtime_base_url,
            timeout_seconds=args.timeout_seconds,
            bearer_token=runtime_token,
        )
    except ValueError as error:
        parser.error(str(error))

    started_at = datetime.now(UTC)
    provider_smoke: dict[str, Any] | None = None
    provider_failure: str | None = None
    try:
        smoke = run_provider_smoke(
            runtime,
            tenant_id=tenant_id,
            expected_embedding_model=expected_embedding_model,
            expected_rerank_model=expected_rerank_model,
        )
        provider_smoke = {
            "capabilities": smoke.capabilities,
            "embeddings": smoke.embeddings,
            "rerank": smoke.rerank,
        }
    except (OSError, RuntimeError, ValueError) as error:
        provider_failure = str(error)

    observations = (
        ()
        if provider_failure
        else tuple(
            run_evaluation_case(
                api,
                case,
                expected_embedding_model=expected_embedding_model,
                expected_rerank_model=expected_rerank_model,
            )
            for case in dataset.cases
        )
    )
    evaluation = evaluate_cases(dataset.cases, observations, thresholds)
    failures = list(evaluation["failures"])
    if provider_failure:
        failures.insert(0, f"provider smoke failed: {provider_failure}")
    completed_at = datetime.now(UTC)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "PASS" if not failures else "FAIL",
        "networkAccessed": True,
        "startedAt": started_at.isoformat(),
        "completedAt": completed_at.isoformat(),
        "targets": {
            "apiBaseUrl": api.safe_base_url,
            "runtimeBaseUrl": runtime.safe_base_url,
        },
        "expectedModels": {
            "embedding": expected_embedding_model,
            "embeddingDimensions": 1536,
            "reranker": expected_rerank_model,
        },
        "dataset": {
            "sha256": dataset.sha256,
            "counts": counts,
            "queriesIncludedInReport": False,
        },
        "providerSmoke": provider_smoke,
        "providerSmokeFailure": provider_failure,
        "evaluationSkippedReason": "PROVIDER_SMOKE_FAILED"
        if provider_failure
        else None,
        "metrics": evaluation["metrics"],
        "thresholds": evaluation["thresholds"],
        "failures": failures,
        "cases": evaluation["cases"],
    }
    report_path = args.report or _default_report_path(completed_at)
    try:
        _write_report(report_path, report)
    except OSError as error:
        print(
            json.dumps(
                {
                    "status": "ERROR",
                    "networkAccessed": True,
                    "message": f"acceptance report could not be written ({type(error).__name__})",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(
        json.dumps(
            {
                "status": report["status"],
                "report": str(report_path.resolve()),
                "datasetSha256": dataset.sha256,
                "metrics": report["metrics"],
                "failureCount": len(failures),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["status"] == "PASS" else 1


def _required(value: str | None, label: str) -> str:
    if value is None or not value.strip():
        raise ValueError(f"{label} is required for live acceptance")
    return value.strip()


def _nonnegative(value: int, label: str) -> int:
    if value < 0:
        raise ValueError(f"{label} must not be negative")
    return value


def _default_report_path(now: datetime) -> Path:
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    return Path(".data") / "semantic-acceptance" / f"report-{timestamp}.json"


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(path)


if __name__ == "__main__":
    sys.exit(main())
