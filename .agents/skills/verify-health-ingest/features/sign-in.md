# Sign-in

The Cloudflare Worker trusts no caller on its own. Cloudflare Access signs each request, and the Worker re-checks the signed assertion's issuer, audience and time. It then admits only the exact owner email in `ACCESS_HUMAN_EMAILS` or a client ID pinned in `ACCESS_MACHINES`. The owner signs in through Access and gets a session; every Worker route is owner- or machine-only. Here the edge is a local emulation, the owner is the fictional `fictional-owner@example.invalid`, and the end state is an owner session cookie plus the Worker's private `/healthz` JSON with this checkout's revision.

## Sub-features

- `owner-session` signs the owner in and lands on `/healthz` with Worker JSON, `revision: verify-<sha>`.
- `signed-out` gives anonymous requests a `302` to `/cdn-cgi/access/login` with no Worker body.
- `wrong-identity` gives a signed-in stranger email `403 {"error":"forbidden"}` from the Worker.
- `expired-session` sends a session past its expiry back to login at the edge.
- `logout` makes the next request redirect to login.
- `origin-checks` has the Worker itself refuse, at the bare origin, assertions that are correctly signed but expired, from the wrong issuer, for the wrong audience, or issued in the future. A valid owner or pinned-machine assertion passes. A forged unsigned one is refused.
- `assertion-stripped` has the edge drop a client-supplied `Cf-Access-Jwt-Assertion`, even a valid one, so only Access-minted assertions reach the Worker.
- `unpinned-machine` gets 403 from the Worker for a token the edge accepts but `ACCESS_MACHINES` does not pin. A wrong token secret is redirected by the edge.
- `poller-scope` gets 403 when the poll-only identity reads health.

## How to get to it (user POV)

- The owner opens the Worker host in a browser. Access redirects to its login, and after sign-in the requested path renders.
- Machines send `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request.
- Locally: `$EDGE_URL` is the edge, `$EDGE_URL/cdn-cgi/access/login?email=<e>&redirect_url=/healthz` signs in as `<e>`, and `$ORIGIN_URL` is the bare Worker with no edge.

## Driving it with curl

Preconditions:

- `hevy` and `edge` are up and `$V doctor` passes. `$J` is this run's owner cookie jar; start with `rm -f "$J"`.

- **Signed out.** Run `$V rec signin-signed-out -- curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "$EDGE_URL/healthz"`. It prints `302 http://127.0.0.1:<port>/cdn-cgi/access/login?redirect_url=%2Fhealthz`.
- **Owner signs in.** Run `$V rec signin-owner -- curl -sS -L -c "$J" -b "$J" -w '\n%{http_code} %{url_effective}\n' "$EDGE_URL/cdn-cgi/access/login?email=$OWNER_EMAIL&redirect_url=%2Fhealthz"`. The final URL is `/healthz` and the body is Worker JSON with `"revision":"$RELEASE"`. Status is `503` with `hevy_never_polled` before any poll, or `200` after a fresh poll. Both prove an owner session; a 403 or a redirect does not.
- **Session persists.** Run `$V rec signin-owner-session -- curl -sS -b "$J" -w '\n%{http_code}\n' "$EDGE_URL/healthz"`. It returns the same JSON without logging in again, and `grep -c CF_Authorization "$J"` prints `1`.
- **Wrong identity.** Run `curl -sS -o /dev/null -c "$J.stranger" "$EDGE_URL/cdn-cgi/access/login?email=$STRANGER_EMAIL"`, then GET `/healthz` with `-b "$J.stranger"` as `signin-wrong-identity`. The status is `403` and the body is `{"error":"forbidden"}`.
- **Expired session.** Sign in with `&ttl=-60` into `$J.expired`, then GET `/healthz` with it as `signin-expired`. The status is `302` to `/cdn-cgi/access/login`.
- **Logout.** Run `cp "$J" "$J.keep"`, then GET `$EDGE_URL/cdn-cgi/access/logout` with `-b "$J" -c "$J"`, then `/healthz` with `-b "$J"` as `signin-logout`. The status is `302` to login. `$J.keep` is still signed in for [cloudflare-ingest.md](./cloudflare-ingest.md).
- **Worker's own checks.** Send correctly signed assertions straight to the Worker. Each is `curl -sS -w '\n%{http_code}\n' -H "Cf-Access-Jwt-Assertion: $($V assertion <flags>)" "$ORIGIN_URL/healthz"`:
  - `signin-origin-owner`: `--email "$OWNER_EMAIL"` gives Worker JSON with `$RELEASE`.
  - `signin-origin-machine`: `--client-id "$WRITER_ID"` gives Worker JSON.
  - `signin-origin-expired`: `--email "$OWNER_EMAIL" --ttl -60` gives `403 {"error":"forbidden"}`.
  - `signin-origin-issuer`: `--email "$OWNER_EMAIL" --issuer https://wrong.cloudflareaccess.com` gives `403`.
  - `signin-origin-audience`: `--email "$OWNER_EMAIL" --audience wrong` gives `403`.
  - `signin-origin-future`: `--email "$OWNER_EMAIL" --iat-offset 300` gives `403`.
  - `signin-origin-stranger`: `--email "$STRANGER_EMAIL"` gives `403`.
  - `signin-origin-forged`: the literal unsigned `eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImZpY3Rpb25hbC1vd25lckBleGFtcGxlLmludmFsaWQifQ.` gives `403`.
- **Assertion stripped at the edge.** Send the poller's token together with an owner assertion the origin accepts: `$V rec signin-edge-strips -- sh -c 'curl -sS -w "\n%{http_code}\n" -K "$POLLER_CURL" -H "Cf-Access-Jwt-Assertion: $("$V" assertion --email "$OWNER_EMAIL")" "$EDGE_URL/healthz"'`. It gives `403 {"error":"forbidden"}`, the poller's answer. Had the owner assertion survived, it would be the owner's Worker JSON, so the edge replaced the client's assertion with its own.
- **Machine identities.** Record GET `/healthz` with:
  - `-K "$UNPINNED_CURL"` as `signin-unpinned`: `403`.
  - `-H "CF-Access-Client-Id: $WRITER_ID" -H "CF-Access-Client-Secret: wrong"` as `signin-bad-secret`: `302` to login.
  - `-K "$POLLER_CURL"` as `signin-poller-health`: `403`.
  - `-K "$WRITER_CURL"` as `signin-writer-health`: Worker JSON with `$RELEASE`.

## Gotchas

- This is an emulation, not Cloudflare Access. The local login accepts any email, and session expiry is enforced by the edge, as Access does. The Worker's own identity, issuer, audience and time checks are proven only by the `signin-origin-*` steps, so do not drop them.
- `$V assertion` signs with the run's edge key, which the Worker trusts through the emulated JWKS. It is a verification tool for the origin port only. Nothing it prints is valid anywhere else.
- Signing keys are generated per run and kept in `<run>/edge/signing-key.json`, so sessions survive an edge restart within one run but never across runs. `verify down` deletes the keys.
- `/healthz` answering `503 hevy_never_polled` or `hevy_stale` is a signed-in success, because the body comes from the Worker. Only `200`/`503` with `revision` proves the session; `302` and `403` do not.
