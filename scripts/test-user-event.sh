#!/usr/bin/env bash
# Tests for User Service + Event Service (Andrin).
# Runs against the gateway by default; point USER_URL / EVENT_URL / EVENT_URL_2
# at single instances to test them directly.
#
#   SERVICE_TOKEN=... ./scripts/test-user-event.sh
#   USER_URL=http://localhost:3001 EVENT_URL=http://localhost:3002 \
#   EVENT_URL_2=http://localhost:3003 SERVICE_TOKEN=... ./scripts/test-user-event.sh
#
# Requires: curl, jq
set -uo pipefail

USER_URL=${USER_URL:-http://localhost/api}
EVENT_URL=${EVENT_URL:-http://localhost/api}
EVENT_URL_2=${EVENT_URL_2:-$EVENT_URL}   # second replica for the parallel test
SERVICE_TOKEN=${SERVICE_TOKEN:?set SERVICE_TOKEN}
RUN=$RANDOM$RANDOM
PASS=0; FAIL=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1))
  else echo "  FAIL  $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { curl -s -H 'Content-Type: application/json' "$@"; }
login() { json -X POST "$USER_URL/users/login" -d "{\"username\":\"$1\",\"password\":\"secret\"}" | jq -r .token; }

EVENT='{"title":"Concert","description":"Live","venue":"Zürich","date":"2027-03-01T20:00:00Z","price":49.9,"capacity":10}'

echo "User Service"
check "T1 register organizer -> 201" 201 "$(code -X POST "$USER_URL/users/register" -H 'Content-Type: application/json' -d "{\"username\":\"org$RUN\",\"password\":\"secret\",\"role\":\"organizer\"}")"
check "T1 register customer -> 201"  201 "$(code -X POST "$USER_URL/users/register" -H 'Content-Type: application/json' -d "{\"username\":\"cus$RUN\",\"password\":\"secret\",\"role\":\"customer\"}")"
check "duplicate username -> 409"    409 "$(code -X POST "$USER_URL/users/register" -H 'Content-Type: application/json' -d "{\"username\":\"cus$RUN\",\"password\":\"secret\",\"role\":\"customer\"}")"
check "invalid role -> 400"          400 "$(code -X POST "$USER_URL/users/register" -H 'Content-Type: application/json' -d "{\"username\":\"x$RUN\",\"password\":\"secret\",\"role\":\"admin\"}")"
check "wrong password -> 401"        401 "$(code -X POST "$USER_URL/users/login" -H 'Content-Type: application/json' -d "{\"username\":\"cus$RUN\",\"password\":\"nope\"}")"
ORG=$(login "org$RUN"); CUS=$(login "cus$RUN")
check "T1 login returns token" yes "$([[ -n "$ORG" && "$ORG" != null ]] && echo yes || echo no)"
check "GET /users/me role"   customer "$(curl -s -H "Authorization: Bearer $CUS" "$USER_URL/users/me" | jq -r .role)"
check "GET /users/me no JWT -> 401" 401 "$(code "$USER_URL/users/me")"

echo "Event Service"
check "T2 customer creates event -> 403" 403 "$(code -X POST "$EVENT_URL/events" -H "Authorization: Bearer $CUS" -H 'Content-Type: application/json' -d "$EVENT")"
check "create without JWT -> 401"        401 "$(code -X POST "$EVENT_URL/events" -H 'Content-Type: application/json' -d "$EVENT")"
check "invalid body -> 400"              400 "$(code -X POST "$EVENT_URL/events" -H "Authorization: Bearer $ORG" -H 'Content-Type: application/json' -d '{"title":""}')"
ID=$(json -X POST "$EVENT_URL/events" -H "Authorization: Bearer $ORG" -d "$EVENT" | jq -r .id)
check "organizer creates event" yes "$([[ "$ID" =~ ^[0-9]+$ ]] && echo yes || echo no)"
check "GET /events/{id} available" 10 "$(curl -s "$EVENT_URL/events/$ID" | jq -r .available)"
check "GET /events lists it" yes "$(curl -s "$EVENT_URL/events" | jq -r --argjson id "$ID" 'any(.[]; .id==$id) | if . then "yes" else "no" end')"
check "GET unknown event -> 404" 404 "$(code "$EVENT_URL/events/999999999")"

