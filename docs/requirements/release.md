# Release

Requirements layer. The design is in [../design/release.md](../design/release.md).

User: developer. The roles are defined in [README.md](README.md#roles). The install of a version by the operator is in [deployment.md](deployment.md).

## Goal

Each finished round of work reaches the running service the same day, in 1 step, and nothing broken ships.

## Use cases

1. Check all the code before a commit, fast.
2. Release and install a new version with 1 command, from the `build` branch.
3. See in the deploy log what each release shipped, and the proof that it runs.
4. Work in a separate worktree, and ship from the main checkout.

## Requirements

| Name             | Contract                                                                                                                                                                                  | Proof today                                                                                                                                     | Gap                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| One-command ship | 1 command does a full release, in this order: check the code, set the version, copy each wiki that changes format, install, start, prove that the new version runs, write the deploy log. | The requirement test. | The test uses a fake for each step. Only the deploy log of each real ship proves the real run. |
| Ship guards | The ship command refuses a tree with changes that are not committed, and a branch other than `build`. | The requirement test. | None |
| Stop on failure | The ship stops at a failed check before the version changes, and writes no log entry when the deploy fails. | The requirement test. | None |
| Honest log | When the proof fails, the log entry records the failure, and the ship fails. | The requirement test. | None |
| Release tag only | The deploy command alone refuses a checkout that is not a release tag. | The requirement test. | None |

## Future

None.
