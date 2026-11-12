# Developer documentation

Start with [`../AGENTS.md`](../AGENTS.md) (overview, repository map, rules). Then:

| File | Read it when |
|---|---|
| [architecture.md](architecture.md) | you need to know how the engine, window, desktop shell, extension and native bridge fit together, and what is stored where |
| [development.md](development.md) | setting up a machine, running from source, deciding which file to change |
| [testing.md](testing.md) | choosing and running the right checks, test hooks, known quirks |
| [protection-tests.md](protection-tests.md) | working on capture ordering, retries or cookie isolation (adversarial unit tests) |
| [release.md](release.md) | publishing the app or uploading the extension |
| [decisions.md](decisions.md) | before changing a behaviour on purpose: decisions, rejected ideas, known limits, open work |
| [design-system.md](design-system.md) | adding or changing a UI control |
| [store-listing.md](store-listing.md) | editing store texts, permission justifications, reviewer notes |

User-facing documents stay in the root: `README.md` / `README.tr.md`, `PRIVACY.md` / `PRIVACY.tr.md`, `THIRD_PARTY_NOTICES.md`. Script-by-script reference: [`../scripts/README.md`](../scripts/README.md).
