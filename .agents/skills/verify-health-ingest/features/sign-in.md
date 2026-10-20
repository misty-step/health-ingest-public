# Sign-in

The Cloudflare Worker trusts no caller on its own. Cloudflare Access signs each request, and the Worker re-checks the signed assertion's issuer, audience and time. It then admits only the exact owner email in `ACCESS_HUMAN_EMAILS` or a client ID pinned in `ACCESS_MACHINES`. The owner signs in through Access and gets a session; every Worker route is owner- or machine-only. Here the edge is a local emulation, the owner is the fictional `fictional-owner@example.invalid`, and the end state is an owner session cookie plus the Worker's private `/healthz` JSON with this checkout's revision.

## Sub-features

- `owner-session` signs the owner in and lands on `/healthz` with Worker JSON, `revision: verify-<sha>`.
- `signed-out` gives anonymous requests a `302` to `/cdn-cgi/access/login` with no Worker body.
- `wrong-identity` gives a signed-in stranger email `403 {"error":"forbidden"}` from the Worker.
- `expired-session` sends a session past its expiry back to login.
- `logout` makes the next request redirect to login.
- `forged-assertion` has the edge strip a client-supplied `Cf-Access-Jwt-Assertion`, and the Worker origin refuse a forged one sent directly with 403.
- `unpinned-machine` gets 403 from the Worker for a token the edge accepts but `ACCESS_MACHINES` does not pin. A wrong token secret is redirected by the edge.
- `poller-scope` gets 403 when the poll-only identity reads health.

## How to get to it (user POV)

- The owner opens the Worker host in a browser. Access redirects to its login, and after sign-in the requested path renders.
- Machines send `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request.
- Locally: `$EDGE_URL` is the edge, `$EDGE_URL/cdn-cgi/access/login?email=<e>&redirect_url=/healthz` signs in as `<e>`, and `$ORIGIN_URL` is the bare Worker with no edge.

## Driving it with curl

Preconditions:

- `hevy` and `edge` are up and `$V doctor` passes. Use a fresh cookie jar: `J=$VERIFY_RUN/owner.jar; rm -f "$J"`.

- **Signed out.** Run `$V rec signin-signed-out -- curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "$EDGE_URL/healthz"`. It prints `302 http://127.0.0.1:<port>/cdn-cgi/access/login?redirect_url=%2Fhealthz`.
- **Owner signs in.** Run `$V rec signin-owner -- curl -sS -L -c "$J" -b "$J" -w '\n%{http_code} %{url_effective}\n' "$EDGE_URL/cdn-cgi/access/login?email=$OWNER_EMAIL&redirect_url=%2Fhealthz"`. The final URL is `/healthz` and the body is Worker JSON with `"revision":"$RELEASE"`. Status is `503` with `hevy_never_polled` before any poll, or `200` after a fresh poll. Both prove an owner session; a 403 or a redirect does not.
- **Session persists.** Run `$V rec signin-owner-session -- curl -sS -b "$J" -w '\n%{http_code}\n' "$EDGE_URL/healthz"`. It returns the same JSON without logging in again, and `grep CF_Authorization "$J"` shows the cookie.
- **Wrong identity.** Sign in with `email=$STRANGER_EMAIL` into a second jar, then GET `/healthz` with it as `signin-wrong-identity`. The status is `403` and the body is `{"error":"forbidden"}`.
- **Expired session.** Sign in with `&ttl=-60` into a third jar, then GET `/healthz` as `signin-expired`. The status is `302` to `/cdn-cgi/access/login`.
- **Logout.** GET `$EDGE_URL/cdn-cgi/access/logout` with `-b "$J" -c "$J"`, then `/healthz` with the jar as `signin-logout`. The status is `302` to login.
- **Forged assertion.** Run `curl -sS -w '\n%{http_code}\n' -H 'Cf-Access-Jwt-Assertion: forged' "$EDGE_URL/healthz"` as `signin-forged-edge`, which gives `302` because the edge strips it. Then send a hand-made assertion straight to the Worker as `signin-forged-origin`: `curl -sS -w '\n%{http_code}\n' -H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImZpY3Rpb25hbC1vd25lckBleGFtcGxlLmludmFsaWQifQ.' "$ORIGIN_URL/healthz"`. That gives `403 {"error":"forbidden"}`.
- **Machine identities.** Record GET `/healthz` with:
  - `-H "CF-Access-Client-Id: $UNPINNED_ID" -H "CF-Access-Client-Secret: $UNPINNED_SECRET"` as `signin-unpinned`: `403`.
  - the writer ID with secret `wrong` as `signin-bad-secret`: `302` to login.
  - `$POLLER_ID`/`$POLLER_SECRET` as `signin-poller-health`: `403`.
  - `$WRITER_ID`/`$WRITER_SECRET` as `signin-writer-health`: Worker JSON with `$RELEASE`.

## Gotchas

- This is an emulation, not Cloudflare Access. The local login accepts any email; the real Access policy would refuse a stranger before the Worker. Here the Worker's own pin is what refuses the stranger, which is the origin check this feature exists to prove.
- The real owner, phaedrus, signs in to the deployed Worker through Access and the Misty Step password IdP. That journey, and whether it is proven, belong to the private repo's `verify-health-ingest` skill, not to this one.
- Signing keys are generated per run and kept in `<run>/edge/signing-key.json`, so sessions survive an edge restart within one run but never across runs. `verify down` deletes the keys.
- `/healthz` answering `503 hevy_never_polled` or `hevy_stale` is a signed-in success: the body comes from the Worker. Only `200`/`503` with `revision` proves the session; `302` and `403` do not.
