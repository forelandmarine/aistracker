import express from 'express';
import WebSocket from 'ws';
import pg from 'pg';
const { Pool } = pg;

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize database tables
async function initDatabase() {
  try {
    console.log('Connecting to database...');
    await pool.query('SELECT NOW()'); // Test connection
    console.log('Database connected successfully');
    
    await pool.query(`
    CREATE TABLE IF NOT EXISTS vessels (
    mmsi TEXT PRIMARY KEY,
    name TEXT,
    vessel_type TEXT,
    callsign TEXT,
    imo TEXT,
    flag TEXT,
    length REAL,
    width REAL,
    last_latitude REAL,
    last_longitude REAL,
    last_speed REAL,
    last_heading REAL,
    last_position_time TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
  );

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
    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

let ws;

function connectAIS() {
  console.log('Connecting to AISStream...');
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    console.log('Connected to AISStream - listening for yachts only');
    const subscription = {
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      FilterShipTypes: [36] // Type 36 = Sailing Yacht
    };
    ws.send(JSON.stringify(subscription));
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.MessageType === 'PositionReport' && msg.Message?.PositionReport) {
        const pos = msg.Message.PositionReport;
        const meta = msg.MetaData;
        
        if (meta?.MMSI && pos.Latitude && pos.Longitude) {
          // Store position
          await pool.query(
            `INSERT INTO ais_positions 
            (mmsi, vessel_name, latitude, longitude, speed, heading, course, nav_status, timestamp, message_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
            [
              String(meta.MMSI),
              meta.ShipName || null,
              pos.Latitude,
              pos.Longitude,
              pos.Sog || 0,
              pos.TrueHeading || 0,
              pos.Cog || 0,
              String(pos.NavigationalStatus || 0),
              'PositionReport'
            ]
          );

          // Update vessel
          await pool.query(
            `INSERT INTO vessels (mmsi, name, last_latitude, last_longitude, last_speed, last_heading, last_position_time, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (mmsi) DO UPDATE SET
              last_latitude = $3,
              last_longitude = $4,
              last_speed = $5,
              last_heading = $6,
              last_position_time = NOW(),
              updated_at = NOW()`,
            [
              String(meta.MMSI),
              meta.ShipName || `Vessel ${meta.MMSI}`,
              pos.Latitude,
              pos.Longitude,
              pos.Sog || 0,
              pos.TrueHeading || 0
            ]
          );
        }
      }

      if (msg.MessageType === 'ShipStaticData' && msg.Message?.ShipStaticData) {
        const ship = msg.Message.ShipStaticData;
        const meta = msg.MetaData;
        
        if (meta?.MMSI) {
          // Only store if it's a yacht type (36 = sailing yacht, 37 = motor yacht)
          const shipType = String(ship.Type || 'unknown');
          const isYacht = shipType === '36' || shipType === '37' || shipType.toLowerCase().includes('yacht');
          
          await pool.query(
            `INSERT INTO vessels (mmsi, name, callsign, imo, vessel_type, length, width, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (mmsi) DO UPDATE SET
              name = $2,
              callsign = $3,
              imo = $4,
              vessel_type = $5,
              length = $6,
              width = $7,
              updated_at = NOW()`,
            [
              String(meta.MMSI),
              ship.Name || meta.ShipName || `Vessel ${meta.MMSI}`,
              ship.CallSign || null,
              ship.ImoNumber ? String(ship.ImoNumber) : null,
              isYacht ? 'yacht' : shipType,
              (ship.Dimension?.A || 0) + (ship.Dimension?.B || 0) || null,
              (ship.Dimension?.C || 0) + (ship.Dimension?.D || 0) || null
            ]
          );
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('Disconnected from AISStream. Reconnecting immediately...');
    setTimeout(connectAIS, 100);
  });
}

// API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: ws?.readyState === WebSocket.OPEN });
});

app.get('/api/vessels', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vessels ORDER BY updated_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 500;
    const mmsi = req.query.mmsi;
    
    let query = 'SELECT * FROM ais_positions';
    let params = [];
    
    if (mmsi) {
      query += ' WHERE mmsi = $1';
      params.push(mmsi);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/positions/since', async (req, res) => {
  try {
    const since = req.query.since; // ISO timestamp
    const result = await pool.query(
      'SELECT * FROM ais_positions WHERE created_at > $1 ORDER BY timestamp DESC',
      [since]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set! Please add PostgreSQL database in Railway.');
    process.exit(1);
  }
  
  if (!process.env.AISSTREAM_API_KEY) {
    console.error('ERROR: AISSTREAM_API_KEY not set! Please add it in Railway environment variables.');
    process.exit(1);
  }
  
  try {
    await initDatabase();
    connectAIS();
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
});
