# Working-release protection tests

Reference: application **0.10.23**, extension **0.5.13**. This change adds tests and a test runner only. No production source, installer, dependency, version or user settings change is required.

## Run

```powershell
node scripts/protection-check.js
node scripts/protection-check.js --full
```

The focused run combines the new adversarial tests with existing quality, session, grouping, queue, HLS and recovery checks. `--full` runs all Node tests. Both record SHA-256 snapshots of `src/`, `public/`, `extension/`, `desktop/`, `package.json` and `package-lock.json` before and after execution, and fail if those files changed during the run. Reports and TAP output go to a fresh `hypernab-protection-report-*` folder under the approved temporary directory. A snapshot is a guard against changes during the run, not proof of equivalence to an older release.

## Additional coverage

- Six file formats, two player frames, 24 fixed shuffles each: 288 request-order scenarios. Twelve untyped requests and four unrelated stream hosts compete with the actual player resource.
- 24 same-path/different-signature cases and 24 multiple-player orderings. Signed URLs must be preserved; actual offered qualities are not invented or silently substituted.
- Range-limited and blob-backed resources must not become unverified direct downloads. DRM evidence stops requests. Foreign senders cannot request inspection or diagnostics.
- Cache separation by source kind, engine instance, cookie store, explicit cookie action and expiry; concurrent identical requests coalesce. Synthetic cookie values must not enter extension storage or diagnostic reports.
- All 64 ordered pairs of eight transient HTTP statuses; access refusal after a transient response; cancellation at either retry; non-HLS bodies after a successful HTTP response.
- One/two/four/eight parallel connections with a one-off reset, 503 or truncated body; exact output byte comparison before publication. Pause/retry preserves unpublished work and publishes only after validation.
- Two negative controls deliberately reintroduce known bugs **in VM memory only**: UNKNOWN-first ranking and missing source-kind cache isolation. The same behavior checks must reject these broken variants. No source files are changed by these controls.

## Isolation and limits

New tests load the real extension scripts in fresh VM contexts against synthetic browser/app APIs. They do not inspect the user's real browser or cookies and do not call an actual engine on port 17846. Transfer fixtures use separate temporary files and fake HTTP responses; those checks prove byte invariants, not playback of arbitrary real-site videos. Existing real-socket/FFmpeg smoke remains `node scripts/recovery-smoke.js`; the isolated real-browser noisy-page smoke remains `HD_FLOAT_NOISE=1` with `scripts/float-e2e.js`.

This is an on-demand development check, not a continuous monitor or an automatic release/deployment system. Passing is not a guarantee for every site, every multi-player intent, DRM, one-time URL, browser version or low-end PC. Fixed seeds make regressions reproducible; add a minimized test when a genuinely new failure is observed. Production fixes still require a concrete reproduced failure plus a full regression run; passing tests alone are not a reason to change working download behavior or ship another installer.
