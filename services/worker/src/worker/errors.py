"""Two kinds of failure, which decide what Pub/Sub does with the message."""


class RetryableError(Exception):
    """Temporary (Gemini 429/5xx after backoff, storage hiccup). HTTP 503, so Pub/Sub retries;
    after 5 attempts the message goes to content.raw.dlq."""


class PermanentError(Exception):
    """Will never succeed on retry (unreadable file, model JSON invalid twice, no text).
    The document is marked failed and the message is acknowledged."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
