# IN PLAIN ENGLISH: this is the starting point of the VeriCert website. It sets up the page, shows a
# sidebar telling you whether the backend is reachable (and whether it's using the real blockchains or
# the simulation), asks university staff for their admin key, and offers three pages:
#   Verify   - for employers checking a degree (no key needed),
#   Issue    - for universities issuing and revoking degrees,
#   Activity - the history of everything that has happened.
# The website never talks to the blockchain directly; it only asks the backend.
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

# Browser tab title and icon, and the site's look and feel (colours, fonts).
st.set_page_config(page_title="VeriCert", page_icon="🎓", layout="wide")
theme.inject()


# Reads a setting, first from the computer's environment, then from the website's secrets file,
# otherwise uses the default.
def setting(name: str, default: str = "") -> str:
    if os.environ.get(name):
        return os.environ[name]
    try:
        return str(st.secrets.get(name, default))
    except Exception:  # no secrets.toml
        return default


# Asks the backend "are you there?" The answer is remembered for 15 seconds so we don't ask on every click.
@st.cache_data(ttl=15, show_spinner=False)
def backend_health(api_url: str):
    return VeriCertApi(api_url).health()


# Where the backend lives, and the admin key if one has been saved in the settings.
api_url = setting("VERICERT_API_URL", "http://localhost:3000")
configured_key = setting("VERICERT_ADMIN_KEY")

# THE SIDEBAR: connection status (green = real blockchains, amber = simulation, red = can't connect)
# and the university admin key box.
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

# The connection to the backend, carrying the admin key if one was given.
api = VeriCertApi(api_url, admin_key)
issuer_name = setting("VERICERT_ISSUER_NAME")

# The three pages of the site, with Verify shown first.
page = st.navigation(
    [
        st.Page(lambda: verify.render(api, chain_mode), title="Verify", icon=":material/verified:", url_path="verify", default=True),
        st.Page(lambda: issue.render(api, chain_mode, issuer_name), title="Issue", icon=":material/school:", url_path="issue"),
        st.Page(lambda: activity.render(api, chain_mode), title="Activity", icon=":material/timeline:", url_path="activity"),
    ]
)
page.run()
