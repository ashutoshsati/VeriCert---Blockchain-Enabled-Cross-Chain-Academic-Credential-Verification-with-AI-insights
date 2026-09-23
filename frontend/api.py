"""Thin client for the VeriCert backend API (backend/server.js).

Every call returns an ApiResult instead of raising, so pages can show a
friendly message when the backend is down or rejects a request.
"""

import re
from dataclasses import dataclass, field

import requests

# Issuing and revoking wait for the Polygon Amoy transaction to confirm (up to 3 minutes in ccip mode).
CHAIN_WRITE_TIMEOUT = 240
READ_TIMEOUT = 30

# Backend validation messages name the JSON fields; show the labels people see on the forms instead.
FIELD_LABELS = {
    "studentName": "Student name",
    "studentId": "Student ID",
    "degree": "Degree",
    "major": "Major",
    "year": "Year",
    "courses": "Courses",
    "issuer": "Issuing university",
}
FIELD_PATTERN = re.compile(r"(^|; )(" + "|".join(FIELD_LABELS) + r")\b")


@dataclass
class ApiResult:
    status: int | None  # HTTP status, or None when the backend could not be reached
    body: dict = field(default_factory=dict)
    connection_error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    @property
    def error(self) -> str:
        """A human-readable reason the request failed."""
        if self.connection_error:
            return self.connection_error
        message = self.body.get("error") or f"The backend answered with HTTP {self.status}"
        return FIELD_PATTERN.sub(lambda m: m.group(1) + FIELD_LABELS[m.group(2)], message)


class VeriCertApi:
    def __init__(self, base_url: str, admin_key: str | None = None, session: requests.Session | None = None):
        self.base_url = base_url.rstrip("/")
        self.admin_key = admin_key or None
        self.session = session or requests.Session()

    def _request(self, method, path, *, admin=False, json=None, params=None, timeout=READ_TIMEOUT) -> ApiResult:
        headers = {"x-api-key": self.admin_key} if admin and self.admin_key else {}
        try:
            response = self.session.request(
                method, self.base_url + path, headers=headers, json=json, params=params, timeout=timeout
            )
        except requests.Timeout:
            return ApiResult(None, connection_error="The backend took too long to answer. Try again in a moment.")
        except requests.RequestException:
            return ApiResult(None, connection_error=f"Could not reach the backend at {self.base_url}. Is it running?")
        try:
            body = response.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        return ApiResult(response.status_code, body)

    def health(self) -> ApiResult:
        return self._request("GET", "/health", timeout=5)

    def issue(self, credential: dict) -> ApiResult:
        return self._request("POST", "/issue", admin=True, json=credential, timeout=CHAIN_WRITE_TIMEOUT)

    def revoke(self, credential_hash: str) -> ApiResult:
        return self._request("POST", f"/revoke/{credential_hash}", admin=True, timeout=CHAIN_WRITE_TIMEOUT)

    def verify_details(self, credential: dict) -> ApiResult:
        return self._request("POST", "/verify", json=credential)

    def verify_hash(self, credential_hash: str) -> ApiResult:
        return self._request("GET", f"/verify/{credential_hash.strip()}")

    def credentials(self, limit: int = 200) -> ApiResult:
        return self._request("GET", "/credentials", admin=True, params={"limit": limit})

    def events(self, limit: int = 200, credential_hash: str | None = None) -> ApiResult:
        params = {"limit": limit}
        if credential_hash:
            params["hash"] = credential_hash.strip()
        return self._request("GET", "/events", admin=True, params=params)
