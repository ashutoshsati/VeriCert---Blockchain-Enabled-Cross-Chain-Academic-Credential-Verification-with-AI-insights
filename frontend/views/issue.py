from datetime import date

import pandas as pd
import streamlit as st

import theme
from credential_file import FIELDS, build_file, parse_courses
from views.common import admin_error, admin_key_missing

LIST_LIMIT = 200
# Checking delivery calls /verify once per credential, so cap it per click.
DELIVERY_CHECK_LIMIT = 20


def render(api, chain_mode, default_issuer=""):
    theme.page_header(
        "Polygon Amoy · university registrar",
        "Issue a credential",
        "Record a degree on Polygon Amoy. Chainlink CCIP then delivers it to Avalanche Fuji, "
        "where employers check it. Give the graduate the credential file to share with employers.",
    )
    if not api.admin_key:
        admin_key_missing()
        return

    listing = api.credentials(LIST_LIMIT)
    if not listing.ok:
        admin_error(listing)
        return
    credentials = listing.body.get("credentials", [])

    _show_counts(credentials)
    form_col, result_col = st.columns([1.1, 0.9], gap="large")
    with form_col:
        _issue_form(api, chain_mode, default_issuer)
    with result_col:
        _last_result(chain_mode)

    st.divider()
    _credential_table(credentials)
    _actions(api, credentials, chain_mode)


def _show_counts(credentials):
    by_status = {status: 0 for status in theme.STATUS_LABELS}
    for credential in credentials:
        by_status[credential.get("status")] = by_status.get(credential.get("status"), 0) + 1
    scope = f"latest {LIST_LIMIT}" if len(credentials) == LIST_LIMIT else "all time"
    cols = st.columns(4)
    with cols[0]:
        theme.metric("Credentials issued", len(credentials), scope)
    with cols[1]:
        theme.metric("Delivered to Fuji", by_status["active"], "verifiable by employers")
    with cols[2]:
        theme.metric("In transit", by_status["relaying"], "waiting for CCIP")
    with cols[3]:
        theme.metric("Revoked", by_status["revoked"], f"{by_status['pending']} not sent" if by_status["pending"] else None)


def _issue_form(api, chain_mode, default_issuer):
    st.subheader("Degree details")
    with st.form("issue_form"):
        c1, c2 = st.columns(2)
        student_name = c1.text_input("Student full name")
        student_id = c2.text_input("Student ID")
        c3, c4 = st.columns(2)
        degree = c3.text_input("Degree", placeholder="Bachelor of Science")
        major = c4.text_input("Major", placeholder="Computer Science")
        c5, c6 = st.columns([1, 2])
        year = c5.number_input("Year awarded", min_value=1900, max_value=2100, value=date.today().year, step=1)
        issuer = c6.text_input("Issuing university", value=default_issuer)
        courses = st.text_area("Courses (optional)", placeholder="COMP6002, COMP5001 — separate with commas or new lines")
        submitted = st.form_submit_button("Issue credential", type="primary", width="stretch")

    if submitted:
        credential = {
            "studentName": student_name,
            "studentId": student_id,
            "degree": degree,
            "major": major,
            "year": int(year),
            "courses": parse_courses(courses),
            "issuer": issuer,
        }
        wait = (
            "Recording on Polygon Amoy and handing to Chainlink CCIP. On the testnet this can take a few minutes…"
            if chain_mode == "ccip"
            else "Issuing…"
        )
        with st.spinner(wait):
            result = api.issue(credential)
        st.session_state.last_issue = (credential, result)
        st.rerun()  # refresh the counts and table with the new credential


