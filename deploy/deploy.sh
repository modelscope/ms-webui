#!/bin/bash
# On-host update step of the push-to-deploy pipeline. CI rsyncs the webui source tree to
# /opt/ms-webui/webui, then runs this script over ssh: install node deps, bundle skills,
# restart the service. Python env (server-setup.sh) is NOT touched here — it moves slower
# than the webui and is updated by re-running server-setup.sh.
set -euxo pipefail
cd /opt/ms-webui/webui

npm ci --no-audit --no-fund

# Skills: single source of truth is the swift repo's skills/ (dev-swift-v5 branch — main
# does not carry it yet); fetch-skills clones shallow by default.
SWIFT_SKILLS_REF=dev-swift-v5 node scripts/fetch-skills.mjs

systemctl restart ms-webui
systemctl --no-pager --lines=0 status ms-webui >/dev/null
echo DEPLOY_DONE
