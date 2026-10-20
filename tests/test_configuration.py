"""Explicit configuration, synthetic delivery and refusal before store access."""
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import export_artoo
import poll_cloudflare_hevy
import sync_hevy

KEY = "11111111-2222-3333-4444-555555555555"


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def serve(self, handler):
        server = HTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join()
            server.server_close()
        self.addCleanup(stop)
        return server

    def test_missing_configuration_never_uses_adjacent_settings_or_store(self):
        for name, flags, setting in [
            ("export_artoo.py", [], "--workspace"),
            ("sync_hevy.py", ["--poll"], "--state"),
            ("poll_cloudflare_hevy.py", [], "HEALTH_INGEST_POLLER_HEADERS_FILE"),
        ]:
            with self.subTest(name=name):
                root = self.root / name.removesuffix(".py")
                scripts = root / "scripts"
                scripts.mkdir(parents=True)
                script = scripts / name
                script.write_bytes((ROOT / "scripts" / name).read_bytes())
                state = root / "data/state/hevy.json"
                state.parent.mkdir(parents=True)
                state.write_text('{"since":"2020-01-01T00:00:00Z"}')
                (root / ".env").write_text(
                    f"HEVY_API_KEY={KEY}\nHEALTH_INGEST_TOKEN=fictional-adjacent-token\n")
                for relative, content in [
                    (".config/health-ingest/hevy.env", "HEALTH_INGEST_TOKEN=fictional-home-token"),
                    (".config/health-ingest/headers.json", json.dumps({
                        "CF-Access-Client-Id": "synthetic-id",
                        "CF-Access-Client-Secret": "synthetic-secret"})),
                    (".cache/health-ingest/sentinel", "synthetic-existing-file"),
                    (".config/health-ingest/artoo.token", "synthetic-archive-token"),
                    ("scripts/health-ingest-hevy-headers.json", json.dumps({
                        "CF-Access-Client-Id": "synthetic-id",
                        "CF-Access-Client-Secret": "synthetic-secret"})),
                    ("lab_results.jsonl", '{"synthetic_lab":true}\n'),
                ]:
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                    path.chmod(0o600)
                for folder, names in [("health-data", ["metrics_daily", "sleep", "workouts"]),
                                      ("finance-data", ["accounts", "transactions", "investments", "liabilities"])]:
                    directory = root / "workspace" / folder
                    directory.mkdir(parents=True)
                    for item in names:
                        (directory / f"{item}.jsonl").write_text('{"fictional":true}\n')
                (root / "workspace/finance-data/inbox").mkdir()
                if name == "export_artoo.py":
                    flags = ["--labs", str(root / "lab_results.jsonl")]
                paths_before = sorted(p.relative_to(root) for p in root.rglob("*"))
                before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
                # A bound, non-listening port refuses any accidental proxy connection.
                with socket.socket() as closed:
                    closed.bind(("127.0.0.1", 0))
                    proxy = f"http://127.0.0.1:{closed.getsockname()[1]}"
                    result = subprocess.run([sys.executable, str(script), *flags], cwd=root,
                        env={"HOME": str(root), "HERMES_HOME": str(root), "HEVY_API_KEY": KEY,
                             "HEALTH_INGEST_TOKEN": "fictional-process-token",
                             "http_proxy": proxy, "https_proxy": proxy,
                             "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
                             "TMPDIR": str(root), "PYTHONDONTWRITEBYTECODE": "1"},
                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertIn(setting, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertNotIn(KEY, result.stderr)
                self.assertNotIn("fictional-", result.stderr)
                after = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
                self.assertEqual(after, before)
                self.assertEqual(sorted(p.relative_to(root) for p in root.rglob("*")), paths_before)

    def test_hevy_receiver_redirect_refuses_without_forwarding_or_cursor_change(self):
        target_requests = []

        class Target(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                target_requests.append((self.command, self.headers.get("Authorization")))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            do_POST = do_GET

        target = self.serve(Target)

        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

        receiver = self.serve(Receiver)
        cursor = self.root / "cursor.json"
        original = b'{ "since": "2020-01-01T00:00:00Z" }\n'
        cursor.write_bytes(original)
        url = f"http://127.0.0.1:{receiver.server_port}"
        # Call the same poll/post boundary on old and new source, independent of CLI changes.
        driver = """
import sys
from pathlib import Path
from types import SimpleNamespace
import urllib.error
sys.path.insert(0, sys.argv[1])
import sync_hevy
client = SimpleNamespace(pages=lambda *args: iter([(1, 1, [{"id": "synthetic"}])]))
post = lambda payload: sync_hevy.post_to_ingest(payload, sys.argv[3], "synthetic-bearer")
try:
    sync_hevy.poll(client, post, Path(sys.argv[2]))
except urllib.error.URLError as error:
    if isinstance(error, urllib.error.HTTPError):
        error.close()
    sys.exit(1)
"""
        completed = subprocess.run([sys.executable, "-c", driver, str(ROOT / "scripts"),
                                    str(cursor), url], env={"NO_PROXY": "127.0.0.1",
                                    "PYTHONDONTWRITEBYTECODE": "1"},
                                    capture_output=True, timeout=10)
        result = completed.returncode
        self.assertNotEqual(result, 0, json.dumps({
            "target_requests": len(target_requests),
            "bearer_forwarded": any(auth == "Bearer synthetic-bearer" for _, auth in target_requests),
            "cursor_unchanged": cursor.read_bytes() == original,
        }))
        self.assertEqual(target_requests, [])
        self.assertEqual(cursor.read_bytes(), original)

    def test_hevy_receiver_url_refused_before_token_or_network(self):
        for url in ["http://example.invalid", "http://192.0.2.1", "ftp://127.0.0.1",
                    "https://user@example.invalid", "https://@example.invalid",
                    "https://example.invalid?", "https://example.invalid?q=synthetic",
                    "https://example.invalid#", "https://example.invalid#synthetic"]:
            with self.subTest(url=url), patch.dict(os.environ, {}, clear=True), \
                    patch.object(socket, "getaddrinfo", side_effect=AssertionError("network attempted")), \
                    contextlib.redirect_stderr(io.StringIO()) as output, \
                    self.assertRaises(SystemExit) as refusal:
                sync_hevy.main(["--poll", "--state", str(self.root / "cursor"), "--ingest-url", url])
            self.assertEqual(refusal.exception.code, 2)
            self.assertIn("--ingest-url", output.getvalue())
            self.assertNotIn("HEVY_API_KEY missing", output.getvalue())
        for url in ["https://example.invalid", "http://127.0.0.1:8789", "http://[::1]:8789",
                    "http://100.64.0.1:8789", "http://100.127.255.255:8789"]:
            sync_hevy.validate_ingest_url(url)

    def test_explicit_hevy_env_file_must_be_readable(self):
        for via_env in (False, True):
            for failure in (FileNotFoundError, PermissionError, UnicodeDecodeError):
                with self.subTest(via_env=via_env, failure=failure.__name__):
                    error = (UnicodeDecodeError("utf8", b"x", 0, 1, "synthetic")
                             if failure is UnicodeDecodeError else failure("synthetic-private-canary"))
                    settings = self.root / "missing.env"
                    env = {"HEALTH_INGEST_ENV_FILE": str(settings)} if via_env else {}
                    flags = [] if via_env else ["--env-file", str(settings)]
                    with patch.dict(os.environ, env, clear=True), \
                            patch.object(Path, "read_text", side_effect=error), \
                            contextlib.redirect_stderr(io.StringIO()) as output, \
                            self.assertRaises(SystemExit) as refusal:
                        sync_hevy.main(["--poll", *flags])
                    self.assertEqual(refusal.exception.code, 2)
                    self.assertIn("--env-file", output.getvalue())
                    self.assertIn("HEALTH_INGEST_ENV_FILE", output.getvalue())
                    self.assertNotIn("synthetic-private-canary", output.getvalue())
        with patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(io.StringIO()) as output, \
                self.assertRaises(SystemExit) as refusal:
            sync_hevy.main(["--poll", "--env-file", str(self.root / "actually-missing.env")])
        self.assertEqual(refusal.exception.code, 2)
        self.assertIn("--env-file", output.getvalue())

    def test_artoo_environment_and_flags_are_explicit_and_dns_is_refused(self):
        env = {"ARTOO_HOST": "100.64.0.1", "ARTOO_WORKSPACE": str(self.root / "workspace"),
               "ARTOO_LABS": str(self.root / "labs"), "ARTOO_CREDENTIAL_FILE": str(self.root / "token"),
               "ARTOO_SCRATCH": str(self.root / "scratch")}
        with patch.dict(os.environ, env, clear=True):
            _, config = export_artoo.configuration(["--port", "18789"])
            self.assertEqual(config.workspace, self.root / "workspace")
            self.assertEqual((config.host, config.port), ("100.64.0.1", 18789))
            for host in ["example.invalid", "192.0.2.1"]:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    export_artoo.configuration(["--host", host])

    def test_artoo_synthetic_archive_delivery_checks_exact_receipt(self):
        received = []
        mismatch = [False]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((self.path, self.headers["Authorization"], body))
                digest = "0" * 64 if mismatch[0] else hashlib.sha256(body).hexdigest()
                reply = json.dumps({"status": "ok", "sha256": digest, "bytes": len(body)}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

        server = self.serve(Handler)
        for folder, names in [("health-data", ["metrics_daily", "sleep", "workouts"]),
                              ("finance-data", ["accounts", "transactions", "investments", "liabilities"])]:
            directory = self.root / folder
            directory.mkdir()
            for name in names:
                (directory / f"{name}.jsonl").write_text('{"fictional":true}\n')
        (self.root / "finance-data/inbox").mkdir()
        labs = self.root / "labs.jsonl"
        labs.write_text('{"synthetic_lab":true}\n')
        credential = self.root / "token"
        credential.write_text("synthetic-only")
        flags = ["--workspace", str(self.root), "--labs", str(labs),
                 "--credential", str(credential), "--scratch", str(self.root / "scratch"),
                 "--host", "127.0.0.1", "--port", str(server.server_port)]
        with patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            export_artoo.main(flags)
            mismatch[0] = True
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                export_artoo.main(flags)
        self.assertEqual(received[0][:2], ("/artoo/snapshot", "Bearer synthetic-only"))
        with tarfile.open(fileobj=io.BytesIO(received[0][2]), mode="r:gz") as archive:
            self.assertEqual(len(archive.getnames()), 8)
            self.assertEqual(archive.extractfile("lab_results.jsonl").read(), labs.read_bytes())
        self.assertEqual(list((self.root / "scratch").iterdir()), [])

    def test_hevy_external_settings_and_environment_commit_only_explicit_cursor(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                seen.append((self.command, self.path, self.headers["api-key"]))
                self.reply({"page_count": 1, "workouts": [{"id": "fictional"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.command, self.path, self.headers["Authorization"], body))
                self.reply({"status": "ok"})

            def reply(self, value):
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = self.serve(Handler)
        url = f"http://127.0.0.1:{server.server_port}"
        settings = self.root / "settings.env"
        cursor = self.root / "external/state.json"
        settings.write_text(f"HEALTH_INGEST_STATE_FILE={cursor}\nHEALTH_INGEST_URL={url}\n"
                            "HEALTH_INGEST_TOKEN=fictional-file-token\n"
                            f"HEVY_API_KEY={KEY}\n")
        client = sync_hevy.HevyClient(KEY, url)
        with patch.dict(os.environ, {"HEVY_API_KEY": KEY, "HEALTH_INGEST_TOKEN": "fictional-env-token"}, clear=True), \
                patch.object(sync_hevy, "HevyClient", return_value=client), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sync_hevy.main(["--backfill", "--env-file", str(settings)]), 0)
        self.assertTrue(json.loads(cursor.read_text())["since"])
        self.assertEqual(seen[0][2], KEY)
        self.assertEqual(seen[1][:3], ("POST", "/ingest/hevy", "Bearer fictional-env-token"))
        self.assertEqual(seen[1][3]["workouts"], [{"id": "fictional"}])
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit) as refusal:
            sync_hevy.main(["--backfill", "--env-file", str(settings)])
        self.assertIn("HEVY_API_KEY missing", str(refusal.exception))
        self.assertEqual(len(seen), 2)

    def test_cloudflare_entrypoint_uses_explicit_endpoint_and_private_file(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append((self.path, self.headers["CF-Access-Client-Id"]))
                self.send_response(200)
                self.send_header("Content-Length", "11")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

        server = self.serve(Handler)
        private = self.root / "headers.json"
        private.write_text(json.dumps({"CF-Access-Client-Id": "synthetic-id",
                                       "CF-Access-Client-Secret": "synthetic-secret"}))
        private.chmod(0o600)
        url = f"http://127.0.0.1:{server.server_port}/internal/hevy-poll"
        with patch.dict(os.environ, {"HEALTH_INGEST_POLLER_HEADERS_FILE": str(private),
                                     "HEALTH_INGEST_POLL_URL": url}, clear=True):
            self.assertEqual(poll_cloudflare_hevy.main(), 0)
        self.assertEqual(received, [("/internal/hevy-poll", "synthetic-id")])
        for url in ["http://example.invalid/internal/hevy-poll", "https://example.invalid/wrong",
                    "https://user@example.invalid/internal/hevy-poll"]:
            with self.assertRaises(ValueError):
                poll_cloudflare_hevy.run(private, url)
        self.assertEqual(len(received), 1)


if __name__ == "__main__":
    unittest.main()
