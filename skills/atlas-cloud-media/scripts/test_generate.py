#!/usr/bin/env python3

import argparse
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("generate.py")
SPEC = importlib.util.spec_from_file_location("atlas_generate", MODULE_PATH)
assert SPEC and SPEC.loader
generate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate)


class AtlasMediaTests(unittest.TestCase):
    def test_payload_uses_defaults_and_protects_core_fields(self) -> None:
        payload = generate._payload(
            "image",
            "qwen-image-3.0/text-to-image",
            "studio portrait",
            '{"size":"1536*1024","model":"bad","prompt":"bad"}',
        )
        self.assertEqual(payload["model"], "qwen-image-3.0/text-to-image")
        self.assertEqual(payload["prompt"], "studio portrait")
        self.assertEqual(payload["size"], "1536*1024")

    def test_output_url_rejects_non_https_and_credentials(self) -> None:
        for value in ("http://cdn.example/output.png", "https://user@cdn.example/output.png"):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "unsafe"):
                generate._output_url({"outputs": [value]})

    def test_output_url_accepts_https(self) -> None:
        value = "https://cdn.example/output.mp4"
        self.assertEqual(generate._output_url({"outputs": [value]}), value)

    def test_parser_requires_prompt(self) -> None:
        parser = generate._parser()
        with self.assertRaises(SystemExit):
            parser.parse_args(["image"])


if __name__ == "__main__":
    unittest.main()
