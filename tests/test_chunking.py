from alphabook.chunking import chunk_text


def test_chunk_text_creates_multiple_chunks_with_overlap():
    paragraph = "This is a paragraph about knights and windmills. " * 12
    text = "\n\n".join([paragraph for _ in range(6)])
    chunks = chunk_text(text, target_chars=420, overlap_chars=120)

    assert len(chunks) >= 2
    assert chunks[0].start_char == 0
    assert chunks[1].start_char < chunks[0].end_char
    assert chunks[0].chunk_index == 0
