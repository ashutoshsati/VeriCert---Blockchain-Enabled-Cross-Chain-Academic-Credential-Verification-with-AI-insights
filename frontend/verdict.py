"""Turns /verify and /explain responses into the verdict an employer sees.

Kept separate from the page so the rules can be unit tested: a credential is
only ever shown as valid when the backend says the on-chain record is valid.
"""

from dataclasses import dataclass

from api import ApiResult

VALID = "valid"
REVOKED = "revoked"
RELAYING = "relaying"
NOT_FOUND = "not_found"
TAMPERED = "tampered"
INVALID_INPUT = "invalid_input"
ERROR = "error"


@dataclass
class Verdict:
    kind: str
    title: str
    message: str


# Verdicts decided by the backend's code checks (/explain). The AI never sets these.
EXPLAIN_VERDICTS = {
    VALID: Verdict(
        VALID,
        "Genuine credential",
        "These details match a credential issued on Polygon Amoy and delivered to Avalanche Fuji. "
        "It has not been revoked.",
    ),
    REVOKED: Verdict(REVOKED, "Credential revoked", "The university has revoked this credential, so it is no longer valid."),
    RELAYING: Verdict(
        RELAYING,
        "Issued, still on its way to Avalanche Fuji",
        "The university issued this credential on Polygon Amoy and Chainlink CCIP is still delivering it. "
        "Try again in a few minutes.",
    ),
    TAMPERED: Verdict(
        TAMPERED,
        "Altered document",
        "This file started as a genuine credential, but its details have been changed since it was issued. "
        "Do not accept it.",
    ),
    NOT_FOUND: Verdict(
        NOT_FOUND,
        "No matching credential on Avalanche Fuji",
        "Nothing was issued with exactly these details. The document may have been altered, "
        "or it was never issued by a VeriCert university.",
    ),
}

UNAVAILABLE_MESSAGES = {
    "not_configured": "The AI summary isn't set up on this server (no OpenAI API key).",
    "rate_limited": "Too many AI summaries were requested just now. Try again in a minute.",
    "daily_limit": "This server has reached its daily limit of AI summaries. Try again tomorrow.",
    "failed": "The AI summary is unavailable right now. Try again shortly.",
}


def from_explain(body: dict) -> Verdict:
    return EXPLAIN_VERDICTS.get(
        body.get("verdict"), Verdict(ERROR, "Could not check this credential", "The backend returned an unknown verdict.")
    )


def unavailable_message(reason: str | None) -> str:
    return UNAVAILABLE_MESSAGES.get(reason, UNAVAILABLE_MESSAGES["failed"])


def interpret(result: ApiResult) -> Verdict:
    if result.status is None:
        return Verdict(ERROR, "Could not check this credential", result.error)
    if result.status == 400:
        return Verdict(INVALID_INPUT, "Check the details you entered", result.error)
    if result.status == 404:
        return EXPLAIN_VERDICTS[NOT_FOUND]
    if result.status == 202:
        return Verdict(
            RELAYING,
            "Issued, still on its way to Avalanche Fuji",
            result.body.get("message") or EXPLAIN_VERDICTS[RELAYING].message,
        )
    if result.status != 200:
        return Verdict(ERROR, "Could not check this credential", result.error)

    verification = result.body.get("verification") or {}
    if verification.get("isValid") is True:
        return EXPLAIN_VERDICTS[VALID]
    if verification.get("revoked") or verification.get("revocationPending"):
        detail = (
            "The university has revoked this credential. The revocation is still being delivered to Avalanche Fuji."
            if verification.get("revocationPending") and not verification.get("revoked")
            else EXPLAIN_VERDICTS[REVOKED].message
        )
        return Verdict(REVOKED, "Credential revoked", detail)
    return Verdict(ERROR, "This credential is not valid", "The blockchain record exists but is not marked as valid.")
