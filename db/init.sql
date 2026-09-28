-- Runs once on first start of the PostgreSQL container
-- (mounted into /docker-entrypoint-initdb.d/).
-- Database per service: each service creates its own tables on startup.

CREATE DATABASE users_db;
CREATE DATABASE events_db;
CREATE DATABASE bookings_db;
CREATE DATABASE payments_db;
