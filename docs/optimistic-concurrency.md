# Optimistic concurrency

Mutable API resources should expose a numeric `version` (or an HTTP `ETag`)
when they are read. Clients must send that value back with an update. The
server compares it with the current record inside the same transaction and
increments it only after a successful write.

A stale update returns `409 Conflict` with the recovery action `refresh`; it
must not overwrite the newer record. The client should fetch the current
representation, show the user the conflicting changes, and retry with the new
version after the user confirms the merge.

`OptimisticConcurrencyService` contains the shared comparison and version
increment rules. Repository-backed workflows should call `assertCurrent` while
holding the update transaction/lock and use `nextVersion` for the persisted
value.
