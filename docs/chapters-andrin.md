# Documentation chapters – Andrin

> Requirements · Component chapter User Service · Component chapter Event Service
> Karol merges these into the final documentation.

---

## 1. Requirements

### 1.1 Starting point

Event organizers want to sell a limited number of tickets online. Several customers may try to buy the last tickets at the same moment, and the system runs as multiple replicas. The core problem is therefore **consistency under concurrency**: an event must never be oversold, and a failure of a single instance must not take the system down.

### 1.2 Roles

| Role | Can do |
|---|---|
| Visitor (no login) | List events, see details and available tickets |
| `customer` | Book and cancel tickets, see own bookings and notifications |
| `organizer` | Create, edit and delete own events |

### 1.3 Functional requirements

| ID | Requirement | Priority | Implemented in |
|---|---|---|---|
| F1 | Users can register and log in (role `customer` or `organizer`) | Must | User Service |
| F2 | Organizers can create, edit and delete events | Must | Event Service |
| F3 | Everyone can list events and see available tickets | Must | Event Service |
| F4 | Customers can book 1–10 tickets for an event | Must | Booking Service (limit also enforced in Event Service) |
| F5 | A booking only succeeds if tickets are available and payment succeeds | Must | Booking + Event + Payment |
| F6 | Customers see their bookings with status | Must | Booking Service |
| F7 | Customers get a notification for a confirmed booking | Must | Payment & Notification |
| F8 | Customers can cancel a booking, which releases the tickets | Optional | Booking + Event (`release`) |
| F9 | Events with sold tickets can't be deleted | Optional | Event Service |
| F10 | Stuck `PENDING` bookings are cleaned up after 5 min | Optional | Booking Service |
| F11 | Web frontend | Optional | Frontend |

### 1.4 Non-functional requirements

| ID | Requirement | Priority | How it is verified |
|---|---|---|---|
| NF1 | No overselling, even with parallel requests on multiple replicas | Must | T8 |
| NF2 | Failure of one instance per service causes no outage | Must | T9 |
| NF3 | Crashed containers restart automatically | Must | T10 |
| NF4 | Passwords hashed (bcrypt); internal endpoints protected by a service token | Must | T3, code review |
| NF5 | Whole system starts with `docker compose up` on the LernMAAS VM | Must | M4 |
| NF6 | If the notification service fails, the booking still goes through | Must | T12 |
| NF7 | API documented with OpenAPI | Optional | – |
| NF8 | PostgreSQL primary/replica | Optional | – |

### 1.5 Constraints

- All components are developed from scratch (no existing ticketing software).
- Runs on Docker / Docker Compose on the LernMAAS VM.
- Interfaces between services are fixed in `docs/api.md`; changes need agreement from every affected owner.

---

## 2. Component: User Service

### 2.1 Responsibility

Registration, login and issuing JWTs. It is the only service that knows passwords. All other services only verify the JWT signature with the shared `JWT_SECRET`, so they never have to call the User Service at request time.

### 2.2 Technology

Node.js 20, Express, `pg`, `bcryptjs`, `jsonwebtoken`. Port `3000`, own database `users_db`.