# second organizer must not edit/delete someone else's event
json -X POST "$USER_URL/users/register" -d "{\"username\":\"org2$RUN\",\"password\":\"secret\",\"role\":\"organizer\"}" >/dev/null
ORG2=$(login "org2$RUN")
check "non-owner PUT -> 403"    403 "$(code -X PUT "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG2" -H 'Content-Type: application/json' -d "$EVENT")"
check "non-owner DELETE -> 403" 403 "$(code -X DELETE "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG2")"
check "owner PUT -> 200" 200 "$(code -X PUT "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG" -H 'Content-Type: application/json' -d "${EVENT/Concert/Concert v2}")"

echo "Internal reserve/release"
check "T3 reserve without service token -> 401" 401 "$(code -X POST "$EVENT_URL/events/$ID/reserve" -H 'Content-Type: application/json' -d '{"quantity":1}')"
check "reserve wrong service token -> 401"      401 "$(code -X POST "$EVENT_URL/events/$ID/reserve" -H 'X-Service-Token: wrong' -H 'Content-Type: application/json' -d '{"quantity":1}')"
check "reserve quantity 11 -> 400"              400 "$(code -X POST "$EVENT_URL/events/$ID/reserve" -H "X-Service-Token: $SERVICE_TOKEN" -H 'Content-Type: application/json' -d '{"quantity":11}')"

# T8 (event-service level): capacity 10, 50 parallel single-ticket reserves split over two replicas
RESULTS=$(for i in $(seq 50); do
  URL=$([[ $((i % 2)) -eq 0 ]] && echo "$EVENT_URL" || echo "$EVENT_URL_2")
  echo "$URL"
done | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST "{}/events/$ID/reserve" \
  -H "X-Service-Token: $SERVICE_TOKEN" -H 'Content-Type: application/json' -d '{"quantity":1}' | sort | uniq -c)
echo "$RESULTS" | sed 's/^/        /'
check "T8 exactly 10 reserves succeed" 10 "$(echo "$RESULTS" | awk '$2==200{print $1}')"
check "T8 40 reserves rejected (409)"  40 "$(echo "$RESULTS" | awk '$2==409{print $1}')"
check "T8 available = 0"                0 "$(curl -s "$EVENT_URL/events/$ID" | jq -r .available)"
check "T6 reserve on sold-out -> 409" 409 "$(code -X POST "$EVENT_URL/events/$ID/reserve" -H "X-Service-Token: $SERVICE_TOKEN" -H 'Content-Type: application/json' -d '{"quantity":1}')"

check "F9 delete with sold tickets -> 409" 409 "$(code -X DELETE "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG")"
check "shrink capacity below sold -> 409"  409 "$(code -X PUT "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG" -H 'Content-Type: application/json' -d "${EVENT/\"capacity\":10/\"capacity\":5}")"
check "release 3 -> available 3" 3 "$(json -X POST "$EVENT_URL/events/$ID/release" -H "X-Service-Token: $SERVICE_TOKEN" -d '{"quantity":3}' | jq -r .available)"
for i in 1 2 3 4; do json -X POST "$EVENT_URL/events/$ID/release" -H "X-Service-Token: $SERVICE_TOKEN" -d '{"quantity":10}' >/dev/null; done
check "release never exceeds capacity" 10 "$(curl -s "$EVENT_URL/events/$ID" | jq -r .available)"
check "owner DELETE unsold event -> 204" 204 "$(code -X DELETE "$EVENT_URL/events/$ID" -H "Authorization: Bearer $ORG")"

echo
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