def _last_result(chain_mode):
    st.subheader("Result")
    if "last_issue" not in st.session_state:
        st.caption("The credential hash and file appear here after you issue.")
        return
    credential, result = st.session_state.last_issue

    if result.ok:
        credential_hash = result.body["credentialHash"]
        theme.banner(
            "valid",
            "Issued on Polygon Amoy",
            "Chainlink CCIP is delivering it to Avalanche Fuji. Employers can verify it once it arrives"
            + (" (usually within a few minutes)." if chain_mode == "ccip" else "."),
        )
        theme.hash_box("Credential hash", credential_hash)
        if chain_mode == "ccip":
            st.markdown(
                f"[Amoy transaction ↗]({theme.amoy_tx_url(result.body.get('txHash'))}) · "
                f"[CCIP message ↗]({theme.ccip_message_url(result.body.get('ccipMessageId'))})"
            )
        st.download_button(
            "Download credential file for the graduate",
            data=build_file({name: credential[name] for name in FIELDS}, credential_hash),
            file_name=f"vericert-{credential['studentId'] or 'credential'}.json",
            mime="application/json",
            width="stretch",
        )
    elif result.status == 409:
        theme.banner("invalid_input", "Already issued", "A credential with exactly these details already exists.")
        if result.body.get("credentialHash"):
            theme.hash_box("Existing credential hash", result.body["credentialHash"])
    elif result.status == 401:
        theme.banner("error", "Admin key rejected", "Check it matches ADMIN_API_KEY in backend/.env.")
    else:
        theme.banner("error", "Not issued", result.error)


def _credential_table(credentials):
    st.subheader("Issued credentials")
    if not credentials:
        st.caption("Nothing issued yet.")
        return
    rows = [
        {
            "Student": c.get("studentName"),
            "Student ID": c.get("studentId"),
            "Degree": c.get("degree"),
            "Major": c.get("major"),
            "Year": c.get("year"),
            "Status": theme.STATUS_LABELS.get(c.get("status"), c.get("status")),
            "Issued": theme.format_time(c.get("createdAt")),
            "Credential hash": c.get("credentialHash"),
        }
        for c in credentials
    ]
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")


def _label(credential):
    return (
        f"{credential.get('studentName')} · {credential.get('studentId')} · {credential.get('degree')} "
        f"({theme.short_hash(credential.get('credentialHash'))})"
    )


def _actions(api, credentials, chain_mode):
    if "action_message" in st.session_state:
        level, text = st.session_state.pop("action_message")
        getattr(st, level)(text)

    relaying = [c for c in credentials if c.get("status") == "relaying"]
    pending = [c for c in credentials if c.get("status") == "pending"]
    revocable = [c for c in credentials if c.get("status") in ("active", "relaying")]

    left, right = st.columns(2, gap="large")
    with left:
        if relaying:
            st.caption(
                f"{len(relaying)} credential(s) in transit. Checking asks Avalanche Fuji whether they have arrived."
            )
            if st.button("Check deliveries", width="stretch"):
                delivered = sum(api.verify_hash(c["credentialHash"]).status == 200 for c in relaying[:DELIVERY_CHECK_LIMIT])
                st.session_state.action_message = ("info", f"{delivered} of {min(len(relaying), DELIVERY_CHECK_LIMIT)} now delivered.")
                st.rerun()
        if pending:
            st.caption(f"{len(pending)} credential(s) were saved but never reached Polygon Amoy.")
            if st.button("Retry sending", width="stretch"):
                with st.spinner("Sending to Polygon Amoy…"):
                    results = [api.issue({name: c.get(name) for name in FIELDS}) for c in pending]
                failed = [r.error for r in results if not r.ok]
                st.session_state.action_message = (
                    ("error", f"{len(failed)} still failed: {failed[0]}") if failed else ("success", "All sent.")
                )
                st.rerun()

    with right:
        if not revocable:
            return
        with st.expander("Revoke a credential"):
            choice = st.selectbox("Credential", revocable, format_func=_label)
            confirmed = st.checkbox("I understand employers will see this credential as revoked. This cannot be undone.")
            if st.button("Revoke", disabled=not confirmed, width="stretch"):
                wait = "Sending the revocation through Chainlink CCIP…" if chain_mode == "ccip" else "Revoking…"
                with st.spinner(wait):
                    result = api.revoke(choice["credentialHash"])
                st.session_state.action_message = (
                    ("success", f"Revoked {_label(choice)}.") if result.ok else ("error", f"Not revoked: {result.error}")
                )
                st.rerun()
