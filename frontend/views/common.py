import pandas as pd
import streamlit as st

import theme


def show_events(events: list[dict], chain_mode: str | None, include_hash: bool = False):
    """Provenance events as a table. Explorer links only appear in ccip mode, where the hashes are real."""
    live = chain_mode == "ccip"
    rows = []
    for event in events:
        row = {
            "Time": theme.format_time(event.get("timestamp")),
            "Event": theme.EVENT_LABELS.get(event.get("eventType"), event.get("eventType")),
            "Chain": theme.CHAIN_LABELS.get(event.get("chain"), event.get("chain")),
            "Details": event.get("details") or "",
        }
        if include_hash:
            row["Credential"] = theme.short_hash(event.get("credentialHash"))
        if live:
            row["Transaction"] = theme.amoy_tx_url(event.get("txHash"))
            row["CCIP message"] = theme.ccip_message_url(event.get("ccipMessageId"))
        else:
            row["Transaction"] = theme.short_hash(event.get("txHash")) if event.get("txHash") else ""
            row["CCIP message"] = theme.short_hash(event.get("ccipMessageId")) if event.get("ccipMessageId") else ""
        rows.append(row)

    column_config = {}
    if live:
        column_config = {
            "Transaction": st.column_config.LinkColumn("Transaction", display_text="PolygonScan ↗"),
            "CCIP message": st.column_config.LinkColumn("CCIP message", display_text="CCIP Explorer ↗"),
        }
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch", column_config=column_config)
    if not live and any(event.get("txHash") for event in events):
        st.caption("Mock chain: these transaction and message IDs are simulated, so they have no explorer links.")


def admin_key_missing():
    st.info("Enter the admin API key in the sidebar to use this page. It is the ADMIN_API_KEY from backend/.env.")


def admin_error(result):
    if result.status == 401:
        st.error("The backend rejected the admin API key. Check it matches ADMIN_API_KEY in backend/.env.")
    else:
        st.error(result.error)
