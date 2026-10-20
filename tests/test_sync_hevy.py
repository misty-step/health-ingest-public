import json, sys, tempfile, threading, unittest, urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import sync_hevy as h

KEY = "11111111-2222-3333-4444-555555555555"


class Stub(BaseHTTPRequestHandler):
    seen = []       # (method, path?query, api-key)
    workouts = []
    events = []
    redirect = False

    def log_message(self, *a): pass

    def _serve(self):
        u = h.urllib.parse.urlparse(self.path)
        q = h.urllib.parse.parse_qs(u.query)
        Stub.seen.append((self.command, self.path, self.headers.get("api-key")))
        if Stub.redirect:
            self.send_response(302); self.send_header("Location", "http://127.0.0.1:1/x"); self.end_headers(); return
        src = Stub.workouts if u.path == "/v1/workouts" else Stub.events
        size, page = int(q["pageSize"][0]), int(q["page"][0])
        body = {"page": page, "page_count": max(1, -(-len(src) // size)),
                ("workouts" if u.path == "/v1/workouts" else "events"): src[(page - 1) * size: page * size]}
        raw = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    do_GET = do_POST = do_PUT = do_DELETE = _serve


class HevyTests(unittest.TestCase):
    def setUp(self):
        Stub.seen, Stub.redirect = [], False
        Stub.workouts = [{"id": f"w{i}"} for i in range(23)]
        Stub.events = [{"type": "updated", "workout": {"id": "w1"}}, {"type": "deleted", "id": "w2"}]
        self.srv = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.client = h.HevyClient(KEY, f"http://127.0.0.1:{self.srv.server_port}")
        self.tmp = Path(tempfile.mkdtemp()); self.state = self.tmp / "s" / "hevy.json"
        self.posts = []

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()

    def test_backfill_gets_every_workout_across_pages_and_sets_cursor(self):
        n = h.backfill(self.client, self.posts.append, self.state)
        self.assertEqual(n, 23)
        ids = [w["id"] for p in self.posts for w in p["workouts"]]
        self.assertEqual(ids, [f"w{i}" for i in range(23)])
        self.assertEqual(len(self.posts), 3)
        self.assertIn("since", json.loads(self.state.read_text()))

    def test_only_get_with_key_header_and_page_size_cap(self):
        h.backfill(self.client, self.posts.append, self.state)
        self.assertTrue(all(m == "GET" and k == KEY for m, _, k in Stub.seen))
        self.assertTrue(all("pageSize=10" in p for _, p, _ in Stub.seen))

    def test_write_paths_and_other_endpoints_are_unreachable(self):
        for path in ["/v1/workouts/abc", "/v1/routines", "/v1/body_measurements", "/v1/workouts/../routines"]:
            with self.assertRaises(h.ReadOnlyViolation):
                self.client.get(path)
        self.assertEqual(Stub.seen, [])
        self.assertFalse(any(hasattr(self.client, m) for m in ("post", "put", "delete", "request")))

    def test_redirect_is_not_followed(self):
        Stub.redirect = True
        with self.assertRaises(urllib.error.HTTPError):
            self.client.get("/v1/workouts", {"page": 1, "pageSize": 10})
        self.assertEqual(len(Stub.seen), 1)

    def test_poll_requires_backfill_cursor(self):
        with self.assertRaises(SystemExit):
            h.poll(self.client, self.posts.append, self.state)
        self.assertEqual(Stub.seen, [])

    def test_poll_posts_events_since_cursor_and_advances(self):
        h.write_state(self.state, {"since": "2026-01-01T00:00:00Z"})
        n = h.poll(self.client, self.posts.append, self.state)
        self.assertEqual(n, 2)
        self.assertIn("since=2026-01-01T00%3A00%3A00Z", Stub.seen[0][1])
        self.assertEqual(self.posts[0]["events"][1], {"type": "deleted", "id": "w2"})
        self.assertNotEqual(json.loads(self.state.read_text())["since"], "2026-01-01T00:00:00Z")

    def test_failed_post_does_not_advance_cursor(self):
        h.write_state(self.state, {"since": "2026-01-01T00:00:00Z"})
        def boom(_): raise urllib.error.URLError("ingest down")
        with self.assertRaises(urllib.error.URLError):
            h.poll(self.client, boom, self.state)
        self.assertEqual(json.loads(self.state.read_text())["since"], "2026-01-01T00:00:00Z")

    def test_empty_poll_posts_nothing_but_advances(self):
        Stub.events = []
        h.write_state(self.state, {"since": "2026-01-01T00:00:00Z"})
        self.assertEqual(h.poll(self.client, self.posts.append, self.state), 0)
        self.assertEqual(self.posts, [])


if __name__ == "__main__":
    unittest.main()
