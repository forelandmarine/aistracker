  CREATE TABLE IF NOT EXISTS ais_positions (
    id SERIAL PRIMARY KEY,
    mmsi TEXT NOT NULL,
    vessel_name TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed REAL,
    heading REAL,
    course REAL,
    nav_status TEXT,
    timestamp TIMESTAMP NOT NULL,
    message_type TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_positions_mmsi ON ais_positions(mmsi);
  CREATE INDEX IF NOT EXISTS idx_positions_timestamp ON ais_positions(timestamp DESC);
`);

let ws;
let reconnectTimeout;
const RECONNECT_DELAY = 5000;
