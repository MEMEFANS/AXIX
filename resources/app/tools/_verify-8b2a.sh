DB=/opt/wg-platform/wg-platform.sqlite
W=0x8B2a642A6b658532044B08F60fA4E117700b0D79
WID=ata_2_1791958244812_0x8b2a64

echo "=== activation row ==="
sqlite3 -header -column "$DB" "SELECT id, plan, status, datetime(created_at/1000,'unixepoch','+8 hours') created, datetime(confirmed_at/1000,'unixepoch','+8 hours') confirmed, substr(payload_json,1,150) p FROM a_token_activations WHERE id='$WID';"

echo
echo "=== miners ==="
sqlite3 -header -column "$DB" "SELECT id, plan, status, datetime(started_at/1000,'unixepoch','+8 hours') started FROM a_token_miners WHERE lower(wallet)=lower('$W');"

echo
echo "=== lottery flows (latest 12) ==="
sqlite3 -header -column "$DB" "SELECT id, change, balance, type, ref_id, note, datetime(created_at/1000,'unixepoch','+8 hours') t FROM lottery_flows WHERE lower(wallet)=lower('$W') ORDER BY created_at DESC LIMIT 12;"

echo
echo "=== lottery account ==="
sqlite3 -header -column "$DB" "SELECT * FROM lottery_accounts WHERE lower(wallet)=lower('$W');"

echo "=== done ==="
