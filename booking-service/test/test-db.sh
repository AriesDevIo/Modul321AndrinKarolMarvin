#!/bin/sh
# Starts (or stops) a throwaway PostgreSQL for the automated tests on port 55433.
#   ./test/test-db.sh start   # before npm test
#   ./test/test-db.sh stop
set -e
NAME=booking-test-db
case "$1" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bookings_test \
      -p 55433:5432 postgres:16-alpine >/dev/null
    printf 'waiting for PostgreSQL'
    until docker exec "$NAME" pg_isready -U postgres -d bookings_test >/dev/null 2>&1; do printf '.'; sleep 1; done
    echo ' ready'
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 1
    ;;
esac
