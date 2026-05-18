#!/usr/bin/env bash
#
# Founder OS CRM -- first-boot bench script.
#
# Runs ONCE inside the configurator container after the stack is up.
# Creates the venture's Frappe site, installs the CRM app, sets the
# admin user, and generates an API key+secret pair which the
# orchestrator captures from stdout (last two lines: "KEY=...", "SECRET=...").
#
# Inputs (env):
#   SITE_NAME       -- e.g. "crm.localhost"
#   ADMIN_EMAIL     -- e.g. "founder@example.com"
#   ADMIN_PASSWORD  -- temporary password printed to the gate UI
#
# Idempotent: if the site already exists the script skips creation and
# just regenerates a fresh API key.

set -euo pipefail

SITE_NAME="${SITE_NAME:-crm.localhost}"
ADMIN_EMAIL="${ADMIN_EMAIL:-founder@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change-me-on-first-login}"

cd /home/frappe/frappe-bench

# 1. Ensure the CRM app is available locally. The base image ships
#    frappe + erpnext; CRM is a separate app we add at first-boot so
#    the image stays generic.
if [ ! -d "apps/crm" ]; then
  echo "first-boot: fetching CRM app..."
  bench get-app crm --branch main || true
fi

# 2. Create the site if it doesn't exist.
if [ ! -d "sites/${SITE_NAME}" ]; then
  echo "first-boot: creating site ${SITE_NAME}..."
  bench new-site "${SITE_NAME}" \
    --mariadb-root-password "${MYSQL_ROOT_PASSWORD:-frappe-default-root}" \
    --admin-password "${ADMIN_PASSWORD}" \
    --no-mariadb-socket
  bench --site "${SITE_NAME}" install-app erpnext || true
  bench --site "${SITE_NAME}" install-app crm
fi

# 3. Set the admin email.
bench --site "${SITE_NAME}" execute frappe.client.set_value \
  --kwargs "{\"doctype\": \"User\", \"name\": \"Administrator\", \"fieldname\": \"email\", \"value\": \"${ADMIN_EMAIL}\"}" \
  > /dev/null

# 4. Generate an API key+secret pair on the Administrator user. The
#    pipeline captures the last two lines of stdout.
bench --site "${SITE_NAME}" execute crm_first_boot.generate_admin_keys \
  --kwargs "{\"email\": \"${ADMIN_EMAIL}\"}" 2>/dev/null || {
  # Fallback: use the Python API directly.
  bench --site "${SITE_NAME}" console <<'PYEOF'
import frappe, secrets
user = frappe.get_doc("User", "Administrator")
user.api_key = secrets.token_urlsafe(20)
api_secret = secrets.token_urlsafe(40)
user.api_secret = api_secret
user.save(ignore_permissions=True)
frappe.db.commit()
print(f"KEY={user.api_key}")
print(f"SECRET={api_secret}")
PYEOF
}

echo "first-boot: done."
