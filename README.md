# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mochiko28/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mochiko28/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies the edits AI models write (unified diffs with drifted line numbers, SEARCH/REPLACE blocks, V4A
patches and JSON text-editor calls) to a tree of files, all or nothing, matching lines exactly, then ignoring
trailing whitespace, then ignoring indentation (re-indenting the new lines). `SPEC.md` is the contract.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
node check.ts ../kit/program/generator/practice.json   # the public practice checks
```

`runner.ts` is the kit's trial runner, kept as handed out.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
