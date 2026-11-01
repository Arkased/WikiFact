# Release

Design layer. The requirements are in [../requirements/release.md](../requirements/release.md). The technical details are in [../technical/release.md](../technical/release.md).

## Approach

1 command, the ship command, takes a finished round of work from the `build` branch to the running service. It checks the code, makes a release, copies the wikis at risk, deploys, proves that the new version runs, and writes the deploy log. A round of work is 1 ship, so each round reaches the service on the same day.

The work itself happens on a branch in a separate worktree. The developer merges the branch into `build` and ships from the checkout that holds `build`.

The deploy command of the operator is a step of the ship. It is in [deployment.md](deployment.md).

## How the design meets each requirement

### One-command ship

The ship command does these steps in this order:

1. It runs the check of the code once: the type check, lint, the format check, the requirement check, the unit tests and the browser test.
2. It sets the new version, makes the release tag, and moves `main` forward to it.
3. It copies each wiki whose stored format is older than the format of the code. The copy is read-only. The service migrates a wiki when it opens it, so the copy is the way back.
4. It runs the deploy steps, with 1 build. The pack builds, so nothing builds twice.
5. It proves that the new version runs: the port answers, the console names the new version, and each wiki reports the format of the code.
6. It writes the deploy log entry and commits it on `build`.

The developer gives the kind of version step: patch, minor or major.

### Ship guards

Before any step, the ship command refuses:

- a tree with changes that are not committed,
- a branch other than `build`.

A tree with changes would ship code that no commit holds. `build` is the branch that collects the finished rounds.

### Stop on failure

The check of the code is the first step, before the version changes. A failed check stops the ship, so no version and no tag exist for broken code.

The deploy log entry is the last step. A failed deploy stops the ship before that step, so it writes no entry.

### Honest log

The ship writes the entry after the proof, with the result of each part of the proof. When a part fails, the entry records the failure, and the ship commits the entry and then fails. So the log never shows a version that did not run as a success.

The proof matches the version as a whole word. A short version does not match inside a longer one.

The first ship, v0.1.19, lost the version string. Its log entry and its console proof were empty. So the release now captures the tag and checks its form before it goes on.

### Release tag only

The deploy command stays for a redeploy of a release. It refuses a checkout that is not a release tag. So the deploy command installs only a version that a ship released.

## The deploy log

The deploy log has 1 entry for each ship that reached the machine. An entry holds:

- the version and the time in UTC,
- the subjects of the commits since the last release,
- the lines of the deploy: the task, the stop, the start, the port, the endpoint and the install,
- the line of the service log that says the service listens,
- the result of each part of the proof,
- the copies of the wikis, or a line that no copy was necessary.

An entry holds no local path. The install line names the package and its version, and a copy path is relative to the wikis folder. The change process requires the entry for each change to the service, the deploy or the launcher, and the review checks it.

## Decisions

| Decision                                                                 | Reason                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1 command does the whole release and deploy.                             | Each round reaches the service on the same day, and no step is forgotten.                                    |
| 1 finished round of work is 1 ship.                                       | A round does not wait on a branch.                                                                            |
| The check runs first, before the version changes.                         | Broken code gets no version and no tag.                                                                       |
| The ship copies a wiki before its format changes.                         | The service migrates a wiki when it opens it. The copy is the way back.                                       |
| The ship builds once.                                                      | The pack builds. A second build costs time and adds nothing.                                                  |
| The ship writes the deploy log itself, with the proof.                     | A change to the service is proved on the machine, and the log is the record of that proof.                     |
| A failed proof is written to the log, and then the ship fails.             | The log records each ship that reached the machine, and a failure is part of that record.                     |
| The release checks the form of the tag, and the proof matches the whole version. | The first ship lost the version string and logged an empty proof.                                        |
| The deploy log holds no local path.                                       | The log is committed to the repo.                                                                                        |
| The deploy command alone takes only a release tag.                        | A redeploy installs a version that a ship released.                                                            |

## Open points

- Honest log: settled: [Ship a release](../technical/release.md#ship-a-release) now says that a failed proof writes an entry and then fails, as the requirement and the ship command do.
- Ship from the main checkout: the sources say that the work is done on a branch of a worktree, merged into `build`, and shipped. They do not name the checkout that ships. The ship guard requires the branch `build` only.
