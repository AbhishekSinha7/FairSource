# Evaluation sets

- `golden/`: 50 articles (Marathi, Hindi, English, 10 scans) with expected title, language and body. CI fails if field accuracy drops below 95% or OCR character error rate rises above 5%.
- `retrieval.jsonl`: 30 queries with known correct document IDs, including Hindi query → Marathi article pairs. Tracks recall@5.
- `sync/`: one fixture blog with an edited post and a deleted post, to check that the edit becomes version 2 and the deletion is withdrawn.

Only openly licensed or public-domain content goes here. Record each item's licence in `SOURCES.md`.
