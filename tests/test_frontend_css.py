from scripts.check_css_theme_blocks import check, main


def test_dark_theme_token_blocks_stay_in_sync():
    assert main() == []


def test_check_detects_a_real_divergence():
    css = (
        "/* BEGIN DARK-TOKENS */--bg: #111;/* END DARK-TOKENS */"
        "/* BEGIN DARK-TOKENS-DUP */--bg: #222;/* END DARK-TOKENS-DUP */"
    )
    assert check(css) != []
