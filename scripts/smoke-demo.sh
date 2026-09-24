#!/bin/bash
# Post-reset smoke check: demo logins, case list, incoming transfer mailbox.
BASE=http://localhost:3000
BYPASS="x-test-bypass-rate-limit: phase1-local-test-bypass-9f3a"
J=/tmp/smoke-jar
PASS=0; FAIL=0

login() { # $1 email -> sets cookie jar, echoes HTTP code
  curl -s -o /dev/null -w "%{http_code}" -c $J -X POST "$BASE/api/v1/auth/login" \
    -H "$BYPASS" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"Demo@Pass1\"}"
}

check() { # $1 label, $2 actual, $3 expected
  if [ "$2" == "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1 ($2)";
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (got $2, want $3)"; fi
}

# 1) five demo logins
for e in sysadmin@demo.gov.in arjun.sharma@demo.gov.in meera.desai@demo.gov.in vishnu.kumar@demo.gov.in priya.nair@demo.gov.in; do
  check "login $e" "$(login $e)" "200"
done

# 2) sysadmin lists cases -> 6 seeded (newest first by design)
login sysadmin@demo.gov.in > /dev/null
CNT=$(curl -s -b $J "$BASE/api/v1/cases?pageSize=50" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total'])" 2>/dev/null)
check "sysadmin sees 6 seeded cases" "$CNT" "6"
FIRST=$(curl -s -b $J "$BASE/api/v1/cases?pageSize=1" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['items'][0]['caseId'])" 2>/dev/null)
check "newest case first (createdAt desc)" "$FIRST" "CASE-MP-IND-2026-000006"

# 3) meera (FSL admin) incoming transfer mailbox -> TRF-MP-IND-2026-000003
login meera.desai@demo.gov.in > /dev/null
INCOMING=$(curl -s -b $J "$BASE/api/v1/transfers/incoming" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['items'][0]['transferId'] if d['items'] else 'NONE')" 2>/dev/null)
check "meera incoming transfer" "$INCOMING" "TRF-MP-IND-2026-000003"

# 4) vishnu is explicitly assigned to case 2 (INVESTIGATING_OFFICER) -> 200 is correct;
#    devika (Bhopal Police, unrelated) must be denied 403 and see 0 search results
login vishnu.kumar@demo.gov.in > /dev/null
check "assigned officer views case 2" "$(curl -s -o /dev/null -w '%{http_code}' -b $J "$BASE/api/v1/cases/CASE-MP-IND-2026-000002")" "200"
login devika.iyer@demo.gov.in > /dev/null
check "unrelated officer denied case 2" "$(curl -s -o /dev/null -w '%{http_code}' -b $J "$BASE/api/v1/cases/CASE-MP-IND-2026-000002")" "403"
LEAK=$(curl -s -b $J "$BASE/api/v1/cases?pageSize=50" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total'])" 2>/dev/null)
check "unrelated officer search leaks nothing" "$LEAK" "0"

# 5) auditor read-only: can view case 1, cannot create case
login priya.nair@demo.gov.in > /dev/null
check "auditor views case 1" "$(curl -s -o /dev/null -w '%{http_code}' -b $J "$BASE/api/v1/cases/CASE-MP-IND-2026-000001")" "200"
check "auditor cannot create case" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST "$BASE/api/v1/cases" -H 'Content-Type: application/json' -d '{"title":"x","caseType":"FIR","stateId":"s","districtId":"d","cityId":"c"}')" "403"

# logout all
for e in sysadmin arjun.sharma meera.desai vishnu.kumar priya.nair; do :; done
echo "---- summary: $PASS passed, $FAIL failed ----"
exit $FAIL
