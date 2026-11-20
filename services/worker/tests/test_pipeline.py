import io
from datetime import timedelta

import pytest
from pypdf import PdfWriter

from worker.errors import RetryableError
from worker.models import ContentRawMessage
from worker.pipeline import process
from tests.fakes import T0, Harness, html

DOC = "6fdcdf13dab4fd7a4bb858edd6684fd2"
OTHER = "aaaabbbbccccddddeeeeffff00001111"
MR_PARAS = [
    "हिंजवडी ते शिवाजीनगर या नव्या मेट्रो मार्गाचे काम अंतिम टप्प्यात असल्याचे अधिकाऱ्यांनी सांगितले आहे आणि तो पुढील वर्षी सुरू होईल.",
    "नव्या मार्गामुळे आयटी पार्कमधील कर्मचाऱ्यांच्या प्रवासाचा वेळ कमी होईल, अशी अपेक्षा आहे आणि वाहतूक कोंडी कमी होईल.",
    "या मार्गावर एकूण तेवीस स्थानके असतील आणि बालेवाडी, बाणेर व विद्यापीठ चौक ही प्रमुख स्थानके आहेत असे सांगितले.",
]


def run(h: Harness, msg: dict):
    return process(ContentRawMessage.model_validate(msg), h.deps)


def first_version(h: Harness, doc=DOC, paras=MR_PARAS, url="https://example.in/news/a"):
    h.stub(doc, url)
    return run(h, h.message(doc, html("पुणे शहरात नवीन मेट्रो मार्ग", *paras), url=url))


def test_new_article_is_processed_into_licensed_chunks():
    h = Harness()
    out = first_version(h)
    assert out.status == "processed" and out.version == 1 and out.chunks >= 1

    d = h.store.documents[DOC]
    assert d["status"] == "done" and d["servable"] is True and d["version"] == 1
    assert d["language"] == "mr" and d["script"] == "Deva"
    assert d["title"] == "पुणे शहरात नवीन मेट्रो मार्ग"
    assert d["pendingContentHash"] is None and d["contentHash"]
    assert d["licenceId"] == "lic_1" and d["cleanUri"].startswith("gs://fs-test-clean/pub_1/")

    chunks = h.store.chunks_of(DOC)
    assert [c["id"] for c in chunks] == [f"{DOC}_v1_{n}" for n in range(len(chunks))]
    c0 = chunks[0]
    assert c0["text"].startswith("पुणे शहरात नवीन मेट्रो मार्ग\n")
    assert len(c0["embedding"]) == 768
    assert c0["uses"] == ["rag"] and c0["territories"] == ["IN", "GLOBAL"] and c0["licenceVersion"] == 3
    assert c0["servable"] is True and c0["optOut"] is False

    assert h.store.versions[(DOC, 1)]["chunkCount"] == len(chunks)
    assert h.bus.messages[-1]["status"] == "done" and h.bus.messages[-1]["version"] == 1


def test_redelivery_is_a_no_op():
    h = Harness()
    h.stub(DOC, "https://example.in/news/a")
    msg = h.message(DOC, html("T", *MR_PARAS))
    run(h, msg)
    calls = len(h.ai.calls)
    out = run(h, msg)
    assert out.status == "skipped" and out.reason == "already_processed"
    assert len(h.ai.calls) == calls


def test_an_edit_replaces_chunks_and_records_versions():
    h = Harness()
    first_version(h)
    old_ids = {c["id"] for c in h.store.chunks_of(DOC)}
    edited = MR_PARAS[:2] + ["या मार्गावर आता पंचवीस स्थानके असतील, असे महामेट्रोने सुधारित निवेदनात सांगितले आहे."]
    out = run(h, h.message(DOC, html("पुणे शहरात नवीन मेट्रो मार्ग", *edited)))
    assert out.status == "processed" and out.version == 2
    new = h.store.chunks_of(DOC)
    assert all(c["id"].startswith(f"{DOC}_v2_") for c in new)
    assert not old_ids & {c["id"] for c in new}
    assert "पंचवीस" in " ".join(c["text"] for c in new)
    assert h.store.versions[(DOC, 1)]["supersededAt"] == T0
    assert h.bus.messages[-1]["replacedChunkCount"] == len(old_ids)


def test_page_change_without_article_change_is_not_re_embedded():
    h = Harness()
    first_version(h)
    calls = list(h.ai.calls)
    page = html("पुणे शहरात नवीन मेट्रो मार्ग", *MR_PARAS).replace(b"Home | News", b"Home | News | Sports")
    out = run(h, h.message(DOC, page))
    assert out.status == "unchanged_text" and out.version == 1
    assert not [c for c in h.ai.calls[len(calls):] if c.startswith("embed")]
    d = h.store.documents[DOC]
    assert d["version"] == 1 and d["pendingContentHash"] is None


def test_older_fetch_arriving_late_is_ignored():
    h = Harness()
    first_version(h)
    late = h.message(DOC, html("Old", *MR_PARAS[:1]), fetched_at=T0 - timedelta(hours=1))
    assert run(h, late).reason == "stale"
    assert h.store.documents[DOC]["version"] == 1


