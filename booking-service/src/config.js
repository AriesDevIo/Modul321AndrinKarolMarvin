function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: required('JWT_SECRET'),
  serviceToken: required('SERVICE_TOKEN'),
  // Service-to-service calls go through the gateway so they get failover too.
  gatewayUrl: process.env.GATEWAY_URL || 'http://gateway/api',
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),
  db: {
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: required('DB_PASSWORD'),
    database: process.env.DB_NAME || 'bookings_db',
  },
};
