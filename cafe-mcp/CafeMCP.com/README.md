# CafeMCP.com brand assets

Design tokens, logo, and favicon for the CafeMCP.com marketing site and
tenant portal. Served as static assets by `mcp_common/htmlpages.py`; edit
here and it applies site-wide (marketing pages, onboarding portal, OAuth
login, tenant portal — everything routes through the shared page shell).

## Palette

| Token | Hex | Use |
|---|---|---|
| Scarlet | `#C0243C` | Accent / primary CTA highlight, error state |
| Teal | `#0F6E68` | Primary brand color — links, buttons, nav |
| Gold | `#C9A227` | Highlight accent, focus ring, decorative — **not** for body text (insufficient contrast on sand) |
| Sand | `#F6EFE0` | Light-mode background |

Full token list with light/dark variants is in `theme.css` (`:root` /
`:root[data-theme="dark"]` / `prefers-color-scheme: dark`).

**Contrast**: body text (`--ink` `#241F1A` on `--sand` `#F6EFE0`, and
`--paper` `#F1E7D2` on `--umber` `#1B1611`) exceeds WCAG AA for normal
text (~13:1). Button text (white on `--teal`/`--scarlet`) exceeds AA for
normal text (~6:1+). Gold is intentionally restricted to accents,
underlines, and focus rings — never small text on a light background,
where its contrast ratio falls short of AA.

## Logo

`logo.svg` / `favicon.svg` — a rounded coffee-cup silhouette forming a
chat/API connector shape, teal on a rounded square, with a small gold
accent dot (the "signal"). Inline SVG only, no external font/icon fetch,
so it never conflicts with the site's `Content-Security-Policy:
default-src 'self'`.

## Theming mechanism

`theme.css` is mounted once by `serverapp.py` under `/CafeMCP.com/*` and
linked from `htmlpages.py`'s shared `page()` shell. Dark mode follows the
visitor's OS preference (`prefers-color-scheme`) with an optional
`data-theme` attribute override on `<html>` for a future manual toggle.
