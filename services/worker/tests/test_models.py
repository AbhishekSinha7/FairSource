from worker.models import ContentRawMessage, chunk_id_for


def test_chunk_id_matches_typescript():
    # Same rule as chunkIdFor in packages/shared/src/schema.ts
    assert chunk_id_for("6fdcdf13dab4fd7a4bb858edd6684fd2", 2, 3) == "6fdcdf13dab4fd7a4bb858edd6684fd2_v2_3"


def test_content_raw_v2_parses():
    msg = ContentRawMessage.model_validate(
        {
            "schemaVersion": 2,
            "docId": "6fdcdf13dab4fd7a4bb858edd6684fd2",
            "identityKey": "url:https://example.in/article/1",
            "contentHash": "ab" * 32,
            "publisherId": "pub_123",
            "sourceId": "src_456",
            "rawUri": "gs://fs-dev-raw/pub_123/2026/11/x.html",
            "mimeType": "text/html",
            "sourceUrl": "https://example.in/article/1",
            "sourceModifiedAt": "2026-11-20T09:58:00Z",
            "reason": "changed",
            "fetchedAt": "2026-11-20T10:15:00Z",
        }
    )
    assert msg.reason == "changed"
