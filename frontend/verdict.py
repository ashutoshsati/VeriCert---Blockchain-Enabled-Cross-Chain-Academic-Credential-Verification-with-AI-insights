"""Turns a /verify response into the verdict an employer sees.

Kept separate from the page so the rules can be unit tested: a credential is
only ever shown as valid when the backend says the on-chain record is valid.
"""

from dataclasses import dataclass

from api import ApiResult

VALID = "valid"
REVOKED = "revoked"
RELAYING = "relaying"
NOT_FOUND = "not_found"
INVALID_INPUT = "invalid_input"
ERROR = "error"


@dataclass
class Verdict:
    kind: str
    title: str
    message: str


def interpret(result: ApiResult) -> Verdict:
    if result.status is None:
        return Verdict(ERROR, "Could not check this credential", result.error)
    if result.status == 400:
        return Verdict(INVALID_INPUT, "Check the details you entered", result.error)
    if result.status == 404:
        return Verdict(
            NOT_FOUND,
            "No matching credential on Avalanche Fuji",
            "Nothing was issued with exactly these details. The document may have been altered, "
            "or it was never issued by a VeriCert university.",
        )
    if result.status == 202:
        return Verdict(
            RELAYING,
            "Issued, still on its way to Avalanche Fuji",
            result.body.get("message")
            or "The university issued this credential on Polygon Amoy and Chainlink CCIP is still delivering it. "
            "Try again in a few minutes.",
        )
    if result.status != 200:
        return Verdict(ERROR, "Could not check this credential", result.error)

    verification = result.body.get("verification") or {}
    if verification.get("isValid") is True:
        return Verdict(
            VALID,
            "Genuine credential",
            "These details match a credential issued on Polygon Amoy and delivered to Avalanche Fuji. "
            "It has not been revoked.",
        )
    if verification.get("revoked") or verification.get("revocationPending"):
        detail = (
            "The university has revoked this credential. The revocation is still being delivered to Avalanche Fuji."
            if verification.get("revocationPending") and not verification.get("revoked")
            else "The university has revoked this credential, so it is no longer valid."
        )
        return Verdict(REVOKED, "Credential revoked", detail)
    return Verdict(ERROR, "This credential is not valid", "The blockchain record exists but is not marked as valid.")
