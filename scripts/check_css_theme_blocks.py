"""Vérifie que les deux blocs de tokens du thème sombre dans
site/css/style.css (celui déclenché par `prefers-color-scheme` et celui
déclenché par `[data-theme="dark"]`) restent identiques caractère pour
caractère.

Les deux existent parce qu'un visiteur peut forcer le thème via le bouton
(`data-theme`, voir site/js/app.js `initThemeToggle`) indépendamment de sa
préférence système (`prefers-color-scheme`) : CSS ne permet pas de
factoriser ces deux déclencheurs en un seul bloc de tokens. Sans ce
contrôle, une modification faite dans un seul des deux blocs désynchronise
silencieusement le thème forcé de la préférence système — exécuté par
tests/test_frontend_css.py à chaque `pytest` plutôt que vérifié à la main.
"""
from __future__ import annotations

from pathlib import Path

STYLE_CSS_PATH = Path(__file__).resolve().parent.parent / "site" / "css" / "style.css"
START_A, END_A = "/* BEGIN DARK-TOKENS */", "/* END DARK-TOKENS */"
START_B, END_B = "/* BEGIN DARK-TOKENS-DUP */", "/* END DARK-TOKENS-DUP */"


def _extract(css: str, start: str, end: str) -> str:
    start_i = css.index(start) + len(start)
    end_i = css.index(end, start_i)
    return css[start_i:end_i]


def _normalized_lines(block: str) -> list[str]:
    # Les deux blocs vivent à des profondeurs d'imbrication différentes
    # (@media { :root {} } contre :root[data-theme] {} directement) : seule
    # l'indentation diffère légitimement, pas le contenu.
    return [line.strip() for line in block.splitlines() if line.strip()]


def check(css_text: str) -> list[str]:
    block_a = _extract(css_text, START_A, END_A)
    block_b = _extract(css_text, START_B, END_B)
    if _normalized_lines(block_a) != _normalized_lines(block_b):
        return [
            "Les deux blocs de tokens du thème sombre ont divergé "
            "(voir BEGIN/END DARK-TOKENS[-DUP] dans site/css/style.css)."
        ]
    return []


def main() -> list[str]:
    return check(STYLE_CSS_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    problems = main()
    for p in problems:
        print(p)
    raise SystemExit(1 if problems else 0)
