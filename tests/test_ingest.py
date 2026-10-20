"""Native HTTP stories on disposable synthetic state only."""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class QuietHandler(server.Handler):
    def log_message(self, fmt, *args):
        pass


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name, value in (("ROOT", self.root), ("DATA_RAW", self.root / "data/raw"),
                            ("TOKEN", "synthetic-only"), ("MAX_BODY", 1024)):
            item = patch.object(server, name, value)
            item.start()
            self.addCleanup(item.stop)
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, path, body=None, headers=None, method="POST"):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)
        try:
            connection.request(method, path, body, headers or {})
            reply = connection.getresponse()
            return reply.status, reply.read()
        finally:
            connection.close()

    def test_health_is_exact_non_data_response(self):
        self.assertEqual(self.request("/healthz", method="GET"), (200, b"ok\n"))
        self.assertFalse((self.root / "data").exists())

    def test_rejections_write_nothing(self):
        good = {"Authorization": "Bearer synthetic-only"}
        cases = [
            ("/ingest/synthetic", b"{}", {}, 403),
            ("/ingest/synthetic", b"{}", {"Authorization": "Bearer wrong"}, 403),
            ("/ingest/synthetic", b"not-json", good, 400),
            ("/ingest/synthetic", b"", good, 400),
            ("/ingest/synthetic", b"x" * 1025, good, 413),
            ("/ingest/../escape", b"{}", good, 400),
            ("/elsewhere", b"{}", good, 404),
        ]
        for path, body, headers, expected in cases:
            with self.subTest(path=path, expected=expected):
                self.assertEqual(self.request(path, body, headers)[0], expected)
        self.assertFalse((self.root / "data").exists())

    def test_acceptance_and_identical_replay_append_exact_synthetic_payload(self):
        payload = {"synthetic": "fixture", "sequence": 1}
        body = json.dumps(payload).encode()
        headers = {"Authorization": "Bearer synthetic-only"}
        for count in (1, 2):
            status, raw = self.request("/ingest/synthetic", body, headers)
            reply = json.loads(raw)
            self.assertEqual(status, 200)
            self.assertEqual({key: reply[key] for key in ("status", "source", "bytes")},
                             {"status": "ok", "source": "synthetic", "bytes": len(body)})
            records = json.loads((self.root / reply["stored"]).read_text())
            self.assertEqual(len(records), count)
            self.assertEqual([item["payload"] for item in records], [payload] * count)


if __name__ == "__main__":
    unittest.main()