def test_withdrawn_document_is_skipped():
    h = Harness()
    h.stub(DOC, "https://example.in/news/a", status="withdrawn")
    assert run(h, h.message(DOC, html("T", *MR_PARAS))).reason == "withdrawn"


def test_republished_copy_is_marked_duplicate():
    h = Harness()
    first_version(h)
    h.ai.same = True
    out = first_version(h, doc=OTHER, url="https://example.in/amp/news/a")
    assert out.status == "processed"
    d = h.store.documents[OTHER]
    assert d["duplicateOf"] == DOC and d["servable"] is False
    assert all(c["servable"] is False for c in h.store.chunks_of(OTHER))


def test_different_article_is_not_asked_about():
    h = Harness()
    first_version(h)
    h.ai.calls.clear()
    first_version(h, doc=OTHER, url="https://example.in/news/b", paras=["कोथरूडमध्ये नवे उद्यान नागरिकांसाठी खुले करण्यात आले आहे आणि तेथे मुलांसाठी खेळाची मैदाने आहेत असे महापालिकेने सांगितले."] * 3)
    assert "same" not in h.ai.calls  # no SimHash band in common, so Gemma isn't called


def test_language_disagreement_needs_review():
    h = Harness()
    h.ai.language = "hi"  # Gemini says Hindi; the text is clearly Marathi
    first_version(h)
    d = h.store.documents[DOC]
    assert d["needsReview"] is True and d["servable"] is False


def test_lists_of_personal_details_are_not_served():
    h = Harness()
    people = [f"कार्यकर्ता {i}: 98765432{i:02d}, पत्ता शनिवार पेठ, पुणे आणि ते मंडळाचे सदस्य आहेत" for i in range(12)]
    first_version(h, paras=people)
    d = h.store.documents[DOC]
    assert d["safety"] == "pii_heavy" and d["servable"] is False
    assert "safety" not in h.ai.calls  # the regex count decided it


def test_unreadable_safety_label_holds_the_article_back():
    h = Harness()
    h.ai.safety = None
    first_version(h)
    assert h.store.documents[DOC]["needsReview"] is True


def test_publisher_opt_out_is_preserved():
    h = Harness()
    h.stub(DOC, "https://example.in/news/a", optOut=True)
    run(h, h.message(DOC, html("T", *MR_PARAS)))
    d = h.store.documents[DOC]
    assert d["optOut"] is True and d["servable"] is False
    assert all(c["optOut"] is True and c["servable"] is False for c in h.store.chunks_of(DOC))


def test_invalid_model_output_fails_new_document_but_keeps_live_version():
    h = Harness()
    h.ai.invalid_clean = True
    h.stub(DOC, "https://example.in/news/a")
    out = run(h, h.message(DOC, html("T", *MR_PARAS)))
    assert out.status == "failed"
    d = h.store.documents[DOC]
    assert d["status"] == "failed" and d["processingError"].startswith("invalid_model_output")

    h2 = Harness()
    first_version(h2)
    h2.ai.invalid_clean = True
    run(h2, h2.message(DOC, html("T", "पूर्णपणे वेगळा सुधारित मजकूर जो प्रक्रियेत अयशस्वी होईल आणि तो जुन्या आवृत्तीची जागा घेणार नाही.")))
    d2 = h2.store.documents[DOC]
    assert d2["status"] == "done" and d2["servable"] is True and d2["version"] == 1
    assert d2["processingError"].startswith("invalid_model_output")
    assert d2["pendingContentHash"]  # kept, so ingest won't resend the same broken content


def test_long_pdf_is_ocrd_in_ten_page_parts():
    h = Harness()
    w = PdfWriter()
    for _ in range(23):
        w.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    w.write(buf)
    h.stub(DOC, "", sourceUrl=None, canonicalUrl=None, identityKey="upload:x", title="जुना अंक 1952")
    out = run(h, h.message(DOC, buf.getvalue(), mime="application/pdf", url=None))
    assert out.status == "processed"
    assert h.ai.calls.count("ocr:application/pdf") == 3


def test_unsupported_and_empty_files_fail_permanently():
    h = Harness()
    h.stub(DOC, "https://example.in/x")
    assert run(h, h.message(DOC, b"\x00\x01", mime="application/octet-stream")).reason == "unsupported_type"
    h.stub(OTHER, "https://example.in/y")
    assert run(h, h.message(OTHER, b"<html><body><nav>menu</nav></body></html>")).reason == "no_text"


def test_missing_stub_is_retried():
    h = Harness()
    msg = h.message(DOC, html("T", *MR_PARAS))
    with pytest.raises(RetryableError):
        run(h, msg)


def test_no_active_licence_means_chunks_carry_no_rights():
    h = Harness()
    h.store.licences.clear()
    first_version(h)
    c = h.store.chunks_of(DOC)[0]
    assert c["uses"] == [] and c["territories"] == [] and c["licenceId"] == ""
