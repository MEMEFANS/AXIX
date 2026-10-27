md5sum /opt/wg-platform/remote-prof2.mjs
cd /opt/wg-platform && PROF_MS=30000 node remote-prof2.mjs 2>&1 | head -n 130
