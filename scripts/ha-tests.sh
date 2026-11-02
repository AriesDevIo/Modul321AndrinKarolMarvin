#!/bin/bash
# HA tests T9–T13 against the LernMAAS VM. Requests go from the client through the VPN,
# fault injection runs on the VM over SSH (key ~/.ssh/id_lernmaas). Creates and uses test users
# uiorg_ha*/uicust_ha*; delete them afterwards.
A=http://10.4.31.20:8080/api
J='Content-Type: application/json'
R=$RANDOM
PW=$(openssl rand -hex 8)
vm() { ssh -i ~/.ssh/id_lernmaas -o IdentitiesOnly=yes -o BatchMode=yes ubuntu@10.4.31.20 "cd ~/ticketing && $*"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
ts() { date '+%H:%M:%S'; }
avail() { curl -s --max-time 10 $A/events/$ID | jq .available; }
bookone() { code -X POST $A/bookings -H "Authorization: Bearer $CUS" -H "$J" -d "{\"eventId\":$ID,\"quantity\":1,\"paymentToken\":\"tok_ok\"}"; }

echo "== setup $(date '+%d.%m.%Y %H:%M')"
curl -s -o /dev/null -X POST $A/users/register -H "$J" -d "{\"username\":\"uiorg_ha$R\",\"password\":\"$PW\",\"role\":\"organizer\"}"
curl -s -o /dev/null -X POST $A/users/register -H "$J" -d "{\"username\":\"uicust_ha$R\",\"password\":\"$PW\",\"role\":\"customer\"}"
ORG=$(curl -s -X POST $A/users/login -H "$J" -d "{\"username\":\"uiorg_ha$R\",\"password\":\"$PW\"}" | jq -r .token)
CUS=$(curl -s -X POST $A/users/login -H "$J" -d "{\"username\":\"uicust_ha$R\",\"password\":\"$PW\"}" | jq -r .token)
ID=$(curl -s -X POST $A/events -H "Authorization: Bearer $ORG" -H "$J" -d '{"title":"HA test","description":"","venue":"VM","date":"2027-01-01T20:00:00Z","price":10,"capacity":100}' | jq .id)
echo "event $ID, available $(avail)"

echo; echo "== T9 stop one replica of every service, then book [$(ts)]"
vm docker stop user-service-1 event-service-1 booking-service-1 payment-service-1 >/dev/null
vm "docker ps --format '{{.Names}} {{.Status}}' | grep -E 'service-1' || echo 'all *-service-1 stopped'"
LOGIN=$(code -X POST $A/users/login -H "$J" -d "{\"username\":\"uicust_ha$R\",\"password\":\"$PW\"}")
echo "login: $LOGIN"
CODES=$(for i in $(seq 10); do bookone; echo; done | sort | uniq -c | tr '\n' ' ')
echo "10 bookings: $CODES | available: $(avail) (want 10 x 201, 90)"
vm docker start user-service-1 event-service-1 booking-service-1 payment-service-1 >/dev/null
echo "replicas started again [$(ts)]"

echo; echo "== T10 container process crashes (kill -9), it must restart by itself [$(ts)]"
vm "docker inspect -f 'before: {{.Name}} restarts={{.RestartCount}} status={{.State.Status}}' event-service-2"
vm 'sudo kill -9 $(docker inspect -f "{{.State.Pid}}" event-service-2)'
sleep 3
vm "docker inspect -f 'after 3 s: {{.Name}} restarts={{.RestartCount}} status={{.State.Status}}' event-service-2"
for i in $(seq 30); do H=$(vm "docker inspect -f '{{.State.Health.Status}}' event-service-2"); [ "$H" = healthy ] && break; sleep 2; done
echo "health: $H after ~$((i*2)) s"
echo "booking during/after restart: $(bookone) (want 201)"

echo; echo "== T11 both payment replicas down → 503, tickets released [$(ts)]"
vm docker stop payment-service-1 payment-service-2 >/dev/null
BEFORE=$(avail)
echo "booking: $(bookone) | available before $BEFORE, after $(avail) (want 503, unchanged)"
vm docker start payment-service-1 payment-service-2 >/dev/null
for i in $(seq 30); do H=$(vm "docker inspect -f '{{.State.Health.Status}}' payment-service-1 payment-service-2 | sort -u | tr '\n' ' '"); [ "$H" = "healthy " ] && break; sleep 2; done
echo "payment replicas healthy again; booking: $(bookone) (want 201)"

echo; echo "== T12 notifications fail → booking still CONFIRMED [$(ts)]"
NOTES_BEFORE=$(curl -s $A/notifications -H "Authorization: Bearer $CUS" | jq length)
vm "docker compose exec -T postgres psql -U postgres -d payments_db -qc 'ALTER TABLE notifications RENAME TO notifications_off'"
echo "notification endpoint now: $(code -X POST $A/notifications -H "X-Service-Token: x" -H "$J" -d '{}') (401 = token check, storing fails with 500)"
B=$(curl -s -X POST $A/bookings -H "Authorization: Bearer $CUS" -H "$J" -d "{\"eventId\":$ID,\"quantity\":1,\"paymentToken\":\"tok_ok\"}")
echo "booking: $(echo $B | jq -r .status) (want CONFIRMED)"
sleep 1
vm "docker compose exec -T postgres psql -U postgres -d payments_db -qc 'ALTER TABLE notifications_off RENAME TO notifications'"
echo "notifications before $NOTES_BEFORE, after $(curl -s $A/notifications -H "Authorization: Bearer $CUS" | jq length) (no new notification, table restored)"
vm "docker compose logs --since 1m booking-service-1 booking-service-2 2>/dev/null | grep -i 'notification' | tail -1"

echo; echo "== T13 docker compose down && up → data persists [$(ts)]"
N_BEFORE=$(curl -s $A/bookings -H "Authorization: Bearer $CUS" | jq length)
AV_BEFORE=$(avail)
vm "docker compose down 2>&1 | tail -1; docker compose up -d 2>&1 | tail -1"
for i in $(seq 60); do N=$(vm "docker compose ps --format '{{.Health}}' | grep -c '^healthy$'"); [ "$N" -ge 10 ] && break; sleep 3; done
echo "healthy containers: $N/10"
echo "bookings before $N_BEFORE, after $(curl -s $A/bookings -H "Authorization: Bearer $CUS" | jq length) | available before $AV_BEFORE, after $(avail)"

echo; echo "== final state [$(ts)]"
vm "docker compose ps --format '{{.Name}} {{.Status}}'"
