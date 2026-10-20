import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import poll_cloudflare_hevy as poller


class PollerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name) / "headers.json"
        self.headers = {"CF-Access-Client-Id": "fictional-id", "CF-Access-Client-Secret": "fictional-secret"}
        self.private.write_text(json.dumps(self.headers))
        self.private.chmod(0o600)
        self.seen = []
        self.status, self.body = 200, b'{"ok":true}'
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                test.seen.append((self.command, self.path, dict(self.headers)))
                self.send_response(test.status)
                self.send_header("Location", "/must-not-follow")
                self.send_header("Content-Length", str(len(test.body)))
                self.end_headers()
                self.wfile.write(test.body)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.url = f"http://127.0.0.1:{server.server_port}/internal/hevy-poll"
        def stop():
            server.shutdown()
            thread.join()
            server.server_close()
        self.addCleanup(stop)

    def test_committed_poll_is_silent_and_has_only_named_auth(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            poller.run(self.private, self.url)
        self.assertEqual(output.getvalue(), "")
        method, route, headers = self.seen[0]
        self.assertEqual((method, route), ("POST", "/internal/hevy-poll"))
        self.assertEqual(headers["Cf-Access-Client-Id"], "fictional-id")
        self.assertEqual(headers["Cf-Access-Client-Secret"], "fictional-secret")
        self.assertNotIn("Authorization", headers)

    def test_denials_redirects_and_false_success_refuse_then_recover(self):
        for status, body in [(302, b"sensitive login"), (403, b"sensitive denial"),
                             (503, b"sensitive upstream"), (200, b"not committed")]:
            with self.subTest(status=status):
                self.status, self.body = status, body
                with self.assertRaises(Exception) as caught:
                    poller.run(self.private, self.url)
                if isinstance(caught.exception, urllib.error.HTTPError):
                    caught.exception.close()
        self.assertEqual(len(self.seen), 4)  # No redirect destination or tight retries.
        self.status, self.body = 200, b'{"ok":true}'
        poller.run(self.private, self.url)
        self.assertEqual(len(self.seen), 5)

    def test_unsafe_file_and_header_configs_refuse_before_network(self):
        self.private.chmod(0o644)
        with self.assertRaises(Exception):
            poller.run(self.private, self.url)
        self.private.chmod(0o600)
        for headers in [{}, {**self.headers, "Authorization": "forbidden"},
                        {**self.headers, "CF-Access-Client-Secret": "bad\nheader"}]:
            self.private.write_text(json.dumps(headers))
            with self.assertRaises(Exception):
                poller.run(self.private, self.url)
        link = self.private.with_name("link.json")
        link.symlink_to(self.private)
        with self.assertRaises(Exception):
            poller.run(link, self.url)
        self.assertEqual(self.seen, [])

    def test_entrypoint_failure_is_nonzero_and_never_emits_config(self):
        self.private.write_text("private-invalid-canary")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = poller.main(self.private, self.url)
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), poller.FAILURE + "\n")


if __name__ == "__main__":
    unittest.main()
