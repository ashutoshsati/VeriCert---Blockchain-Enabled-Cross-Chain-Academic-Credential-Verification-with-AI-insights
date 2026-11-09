# IN PLAIN ENGLISH: the website's look and feel: colours, fonts and the reusable visual pieces (page
# headings, summary boxes, coloured verdict banners, the checks list, the AI summary card). It also
# turns technical values into friendly ones, e.g. "relaying" -> "In transit", and makes links to
# public blockchain explorer websites. Anything typed by users is made safe before being displayed.
"""Look and feel: the "Obsidian Trust" palette from DESIGN.md plus small HTML building blocks.

Every value placed into HTML goes through html.escape, because credential details are user input.
"""

from datetime import datetime, timezone
from html import escape

import streamlit as st

# The style sheet: colours, fonts, spacing and shapes for every visual element on the site.
CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Geist:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

html, body, .stApp, [data-testid="stMarkdownContainer"], input, textarea, button {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
h1, h2, h3 { font-family: 'Space Grotesk', sans-serif !important; letter-spacing: -0.015em; }
section[data-testid="stSidebar"] { background-color: #0e0e10; border-right: 1px solid #222226; }

.vc-eyebrow {
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; letter-spacing: 0.06em;
  text-transform: uppercase; color: #71717a; margin-bottom: 4px;
}
.vc-eyebrow .dot { color: #10b981; }
.vc-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.85rem; font-weight: 600;
  color: #f4f4f5; letter-spacing: -0.02em; margin: 0 0 6px 0; line-height: 1.2; }
.vc-subtitle { color: #a1a1aa; font-size: 0.9rem; margin-bottom: 20px; line-height: 1.5; max-width: 60rem; }

.vc-metric { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px; }
.vc-metric-label { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: #a1a1aa;
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.vc-metric-value { font-family: 'Space Grotesk', sans-serif; font-size: 1.7rem; font-weight: 600; color: #f4f4f5; }
.vc-metric-sub { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: #71717a; margin-top: 2px; }

.vc-label { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: #71717a;
  text-transform: uppercase; letter-spacing: 0.05em; }
.vc-hash { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; background: #111113;
  border: 1px solid #27272a; border-radius: 6px; padding: 10px 14px; color: #34d399;
  word-break: break-all; margin: 4px 0 14px 0; }
.vc-hash.muted { color: #a1a1aa; }

.vc-banner { border-radius: 8px; padding: 16px 20px; margin: 8px 0 18px 0; border: 1px solid; }
.vc-banner-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; font-weight: 600; margin-bottom: 4px; }
.vc-banner-body { font-size: 0.88rem; color: #d4d4d8; line-height: 1.5; }
.vc-good { background: rgba(16,185,129,0.07); border-color: rgba(16,185,129,0.35); }
.vc-good .vc-banner-title { color: #34d399; }
.vc-warn { background: rgba(245,158,11,0.07); border-color: rgba(245,158,11,0.35); }
.vc-warn .vc-banner-title { color: #f59e0b; }
.vc-bad { background: rgba(248,113,113,0.07); border-color: rgba(248,113,113,0.35); }
.vc-bad .vc-banner-title { color: #f87171; }

.vc-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-bottom: 16px; }
.vc-field { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: 10px 12px; }
.vc-field-value { color: #f4f4f5; font-size: 0.9rem; margin-top: 2px; word-break: break-word; }

.vc-checks { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.vc-check { display: flex; gap: 12px; align-items: flex-start; background: #18181b; border: 1px solid #27272a;
  border-radius: 6px; padding: 10px 12px; }
.vc-check-icon { font-family: 'JetBrains Mono', monospace; width: 1.2em; text-align: center; font-weight: 600; }
.vc-check-pass .vc-check-icon { color: #34d399; }
.vc-check-warn { border-color: rgba(245,158,11,0.35); }
.vc-check-warn .vc-check-icon { color: #f59e0b; }
.vc-check-critical { border-color: rgba(248,113,113,0.35); }
.vc-check-critical .vc-check-icon { color: #f87171; }
.vc-check-skip .vc-check-icon { color: #71717a; }
.vc-check-label { color: #f4f4f5; font-size: 0.88rem; font-weight: 500; }
.vc-check-detail { color: #a1a1aa; font-size: 0.8rem; margin-top: 2px; }

.vc-ai { background: #18181b; border: 1px solid rgba(16,185,129,0.35); border-radius: 8px; padding: 16px 20px; margin: 8px 0 16px 0; }
.vc-ai-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.05rem; font-weight: 600; color: #34d399; }
.vc-ai-sub { font-size: 0.75rem; color: #71717a; margin-bottom: 10px; }
.vc-ai-summary { color: #e4e4e7; font-size: 0.92rem; line-height: 1.6; margin-bottom: 10px; }
.vc-ai-obs { font-size: 0.85rem; color: #d4d4d8; margin: 4px 0; }
.vc-ai-obs.warning::before { content: "⚠ "; color: #f59e0b; }
.vc-ai-obs.info::before { content: "• "; color: #71717a; }
.vc-ai-rec { font-size: 0.88rem; color: #f4f4f5; margin-top: 10px; border-top: 1px solid #27272a; padding-top: 10px; }

</style>
"""

# Banner colours: green for genuine, amber for "in transit" or input problems, red for everything else.
BANNER_STYLE = {"valid": "vc-good", "relaying": "vc-warn", "invalid_input": "vc-warn"}

# Friendly names for degree statuses, blockchains and history events.
STATUS_LABELS = {
    "active": "Delivered",
    "relaying": "In transit",
    "revoked": "Revoked",
    "pending": "Not sent",
}

CHAIN_LABELS = {"polygon-amoy": "Polygon Amoy", "avalanche-fuji": "Avalanche Fuji", "both": "Amoy → Fuji"}

EVENT_LABELS = {
    "issued": "Issued",
    "relayed": "Sent via CCIP",
    "delivered": "Delivered to Fuji",
    "verified": "Verified",
    "revoked": "Revoked",
}


# Applies the style sheet to the page.
def inject():
    st.markdown(CSS, unsafe_allow_html=True)


# Places a piece of styled content on the page.
def _html(markup: str):
    st.markdown(markup, unsafe_allow_html=True)


# VISUAL BUILDING BLOCKS used by the pages:
# Page heading: small label, big title and a one-line description.
def page_header(eyebrow: str, title: str, subtitle: str):
    _html(
        f'<div class="vc-eyebrow"><span class="dot">●</span> {escape(eyebrow)}</div>'
        f'<div class="vc-title">{escape(title)}</div>'
        f'<div class="vc-subtitle">{escape(subtitle)}</div>'
    )


# A summary box with a big number, e.g. "Revoked: 3".
def metric(label: str, value, sub: str | None = None):
    sub_html = f'<div class="vc-metric-sub">{escape(sub)}</div>' if sub else ""
    _html(
        f'<div class="vc-metric"><div class="vc-metric-label">{escape(label)}</div>'
        f'<div class="vc-metric-value">{escape(str(value))}</div>{sub_html}</div>'
    )


# A box showing a degree's fingerprint code (greyed out when the degree isn't valid).
def hash_box(label: str, value: str, muted: bool = False):
    style = "vc-hash muted" if muted else "vc-hash"
    _html(f'<div class="vc-label">{escape(label)}</div><div class="{style}">{escape(value)}</div>')


# The coloured verdict banner, e.g. a green "Genuine credential".
def banner(kind: str, title: str, message: str):
    style = BANNER_STYLE.get(kind, "vc-bad")
    _html(
        f'<div class="vc-banner {style}"><div class="vc-banner-title">{escape(title)}</div>'
        f'<div class="vc-banner-body">{escape(message)}</div></div>'
    )


# A grid of label/value pairs, e.g. "Degree: Bachelor of Science".
def fields(pairs: list[tuple[str, str]]):
    cells = "".join(
        f'<div class="vc-field"><div class="vc-label">{escape(label)}</div>'
        f'<div class="vc-field-value">{escape(str(value))}</div></div>'
        for label, value in pairs
    )
    _html(f'<div class="vc-fields">{cells}</div>')


# The icon for each check: ✓ passed, – skipped, ✕ critical failure, ⚠ warning.
def check_style(check: dict) -> tuple[str, str]:
    if check.get("status") == "passed":
        return "✓", "pass"
    if check.get("status") == "skipped":
        return "–", "skip"
    return ("✕", "critical") if check.get("severity") == "critical" else ("⚠", "warn")


# The list of automatic checks, each with its icon, name and one-line reason.
def checks_panel(checks: list[dict]):
    rows = []
    for check in checks:
        icon, style = check_style(check)
        rows.append(
            f'<div class="vc-check vc-check-{style}"><span class="vc-check-icon">{icon}</span><div>'
            f'<div class="vc-check-label">{escape(check.get("label", ""))}</div>'
            f'<div class="vc-check-detail">{escape(check.get("detail", ""))}</div></div></div>'
        )
    _html(f'<div class="vc-checks">{"".join(rows)}</div>')


# The AI summary card: summary, observations, recommendation, and a note that the AI only explains
# the checks and doesn't decide them.
def ai_card(explanation: dict, model: str | None, cached: bool):
    observations = "".join(
        f'<div class="vc-ai-obs {"warning" if item.get("severity") == "warning" else "info"}">{escape(item.get("text", ""))}</div>'
        for item in explanation.get("observations", [])
    )
    saved = " · saved report" if cached else ""
    _html(
        f'<div class="vc-ai"><div class="vc-ai-title">AI summary</div>'
        f'<div class="vc-ai-sub">Written by OpenAI {escape(model or "")}{saved}. '
        f"It explains the checks above; it doesn't decide them.</div>"
        f'<div class="vc-ai-summary">{escape(explanation.get("summary", ""))}</div>{observations}'
        f'<div class="vc-ai-rec"><strong>Recommendation:</strong> {escape(explanation.get("recommendation", ""))}</div></div>'
    )


# FORMATTING HELPERS:
# Shortens a long code for display, e.g. "0x1234abcd…9f8e7d".
def short_hash(value: str | None) -> str:
    if not value:
        return "—"
    return f"{value[:10]}…{value[-6:]}" if len(value) > 20 else value


def format_time(value) -> str:
    """Formats an ISO timestamp from MongoDB or a millisecond timestamp from the chain, in local time."""
    if value in (None, ""):
        return "—"
    try:
        if isinstance(value, (int, float)):
            moment = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        else:
            moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return moment.astimezone().strftime("%d %b %Y, %H:%M:%S")
    except (ValueError, OverflowError, OSError):
        return str(value)


# Links to public websites where anyone can independently look up a blockchain transaction
# (PolygonScan) or follow a cross-chain message (Chainlink's CCIP Explorer).
def amoy_tx_url(tx_hash: str | None) -> str | None:
    return f"https://amoy.polygonscan.com/tx/{tx_hash}" if tx_hash else None


def ccip_message_url(message_id: str | None) -> str | None:
    return f"https://ccip.chain.link/msg/{message_id}" if message_id else None