### 2.3 Data model

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role          VARCHAR(16)  NOT NULL CHECK (role IN ('customer','organizer')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

The table is created by the service on startup (`CREATE TABLE IF NOT EXISTS`), so it does not depend on `db/init.sql` beyond the database itself existing.

### 2.4 Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| POST | `/users/register` | – | `201 {id, username, role}` · `400` invalid · `409` username taken |
| POST | `/users/login` | – | `200 {token}` · `401` wrong credentials |
| GET | `/users/me` | JWT | `200 {id, username, role}` · `401` |
| GET | `/health` | – | `200` · `503` if DB unreachable |

### 2.5 Design decisions

- **Password hashing:** bcrypt with cost 10. The same `401` is returned for an unknown user and a wrong password, so usernames can't be probed.
- **JWT:** HS256, payload `{ userId, username, role }`, valid 8 h. Because the token is self-contained, the services are **stateless** (HA measure 3): any replica can handle any request.
- **Race-free registration:** `INSERT … ON CONFLICT (username) DO NOTHING` together with the `UNIQUE` constraint, so two replicas registering the same name at once can't both succeed.
- **Validation:** username 3–32 chars `[a-zA-Z0-9_.-]`, password 4–72 chars (bcrypt only uses 72 bytes), role must be `customer` or `organizer`.

### 2.6 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | – (required) | Signing key, identical in all services |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DB_HOST` / `DB_PORT` | `postgres` / `5432` | Database |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `postgres` / `postgres` / `users_db` | Credentials |
| `PORT` | `3000` | HTTP port |

---

## 3. Component: Event Service

### 3.1 Responsibility

Event catalog and ticket inventory. It owns the number of available tickets per event and is the only place where that number changes, through the internal `reserve` and `release` endpoints called by the Booking Service.

### 3.2 Technology

Node.js 20, Express, `pg`, `jsonwebtoken`. Port `3000`, own database `events_db`.

### 3.3 Data model

```sql
CREATE TABLE events (
  id           SERIAL PRIMARY KEY,
  organizer_id INTEGER       NOT NULL,
  title        VARCHAR(200)  NOT NULL,
  description  TEXT          NOT NULL DEFAULT '',
  venue        VARCHAR(200)  NOT NULL,
  date         TIMESTAMPTZ   NOT NULL,
  price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  capacity     INTEGER       NOT NULL CHECK (capacity > 0),
  available    INTEGER       NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT available_in_range CHECK (available >= 0 AND available <= capacity)
);
```

`organizer_id` is the `userId` from the JWT. There is no foreign key to `users`, because each service owns its own database.

### 3.4 Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/events` | – | `200 [event]` |
| GET | `/events/{id}` | – | `200 event` · `404` |
| POST | `/events` | JWT organizer | `201 event` · `400` · `401` · `403` |
| PUT | `/events/{id}` | JWT owner | `200 event` · `403` not owner · `404` · `409` capacity below sold |
| DELETE | `/events/{id}` | JWT owner | `204` · `403` · `404` · `409` tickets sold |
| POST | `/events/{id}/reserve` | Service token | `200 {available, price}` · `400` · `401` · `404` · `409` sold out |
| POST | `/events/{id}/release` | Service token | `200 {available}` · `400` · `401` · `404` |
| GET | `/health` | – | `200` · `503` |

### 3.5 Consistency: why there is no overselling

The reservation is one atomic SQL statement:

```sql
UPDATE events SET available = available - $1
WHERE id = $2 AND available >= $1
RETURNING available, price;
```

PostgreSQL takes a row lock for the `UPDATE`. A second, parallel transaction on the same row waits, then re-evaluates the `WHERE` condition on the new value. If too few tickets are left, 0 rows are updated and the service answers `409`. Because the check and the decrement happen in the same statement inside the database, it doesn't matter how many replicas of the Event Service are running. In addition, the `CHECK (available >= 0)` constraint acts as a last safety net.

A read-then-write approach (`SELECT available` → check in JavaScript → `UPDATE`) would be wrong: two replicas could both read `available = 1` and both sell the last ticket.

### 3.6 Other design decisions

- **Release is capped:** `available = LEAST(capacity, available + $1)`. A duplicated compensation call (e.g. retry after a timeout) can never create more tickets than the capacity.
- **Editing capacity:** sold tickets (`capacity − available`) stay sold. The new capacity must be at least the sold count (otherwise `409`), and `available` is recalculated in a transaction with `SELECT … FOR UPDATE`, so a parallel reservation can't get lost.
- **Deleting (F9):** `DELETE … WHERE id = $1 AND organizer_id = $2 AND available = capacity` is atomic, so an event can't be deleted at the same moment a ticket is sold.
- **Service token:** compared with `crypto.timingSafeEqual`. Customers can't call `reserve`/`release` directly (test T3).
- **Quantity 1–10** is validated here as well, not only in the Booking Service.
- **Startup:** the service retries the DB connection for up to 60 s, so it doesn't crash if PostgreSQL starts later. `/health` returns `503` when the DB is unreachable, so the Docker healthcheck reflects the real state.
- **Gateway prefix:** routes work both with and without `/api`, so it doesn't matter whether nginx strips the prefix.

### 3.7 Configuration

Same variables as the User Service, plus `SERVICE_TOKEN` (required, identical in all services). Default `DB_NAME` is `events_db`.

---

## 4. Tests (User + Event)

`scripts/test-user-event.sh` runs 30 automated checks, including T1, T2, T3, T6 and T8 at Event Service level (50 parallel single-ticket reservations on an event with capacity 10, spread over **two replicas**):

```
             10 200
             40 409
  PASS  T8 exactly 10 reserves succeed
  PASS  T8 40 reserves rejected (409)
  PASS  T8 available = 0
...
Result: 30 passed, 0 failed
```

Run against the gateway:

```bash
SERVICE_TOKEN=<value from .env> ./scripts/test-user-event.sh
```

---

## 5. Integration notes for the team

**Marvin (compose / gateway):** both services listen on `3000`, need `JWT_SECRET`, `DB_HOST`, `DB_PASSWORD`, `DB_NAME`; the Event Service also needs `SERVICE_TOKEN`. Healthcheck is built into the Dockerfiles (`GET /health`).

```yaml
  user-service:
    build: ./user-service
    deploy: { replicas: 2 }
    restart: always
    environment:
      DB_HOST: postgres
      DB_NAME: users_db
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
    depends_on: [postgres]

  event-service:
    build: ./event-service
    deploy: { replicas: 2 }
    restart: always
    environment:
      DB_HOST: postgres
      DB_NAME: events_db
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      SERVICE_TOKEN: ${SERVICE_TOKEN}
    depends_on: [postgres]
```

**Karol (PostgreSQL / Booking):** `db/init.sql` only needs to create the databases `users_db` and `events_db`; the services create their own tables. `reserve` returns `price` per ticket, so `totalPrice = price × quantity`. On `409` the event is sold out, on `404` the event doesn't exist.
