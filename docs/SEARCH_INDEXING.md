# Search Indexing

Search records are stored in PostgreSQL as the source of truth and projected to the Elasticsearch `posts` index. Only `title` and `content` are searchable. The authenticated user owns records created through `POST /search/index`; visibility is `private` by default and can be set to `public`. Private matches are visible only to their owner.

`POST /search/:id/revoke` and `DELETE /search/:id` are owner-scoped. Both update PostgreSQL before removing the Elasticsearch document. Search results are always rechecked against PostgreSQL for ownership, visibility, revocation, and soft deletion, so delayed or stale Elasticsearch documents cannot disclose records.

The hourly search-index repair deletes and rebuilds the index from active PostgreSQL records. Run the TypeORM migration `CreateSearchRecords1790985600000` before deploying the updated API. The scheduled rebuild also restores missing documents and removes orphaned documents; no Elasticsearch snapshot migration is needed.
