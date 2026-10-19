-- Mounted into /docker-entrypoint-initdb.d and run once for a fresh volume.
-- Each service owns its database; the applications create their own tables.
CREATE DATABASE users_db;
CREATE DATABASE events_db;
CREATE DATABASE bookings_db;
CREATE DATABASE payments_db;
