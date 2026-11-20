from worker.textutil import (
    bands,
    detect_script,
    estimate_tokens,
    guess_language,
    hamming,
    language_agrees,
    personal_data_count,
    plan_chunks,
    simhash64,
)

MR = "पुणे शहरात नवीन मेट्रो मार्गाचे काम अंतिम टप्प्यात आहे आणि अधिकाऱ्यांनी सांगितले की हा मार्ग पुढील वर्षी सुरू होईल. नागरिकांच्या प्रवासाचा वेळ कमी होईल, असे त्या म्हणाल्या."
HI = "पुणे शहर में नई मेट्रो लाइन का काम अंतिम चरण में है और अधिकारियों ने कहा कि यह मार्ग अगले साल शुरू होगा. नागरिकों के यात्रा का समय कम होगा, यह भी कहा गया."
EN = "The new metro line in Pune is in its final stage and officials said that the route will open next year, cutting the travel time of commuters."


def test_script_and_language():
    assert detect_script(MR) == "Deva"
    assert detect_script(EN) == "Latn"
    assert guess_language(MR) == "mr"
    assert guess_language(HI) == "hi"
    assert guess_language(EN) == "en"
    assert guess_language("नमस्ते") is None  # not enough evidence: no opinion


def test_language_check_catches_contradictions_only():
    assert language_agrees(MR, "mr", "Deva")
    assert not language_agrees(MR, "hi", "Deva")  # Gemini said Hindi, text is clearly Marathi
    assert not language_agrees(EN, "mr", "Deva")  # script mismatch
    assert language_agrees("Bonjour à tous, voici les nouvelles.", "fr", "Latn")  # no local opinion on French


def test_token_estimate_is_reasonable():
    assert 25 <= estimate_tokens(EN) <= 45
    assert estimate_tokens("") == 0


def test_simhash_near_duplicates_share_bands():
    a = (MR + " ") * 5
    b = a.replace("पुढील वर्षी", "पुढच्या वर्षी", 1)
    c = (HI + " ") * 5
    ha, hb, hc = simhash64(a), simhash64(b), simhash64(c)
    assert hamming(ha, hb) <= 8
    assert hamming(ha, hc) > 12
    assert len(bands(ha)) == 4 and all(0 <= x < 65536 for x in bands(ha))


def test_chunks_respect_size_overlap_and_title():
    paragraphs = [f"{EN} Paragraph {i}." for i in range(40)]
    plans = plan_chunks("Pune metro", "\n\n".join(paragraphs), 400, 600, 60)
    assert len(plans) >= 3
    for p in plans:
        assert p.text.startswith("Pune metro\n")
        assert p.estimated_tokens <= 600 * 1.15
    # consecutive chunks overlap
    tail_words = plans[0].text.split()[-5:]
    assert " ".join(tail_words) in plans[1].text
    # nothing is lost
    joined = " ".join(p.text for p in plans)
    for i in range(40):
        assert f"Paragraph {i}." in joined


def test_long_devanagari_paragraph_is_split_on_danda():
    para = "।".join([MR.replace(".", "")] * 30) + "।"
    plans = plan_chunks("मेट्रो", para, 400, 600, 60)
    assert len(plans) >= 2
    assert all(p.estimated_tokens <= 690 for p in plans)


def test_short_text_is_one_chunk():
    plans = plan_chunks("Title", EN, 400, 600, 60)
    assert len(plans) == 1 and EN in plans[0].text


def test_personal_data_count():
    text = "राहुल 9876543210, सीमा +91 9123456780, amit@example.com, 2026 मध्ये"
    assert personal_data_count(text) == 3
