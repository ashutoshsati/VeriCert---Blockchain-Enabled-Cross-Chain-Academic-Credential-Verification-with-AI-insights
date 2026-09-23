"""VeriCert web app: university issuing, employer verification and the activity log.

Run from frontend/:  streamlit run app.py
Settings (environment variables or .streamlit/secrets.toml):
  VERICERT_API_URL      backend address (default http://localhost:3000)
  VERICERT_ADMIN_KEY    optional; otherwise type ADMIN_API_KEY into the sidebar
  VERICERT_ISSUER_NAME  optional; pre-fills the issuing university on the issue form
"""

import os

import streamlit as st

import theme
from api import VeriCertApi
from views import activity, issue, verify

st.set_page_config(page_title="VeriCert", page_icon="🎓", layout="wide")
theme.inject()


def setting(name: str, default: str = "") -> str:
    if os.environ.get(name):
        return os.environ[name]
    try:
        return str(st.secrets.get(name, default))
    except Exception:  # no secrets.toml
        return default


@st.cache_data(ttl=15, show_spinner=False)
def backend_health(api_url: str):
    return VeriCertApi(api_url).health()


api_url = setting("VERICERT_API_URL", "http://localhost:3000")
configured_key = setting("VERICERT_ADMIN_KEY")

with st.sidebar:
    st.markdown("### 🎓 VeriCert")
    st.caption("Cross-chain degree verification · COMP6002")

    health = backend_health(api_url)
    chain_mode = health.body.get("chainMode") if health.ok else None
    if chain_mode == "ccip":
        st.success("Backend connected · live testnets (Amoy → Fuji)")
    elif chain_mode:
        st.warning("Backend connected · **mock chain** (simulated, no real transactions)")
    else:
        st.error(f"Backend not reachable at {api_url}")
        if st.button("Retry connection"):
            backend_health.clear()
            st.rerun()

    st.divider()
    if configured_key:
        admin_key = configured_key
        st.caption("University admin key loaded from settings.")
    else:
        admin_key = st.text_input(
            "University admin key",
            type="password",
            help="The ADMIN_API_KEY from backend/.env. Needed to issue, revoke and view activity; "
            "employers can verify without it.",
        )

api = VeriCertApi(api_url, admin_key)
issuer_name = setting("VERICERT_ISSUER_NAME")

page = st.navigation(
    [
        st.Page(lambda: verify.render(api, chain_mode), title="Verify", icon=":material/verified:", url_path="verify", default=True),
        st.Page(lambda: issue.render(api, chain_mode, issuer_name), title="Issue", icon=":material/school:", url_path="issue"),
        st.Page(lambda: activity.render(api, chain_mode), title="Activity", icon=":material/timeline:", url_path="activity"),
    ]
)
page.run()
