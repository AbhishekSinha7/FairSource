-- FairSource usage ledger (schema version 2)
-- Source of truth for money. Append-only; every query de-duplicates on event_id.
-- v2 adds document_version, so each row names the exact text that was served.

CREATE TABLE IF NOT EXISTS ledger.usage_events (
  event_id STRING NOT NULL,          -- UUID from the api service; dedup key
  ts TIMESTAMP NOT NULL,
  buyer_id STRING NOT NULL,
  api_key_prefix STRING,
  endpoint STRING,                   -- search | answer | document | mcp
  publisher_id STRING NOT NULL,
  document_id STRING NOT NULL,       -- stable docId (sha256 of canonical URL)
  document_version INT64,            -- v2: version of the document at time of use
  chunk_ids ARRAY<STRING>,           -- {docId}_v{version}_{n}
  licence_id STRING,
  licence_version INT64,
  tokens_served INT64,
  amount_micros INT64,               -- price at time of use, in USD micros
  request_id STRING
)
PARTITION BY DATE(ts)
CLUSTER BY publisher_id, buyer_id;

-- If the v1 table already exists, add the column instead (non-breaking):
-- ALTER TABLE ledger.usage_events ADD COLUMN IF NOT EXISTS document_version INT64;

CREATE TABLE IF NOT EXISTS ledger.earnings_daily (
  publisher_id STRING NOT NULL,
  day DATE NOT NULL,
  tokens INT64,
  gross_micros INT64
)
PARTITION BY day
CLUSTER BY publisher_id;
