#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except Exception:
        return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    experiment_plan = run_dir / "experiment-plan.md"
    results_json = run_dir / "results.json"
    run_log = run_dir / "run.log"
    manifest_json = run_dir / "manifest.json"
    evidence_index = run_dir / "evidence" / "index.json"
    labels_jsonl = run_dir / "labels.jsonl"
    dataset_jsonl = run_dir / "dataset.jsonl"
    dataset_csv = run_dir / "dataset.csv"

    missing: list[str] = []
    warnings: list[str] = []

    required_nonempty = {
        "experiment-plan.md": experiment_plan,
        "results.json": results_json,
        "run.log": run_log,
        "manifest.json": manifest_json,
    }
    for label, path in required_nonempty.items():
      if not nonempty_file(path):
        missing.append(label)

    evidence_artifacts = {
        "evidence/index.json": evidence_index,
        "dataset.jsonl": dataset_jsonl,
        "dataset.csv": dataset_csv,
        "labels.jsonl": labels_jsonl,
    }
    present_evidence = [label for label, path in evidence_artifacts.items() if nonempty_file(path)]
    if not present_evidence:
        missing.append("at least one evidence artifact (evidence/index.json, dataset.jsonl, dataset.csv, or labels.jsonl)")

    results_payload = read_json(results_json)
    if not isinstance(results_payload, dict):
        missing.append("results.json must parse as a JSON object")
    else:
        findings = results_payload.get("findings")
        if findings is None:
            warnings.append("results.json is missing a findings field")

    evidence_payload = read_json(evidence_index)
    evidence_count = 0
    if isinstance(evidence_payload, dict):
        records = evidence_payload.get("records")
        if isinstance(records, list):
            evidence_count = len(records)
    elif isinstance(evidence_payload, list):
        evidence_count = len(evidence_payload)
    if nonempty_file(evidence_index) and evidence_count == 0:
        warnings.append("evidence/index.json is present but has no records")

    manifest_payload = read_json(manifest_json)
    if not isinstance(manifest_payload, dict):
        warnings.append("manifest.json does not parse as JSON")
    else:
        output_file_list = manifest_payload.get("output_file_list")
        if not isinstance(output_file_list, list):
            warnings.append("manifest.json.output_file_list is missing or invalid")

    report = {
        "ok": len(missing) == 0,
        "run_dir": str(run_dir),
        "missing": missing,
        "warnings": warnings,
        "evidenceArtifacts": present_evidence,
        "evidenceCount": evidence_count,
        "files": {
            "experimentPlan": str(experiment_plan),
            "resultsJson": str(results_json),
            "runLog": str(run_log),
            "manifestJson": str(manifest_json),
            "evidenceIndex": str(evidence_index),
            "labelsJsonl": str(labels_jsonl) if labels_jsonl.exists() else None,
            "datasetJsonl": str(dataset_jsonl) if dataset_jsonl.exists() else None,
            "datasetCsv": str(dataset_csv) if dataset_csv.exists() else None,
        },
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
