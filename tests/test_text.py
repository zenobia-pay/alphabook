from alphabook.text import parse_gutenberg_html, parse_gutenberg_text, strip_project_gutenberg_boilerplate


def test_strip_project_gutenberg_boilerplate():
    raw = """
Header
*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***
Body line one.
Body line two.
*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***
Footer
"""
    stripped = strip_project_gutenberg_boilerplate(raw)
    assert stripped == "Body line one.\nBody line two."


def test_parse_gutenberg_html_extracts_metadata_and_text():
    html = """
<html>
  <head>
    <title>The Project Gutenberg eBook of Sample Book, by Jane Writer.</title>
  </head>
  <body>
    <div id="pg-header">
      <p>Title: Sample Book</p>
      <p>Author: Jane Writer</p>
    </div>
    <h1>Sample Book</h1>
    <p>First paragraph.</p>
    <p>Second paragraph.</p>
    <div id="pg-footer">footer</div>
  </body>
</html>
"""
    parsed = parse_gutenberg_html("https://www.gutenberg.org/cache/epub/12345/pg12345-images.html", html)

    assert parsed["book_id"] == "gutenberg-12345"
    assert parsed["title"] == "Sample Book"
    assert parsed["author"] == "Jane Writer"
    assert "First paragraph." in parsed["text"]
    assert "footer" not in parsed["text"]


def test_parse_gutenberg_text_extracts_metadata_and_body():
    raw = """
Project Gutenberg's Example, by Sample Writer

Title: Example
Author: Sample Writer

*** START OF THE PROJECT GUTENBERG EBOOK EXAMPLE ***
Chapter I. Something happens.
*** END OF THE PROJECT GUTENBERG EBOOK EXAMPLE ***
"""
    parsed = parse_gutenberg_text("https://www.gutenberg.org/cache/epub/12345/pg12345.txt", raw)

    assert parsed["book_id"] == "gutenberg-12345"
    assert parsed["title"] == "Example"
    assert parsed["author"] == "Sample Writer"
    assert "Chapter I. Something happens." in parsed["text"]
