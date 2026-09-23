"""The credential file a university hands to the graduate, and the employer uploads to verify.

It carries the credential details in plain JSON. Verification always re-hashes
the details on the server, so editing any detail in the file makes it fail.
"""

import json
import re

FIELDS = ["studentName", "studentId", "degree", "major", "year", "courses", "issuer"]
FORMAT = "vericert-credential"
HASH_PATTERN = re.compile(r"^0x[0-9a-fA-F]{64}$")


def parse_courses(text: str) -> list[str]:
    """Accepts courses separated by commas or new lines."""
    return [course.strip() for course in re.split(r"[,\n]", text or "") if course.strip()]


def build_file(credential: dict, credential_hash: str) -> bytes:
    document = {
        "format": FORMAT,
        "version": 1,
        "credential": {name: credential[name] for name in FIELDS if name in credential},
        "credentialHash": credential_hash,
    }
    return json.dumps(document, indent=2).encode("utf-8")


def read_file(data: bytes) -> tuple[dict, str | None]:
    """Returns (credential details, claimed hash) from an uploaded file, or raises ValueError with a readable reason.

    The claimed hash is the one the university wrote into the file; it is None for bare details or a malformed hash.
    """
    try:
        document = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("This is not a VeriCert credential file (it is not valid JSON).") from None
    if not isinstance(document, dict):
        raise ValueError("This is not a VeriCert credential file.")

    is_full_file = document.get("format") == FORMAT
    # Accept the full file or just the credential details on their own.
    credential = document.get("credential", document) if is_full_file else document
    if not isinstance(credential, dict):
        raise ValueError("The credential details in this file are not in the expected format.")
    missing = [name for name in FIELDS if name != "courses" and name not in credential]
    if missing:
        raise ValueError(f"The file is missing: {', '.join(missing)}.")

    claimed = document.get("credentialHash") if is_full_file else None
    claimed_hash = claimed.lower() if isinstance(claimed, str) and HASH_PATTERN.match(claimed) else None
    return {name: credential[name] for name in FIELDS if name in credential}, claimed_hash
