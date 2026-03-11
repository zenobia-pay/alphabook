from alphabook.text import strip_project_gutenberg_boilerplate


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
