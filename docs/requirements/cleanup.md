# Cleanup

Requirements layer. The design is in [../design/cleanup.md](../design/cleanup.md).

User: none directly. The worker does this between 2 requests when a check is due. The operator can start it at once. The roles are defined in [README.md](README.md#roles).

## Goal

The wiki holds 1 live fact for each claim. A submission waits at most for 1 run of a check and its repairs, 1 time in each interval.

## Use cases

1. Merge 2 live facts that state the same thing. A batch of the high volume mode can leave them, and the requirement "High volume mode" ([updates.md](updates.md)) asks for a later check that merges them.

## Requirements

| Name                 | Contract                                                                                                      | Proof today           | Gap                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------- |
| Free for submissions | A due check runs after the current request ends, also when the queue is not empty. Its repairs run at once after it, before the next submission. The interval alone decides when a check is due. So a submission waits at most for 1 run of a check and its repairs (at most 20 repairs, about 1.5 to 4 minutes), 1 time in each interval. | The requirement test. | None |
| Interval             | The check runs after a number of writes. The number follows the repairs of the last run: no repair lengthens it, 3 or more shorten it, within a floor and a ceiling. | The requirement test. | None |
| Cap                  | A run queues at most a set number of repairs.                                                                  | The requirement test. | None |
| No repeat check      | A pair of facts that the check found distinct is not checked again until the header or the content of 1 of the facts changes. | The requirement test. | None |
| Operator start       | The operator can start a cleanup run at once from the console.                                                 | The requirement test. | None |
| Old repair rejected  | A queued repair of a check that the cleanup no longer has ends rejected as unsupported, with no write and no question. | The requirement test. | None. Met. Test: `Old repair rejected` in `__tests__/requirements/cleanup.test.ts`. |
| Store migrated       | A store of the previous schema opens migrated: the migration drops the tables of the removed feature and keeps every other row, and a duplicate-fact merge works on the migrated store. | The requirement test. | None. Met. Test: `Store migrated` in `__tests__/requirements/cleanup.test.ts`. |

## Future

More checks for facts: facts with 2 claims, and missing references.
