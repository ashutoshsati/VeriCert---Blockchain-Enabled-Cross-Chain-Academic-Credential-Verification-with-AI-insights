import json
import unittest
from unittest import mock

import requests

from api import ApiResult, VeriCertApi
from credential_file import build_file, parse_courses, read_file
from verdict import ERROR, INVALID_INPUT, NOT_FOUND, RELAYING, REVOKED, VALID, interpret

CREDENTIAL = {
    "studentName": "Jane Doe",
    "studentId": "S1",
    "degree": "Bachelor of Science",
    "major": "Computer Science",
    "year": 2024,
    "courses": ["COMP6002"],
    "issuer": "Example University",
}


def fake_response(status, body):
    response = mock.Mock(status_code=status)
    response.json.return_value = body
    return response


class ApiClientTest(unittest.TestCase):
    def test_sends_admin_key_only_on_admin_routes(self):
        session = mock.Mock()
        session.request.return_value = fake_response(200, {"success": True})
        api = VeriCertApi("http://api/", admin_key="secret", session=session)

        api.issue(CREDENTIAL)
        method, url = session.request.call_args.args
        self.assertEqual((method, url), ("POST", "http://api/issue"))
        self.assertEqual(session.request.call_args.kwargs["headers"], {"x-api-key": "secret"})

        api.verify_details(CREDENTIAL)
        self.assertEqual(session.request.call_args.kwargs["headers"], {})

    def test_unreachable_backend_becomes_a_readable_error(self):
        session = mock.Mock()
        session.request.side_effect = requests.ConnectionError("refused")
        result = VeriCertApi("http://api", session=session).health()
        self.assertIsNone(result.status)
        self.assertFalse(result.ok)
        self.assertIn("Could not reach the backend at http://api", result.error)

    def test_non_json_body_does_not_crash(self):
        session = mock.Mock()
        response = mock.Mock(status_code=502)
        response.json.side_effect = ValueError("not json")
        session.request.return_value = response
        result = VeriCertApi("http://api", session=session).health()
        self.assertEqual(result.body, {})
        self.assertEqual(result.error, "The backend answered with HTTP 502")

    def test_validation_errors_use_form_labels(self):
        result = ApiResult(400, {"error": "studentName is required; year must be a whole number; courses must be a list"})
        self.assertEqual(result.error, "Student name is required; Year must be a whole number; Courses must be a list")
        self.assertEqual(ApiResult(409, {"error": "This credential already exists"}).error, "This credential already exists")

    def test_events_filter_by_hash(self):
        session = mock.Mock()
        session.request.return_value = fake_response(200, {"events": []})
        VeriCertApi("http://api", admin_key="k", session=session).events(10, " 0xabc ")
        self.assertEqual(session.request.call_args.kwargs["params"], {"limit": 10, "hash": "0xabc"})


class VerdictTest(unittest.TestCase):
    def test_valid_only_when_chain_says_valid(self):
        verdict = interpret(ApiResult(200, {"verification": {"found": True, "isValid": True, "revoked": False}}))
        self.assertEqual(verdict.kind, VALID)

    def test_revoked(self):
        verdict = interpret(ApiResult(200, {"verification": {"found": True, "isValid": False, "revoked": True}}))
        self.assertEqual(verdict.kind, REVOKED)

    def test_revocation_in_transit_is_never_valid(self):
        body = {"verification": {"found": True, "isValid": False, "revoked": False, "revocationPending": True}}
        verdict = interpret(ApiResult(200, body))
        self.assertEqual(verdict.kind, REVOKED)
        self.assertIn("still being delivered", verdict.message)

    def test_revoked_before_delivery(self):
        body = {"verification": {"found": False, "isValid": False, "revoked": False, "revocationPending": True}}
        self.assertEqual(interpret(ApiResult(200, body)).kind, REVOKED)

    def test_missing_verification_is_not_valid(self):
        self.assertEqual(interpret(ApiResult(200, {})).kind, ERROR)

    def test_other_statuses(self):
        self.assertEqual(interpret(ApiResult(202, {"message": "wait"})).kind, RELAYING)
        self.assertEqual(interpret(ApiResult(404, {"error": "nope"})).kind, NOT_FOUND)
        self.assertEqual(interpret(ApiResult(400, {"error": "year must be"})).message, "Year must be")
        self.assertEqual(interpret(ApiResult(400, {})).kind, INVALID_INPUT)
        self.assertEqual(interpret(ApiResult(500, {"error": "Internal server error"})).kind, ERROR)
        self.assertEqual(interpret(ApiResult(None, connection_error="down")).kind, ERROR)


class CredentialFileTest(unittest.TestCase):
    def test_round_trip(self):
        data = build_file(CREDENTIAL, "0x" + "a" * 64)
        self.assertEqual(json.loads(data)["credentialHash"], "0x" + "a" * 64)
        self.assertEqual(read_file(data), CREDENTIAL)

    def test_accepts_bare_details_and_ignores_extra_fields(self):
        data = json.dumps({**CREDENTIAL, "status": "active"}).encode()
        self.assertEqual(read_file(data), CREDENTIAL)

    def test_courses_are_optional(self):
        details = {k: v for k, v in CREDENTIAL.items() if k != "courses"}
        self.assertEqual(read_file(json.dumps(details).encode()), details)

    def test_rejects_bad_files(self):
        for data, reason in [
            (b"%PDF-1.7", "not valid JSON"),
            (b"[1, 2]", "not a VeriCert credential file"),
            (json.dumps({"studentName": "x"}).encode(), "missing: studentId"),
            (json.dumps({"format": "vericert-credential", "credential": "x"}).encode(), "expected format"),
        ]:
            with self.assertRaisesRegex(ValueError, reason):
                read_file(data)

    def test_parse_courses(self):
        self.assertEqual(parse_courses(" COMP6002, COMP5001\nCOMP3010,, \n"), ["COMP6002", "COMP5001", "COMP3010"])
        self.assertEqual(parse_courses(""), [])


if __name__ == "__main__":
    unittest.main()
