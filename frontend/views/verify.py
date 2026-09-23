import pandas as pd
import streamlit as st

import theme
from credential_file import parse_courses, read_file
from verdict import RELAYING, VALID, from_explain, interpret, unavailable_message
from views.common import show_events


def render(api, chain_mode):
    theme.page_header(
        "Avalanche Fuji · employer verification",
        "Verify a credential",
        "Check a candidate's degree against the record on Avalanche Fuji. Any change to the details, "
        "even one letter of a course, means no match. No account is needed.",
    )

    by_file, by_details, by_hash = st.tabs(["Credential file", "Enter details", "Credential hash"])
    with by_file:
        _verify_file(api)
    with by_details:
        _verify_details(api)
    with by_hash:
        _verify_hash(api)

    if "verify_state" in st.session_state:
        st.divider()
        _show_result(api, st.session_state.verify_state, chain_mode)


def _check(api, payload, verify_call):
    """Runs the verification and the free code checks together; the AI summary waits for the button."""
    with st.spinner("Checking Avalanche Fuji…"):
        verify_result = verify_call()
        explain_result = api.explain(payload, ai=False)
    st.session_state.verify_state = {"verify": verify_result, "explain": explain_result, "payload": payload}
    st.session_state.pop("ai_result", None)


def _verify_file(api):
    uploaded = st.file_uploader("Credential file from the candidate (.json)", type=["json"])
    st.caption("The details inside the file are re-hashed and compared on chain, so an edited file will not match.")
    if st.button("Verify file", type="primary", disabled=uploaded is None):
        try:
            credential, claimed_hash = read_file(uploaded.getvalue())
        except ValueError as err:
            st.session_state.pop("verify_state", None)
            st.error(str(err))
            return
        payload = {**credential, "claimedHash": claimed_hash} if claimed_hash else credential
        _check(api, payload, lambda: api.verify_details(credential))


def _verify_details(api):
    with st.form("verify_details_form"):
        c1, c2 = st.columns(2)
        student_name = c1.text_input("Student full name")
        student_id = c2.text_input("Student ID")
        c3, c4 = st.columns(2)
        degree = c3.text_input("Degree")
        major = c4.text_input("Major")
        c5, c6 = st.columns([1, 2])
        year = c5.number_input("Year awarded", min_value=1900, max_value=2100, value=None, step=1, placeholder="e.g. 2024")
        issuer = c6.text_input("Issuing university")
        courses = st.text_area("Courses", placeholder="Exactly as listed on the credential, separated by commas")
        submitted = st.form_submit_button("Verify details", type="primary")
    if submitted:
        credential = {
            "studentName": student_name,
            "studentId": student_id,
            "degree": degree,
            "major": major,
            "year": int(year) if year is not None else None,
            "courses": parse_courses(courses),
            "issuer": issuer,
        }
        _check(api, credential, lambda: api.verify_details(credential))


def _verify_hash(api):
    with st.form("verify_hash_form"):
        credential_hash = st.text_input("Credential hash", placeholder="0x followed by 64 hex characters")
        submitted = st.form_submit_button("Verify hash", type="primary")
    if submitted:
        _check(api, {"hash": credential_hash.strip()}, lambda: api.verify_hash(credential_hash))


def _show_field_changes(changes):
    st.subheader("What was changed")
    rows = [{"Field": c["label"], "In the file": c["presented"], "Official record": c["official"]} for c in changes]
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")


def _ai_section(api, payload):
    if st.button("Explain this result", type="primary"):
        with st.spinner("Asking OpenAI to explain the result…"):
            st.session_state.ai_result = api.explain(payload, ai=True)
    result = st.session_state.get("ai_result")
    if result is None:
        return
    if not result.ok:
        st.warning(f"AI summary unavailable: {result.error}")
    elif result.body.get("explanation"):
        theme.ai_card(result.body["explanation"], result.body.get("model"), result.body.get("cached", False))
    else:
        st.info(unavailable_message(result.body.get("explanationUnavailable")))


def _show_result(api, state, chain_mode):
    result, explained = state["verify"], state["explain"]
    verdict = from_explain(explained.body) if explained.ok else interpret(result)
    theme.banner(verdict.kind, verdict.title, verdict.message)
    body = result.body

    if explained.ok and explained.body.get("fieldChanges"):
        _show_field_changes(explained.body["fieldChanges"])

    checked_hash = explained.body.get("credentialHash") if explained.ok else body.get("credentialHash")
    if checked_hash:
        theme.hash_box("Credential hash checked", checked_hash, muted=verdict.kind != VALID)

    if verdict.kind == RELAYING and chain_mode == "ccip" and body.get("ccipMessageId"):
        st.markdown(f"[Track the CCIP message ↗]({theme.ccip_message_url(body['ccipMessageId'])})")

    if explained.ok:
        st.subheader("Checked by VeriCert")
        st.caption("Computed by code from the blockchain and the VeriCert database, not by the AI.")
        theme.checks_panel(explained.body.get("checks", []))
        _ai_section(api, state["payload"])
    elif result.status not in (None, 400):
        st.caption(f"Detailed checks unavailable: {explained.error}")

    if result.status != 200:
        return

    metadata = body.get("metadata")
    if metadata:
        st.subheader("Credential details")
        theme.fields(
            [
                ("Student", metadata.get("studentName")),
                ("Student ID", metadata.get("studentId")),
                ("Degree", metadata.get("degree")),
                ("Major", metadata.get("major")),
                ("Year", metadata.get("year")),
                ("Issuing university", metadata.get("issuer")),
                ("Courses", ", ".join(metadata.get("courses") or []) or "—"),
            ]
        )

    verification = body.get("verification") or {}
    if verification.get("found"):
        st.subheader("On-chain record (Avalanche Fuji)")
        theme.fields(
            [
                ("Issued by", verification.get("issuer")),
                ("Issued on Amoy", theme.format_time(verification.get("issuedAt"))),
                ("Arrived on Fuji", theme.format_time(verification.get("receivedAt"))),
                ("Revoked", "Yes" if verification.get("revoked") else "No"),
            ]
        )

    provenance = body.get("provenance") or []
    if provenance:
        st.subheader("History")
        show_events(provenance, chain_mode)

    with st.expander("Raw response from the backend"):
        st.json(body)
