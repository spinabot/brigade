#!/usr/bin/env python3
"""Generate Atlas Cloud image or video media with bounded polling."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API_BASE = "https://api.atlascloud.ai/api/v1"
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
USER_AGENT = "Brigade-AtlasCloudMedia/1.0"
DEFAULT_MODELS = {
    "image": "qwen-image-3.0/text-to-image",
    "video": "bytedance/seedance-2.0-fast/text-to-video",
}
DEFAULT_PARAMS = {
    "image": {"size": "1024*1024"},
    "video": {"duration": 4, "resolution": "720p"},
}


def _request_json(
    url: str,
    *,
    api_key: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode(errors="replace")
        raise RuntimeError(f"Atlas Cloud HTTP {error.code}: {detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f"Atlas Cloud request failed: {error}") from error
    if not isinstance(result, dict):
        raise RuntimeError("Atlas Cloud returned an invalid JSON response")
    return result


def _prediction_data(response: dict[str, Any]) -> dict[str, Any]:
    data = response.get("data", response)
    if not isinstance(data, dict):
        raise RuntimeError("Atlas Cloud returned invalid prediction data")
    return data


def _output_url(prediction: dict[str, Any]) -> str:
    outputs = prediction.get("outputs")
    value = outputs[0] if isinstance(outputs, list) and outputs else None
    if not isinstance(value, str):
        raise RuntimeError("Atlas Cloud prediction completed without an output URL")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("Atlas Cloud returned an unsafe output URL")
    return value


def _payload(kind: str, model: str, prompt: str, params_json: str | None) -> dict[str, Any]:
    params: dict[str, Any] = dict(DEFAULT_PARAMS[kind])
    if params_json:
        value = json.loads(params_json)
        if not isinstance(value, dict):
            raise ValueError("--params-json must contain a JSON object")
        params.update(value)
    params.pop("model", None)
    params.pop("prompt", None)
    return {"model": model, "prompt": prompt, **params}


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "image/*,video/*,application/octet-stream",
            "User-Agent": USER_AGENT,
        },
    )
    temporary = destination.with_name(f".{destination.name}.part")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            final_url = urllib.parse.urlparse(response.geturl())
            if final_url.scheme != "https" or not final_url.hostname:
                raise RuntimeError("Media download redirected to an unsafe URL")
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > MAX_DOWNLOAD_BYTES:
                raise RuntimeError("Generated media exceeds the 64 MiB download limit")
            destination.parent.mkdir(parents=True, exist_ok=True)
            total = 0
            with temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise RuntimeError("Generated media exceeds the 64 MiB download limit")
                    output.write(chunk)
            os.replace(temporary, destination)
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f"Media download failed: {error}") from error
    finally:
        temporary.unlink(missing_ok=True)


def _default_output(kind: str, output_url: str) -> Path:
    suffix = Path(urllib.parse.urlparse(output_url).path).suffix
    if not suffix:
        suffix = mimetypes.guess_extension("image/png" if kind == "image" else "video/mp4") or ""
    return Path.cwd() / f"atlas-{kind}{suffix}"


def generate(args: argparse.Namespace) -> Path:
    api_key = os.environ.get("ATLASCLOUD_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ATLASCLOUD_API_KEY is not set")
    endpoint = "generateImage" if args.kind == "image" else "generateVideo"
    submitted = _prediction_data(
        _request_json(
            f"{API_BASE}/model/{endpoint}",
            api_key=api_key,
            payload=_payload(args.kind, args.model, args.prompt, args.params_json),
        )
    )
    prediction_id = submitted.get("id")
    if not isinstance(prediction_id, str) or not prediction_id:
        raise RuntimeError("Atlas Cloud did not return a prediction id")

    prediction = submitted
    for attempt in range(args.max_polls + 1):
        status = str(prediction.get("status") or "").lower()
        if status == "completed":
            break
        if status in {"failed", "timeout", "cancelled", "canceled"}:
            raise RuntimeError(f"Atlas Cloud generation failed: {prediction.get('error') or status}")
        if attempt == args.max_polls:
            raise RuntimeError("Atlas Cloud generation exceeded the polling limit")
        time.sleep(args.poll_seconds)
        prediction = _prediction_data(
            _request_json(
                f"{API_BASE}/model/prediction/{urllib.parse.quote(prediction_id, safe='')}",
                api_key=api_key,
            )
        )

    output_url = _output_url(prediction)
    destination = Path(args.out).expanduser() if args.out else _default_output(args.kind, output_url)
    _download(output_url, destination)
    return destination.resolve()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("image", "video"))
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--model")
    parser.add_argument("--out")
    parser.add_argument("--params-json")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--max-polls", type=int, default=150)
    return parser


def main() -> int:
    parser = _parser()
    args = parser.parse_args()
    args.model = args.model or DEFAULT_MODELS[args.kind]
    if args.poll_seconds < 0 or args.max_polls < 1:
        parser.error("polling values must be positive")
    try:
        print(generate(args))
    except (RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
