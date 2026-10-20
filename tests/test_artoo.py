"""Consumer boundaries: separate authority, atomic landing, immutable receipts."""
import hashlib
import http.client
import json
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class TailnetHandler(server.Handler):
    def setup(self):
        super().setup()
        # Model only the TCP peer; the HTTP and storage paths are production code.
        self.client_address = ("100.64.0.1", self.client_address[1])

    def log_message(self, *args):
        pass


class LandingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.patches = [
            patch.object(server, "ROOT", self.root),
            patch.object(server, "DATA_RAW", self.root / "data/raw"),
            patch.object(server, "ARTOO_TOKEN", "artoo-test"),
            patch.object(server, "TOKEN", "health-test"),
        ]
        for item in self.patches:
            item.start()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), TailnetHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def post(self, body=b"opaque archive bytes", credential="artoo-test", path="/artoo/snapshot", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)
        connection.request("POST", path, body=body, headers=headers or {
            "Authorization": "Bearer " + credential,
            "Content-Type": "application/gzip",
        })
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_credentials_cannot_cross_into_other_producers(self):
        self.assertEqual(self.post(credential="health-test")[0], 403)
        self.assertEqual(self.post(credential="wrong")[0], 403)
        self.assertEqual(self.post(path="/ingest/healthautoexport", body=b"{}")[0], 403)
        self.assertFalse((self.root / "data").exists())

    def test_non_tailnet_peer_cannot_upload_even_with_credential(self):
        with patch.object(TailnetHandler, "setup", server.Handler.setup):
            self.assertEqual(self.post()[0], 403)
        self.assertFalse((self.root / "data").exists())

    def test_receipt_matches_bytes_and_repeated_upload_is_immutable(self):
        body = b"full history\x00\xff\r\n"
        status, reply = self.post(body)
        self.assertEqual(status, 200)
        receipt = json.loads(reply)
        target = self.root / receipt["stored"]
        self.assertEqual(target.read_bytes(), body)
        self.assertEqual(receipt["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(receipt["bytes"], len(body))
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(json.loads((target.parent / "receipt.json").read_text()), receipt)
        self.assertEqual(json.loads(self.post(body)[1]), receipt)
        second = json.loads(self.post(b"next full history")[1])
        self.assertNotEqual(second["stored"], receipt["stored"])
        self.assertEqual(target.read_bytes(), body)

    def test_incomplete_upload_never_publishes_archive_or_receipt(self):
        connection = socket.create_connection(("127.0.0.1", self.httpd.server_port))
        connection.sendall(b"POST /artoo/snapshot HTTP/1.1\r\nHost: test\r\n"
                           b"Authorization: Bearer artoo-test\r\n"
                           b"Content-Type: application/gzip\r\nContent-Length: 50\r\n\r\nshort")
        connection.shutdown(socket.SHUT_WR)
        response = http.client.HTTPResponse(connection)
        response.begin()
        self.assertEqual(response.status, 400)
        response.read()
        response.close()
        connection.close()
        # server_close waits for the handler's finally/cleanup.
        self.httpd.shutdown()
        self.httpd.server_close()
        self.assertEqual(list(self.root.rglob("snapshot.tar.gz")), [])
        self.assertEqual(list(self.root.rglob("receipt.json")), [])
        self.assertEqual(list(self.root.rglob(".upload-*")), [])

    def test_body_boundaries_reject_before_storage(self):
        base = {"Authorization": "Bearer artoo-test", "Content-Type": "application/gzip"}
        for extra, expected in [
            ({"Content-Length": "bad"}, 411),
            ({"Content-Length": "0"}, 400),
            ({"Content-Length": str(server.ARTOO_MAX_BODY + 1)}, 413),
            ({"Transfer-Encoding": "chunked"}, 400),
            ({"Content-Type": "application/json"}, 415),
        ]:
            with self.subTest(extra=extra):
                self.assertEqual(self.post(headers=base | extra)[0], expected)
        self.assertFalse((self.root / "data").exists())


if __name__ == "__main__":
    unittest.main()
