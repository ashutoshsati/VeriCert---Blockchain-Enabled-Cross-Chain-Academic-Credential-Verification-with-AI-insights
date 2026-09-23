from collections import Counter

import streamlit as st

import theme
from views.common import admin_error, admin_key_missing, show_events

LIMIT = 200


def render(api, chain_mode):
    theme.page_header(
        "Chainlink CCIP · activity",
        "Activity log",
        "Every issue, CCIP relay, delivery, verification and revocation the backend has recorded, newest first.",
    )
    if not api.admin_key:
        admin_key_missing()
        return

    credential_hash = st.text_input("Filter by credential hash", placeholder="0x… (leave empty for all activity)")
    result = api.events(LIMIT, credential_hash.strip() or None)
    if not result.ok:
        admin_error(result)
        return
    events = result.body.get("events", [])

    counts = Counter(event.get("eventType") for event in events)
    cols = st.columns(4)
    for col, (event_type, label) in zip(
        cols, [("relayed", "Sent via CCIP"), ("delivered", "Delivered to Fuji"), ("verified", "Verifications"), ("revoked", "Revocations")]
    ):
        with col:
            theme.metric(label, counts.get(event_type, 0), f"in the latest {LIMIT} events" if len(events) == LIMIT else None)

    if not events:
        st.caption("No activity yet." if not credential_hash.strip() else "No activity for this credential.")
        return
    show_events(events, chain_mode, include_hash=not credential_hash.strip())
