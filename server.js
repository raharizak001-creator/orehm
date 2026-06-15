import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.BACKEND_PORT || 3001);
const DB_PATH = process.env.DB_PATH || join(dataDir, "aquasense.sqlite");
const API_KEY = process.env.API_KEY || "PqKfJBfwfsLNPdZZZTWy1RPEn7NWSqky";

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    distance_raw REAL NOT NULL,
    distance_filtered REAL NOT NULL,
    is_spike INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_readings_timestamp
  ON readings(timestamp DESC);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (device_id, timestamp, distance_raw, distance_filtered, is_spike)
  VALUES (?, ?, ?, ?, ?)
`);

const selectReadings = db.prepare(`
  SELECT id, device_id, timestamp, distance_raw, distance_filtered, is_spike
  FROM readings
  ORDER BY id DESC
  LIMIT ?
`);

const selectLatest = db.prepare(`
  SELECT id, device_id, timestamp, distance_raw, distance_filtered, is_spike
  FROM readings
  ORDER BY id DESC
  LIMIT 1
`);

const deleteReadings = db.prepare(`
  DELETE FROM readings
`);

function toApiReading(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    timestamp: row.timestamp,
    distanceRaw: row.distance_raw,
    distanceFiltered: row.distance_filtered,
    isSpike: Boolean(row.is_spike),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function numberFrom(payload, snakeName, camelName) {
  const value = payload[snakeName] ?? payload[camelName];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    console.log("Health check");
    sendJson(res, 200, { ok: true, database: DB_PATH });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/readings") {
    const requestedLimit = Number(url.searchParams.get("limit") || 300);
    const limit = Math.min(Math.max(requestedLimit || 300, 1), 1000);
    const rows = selectReadings.all(limit).reverse().map(toApiReading);
    sendJson(res, 200, rows);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/latest") {
    const row = selectLatest.get();
    sendJson(res, 200, row ? toApiReading(row) : null);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/readings") {
    const result = deleteReadings.run();
    sendJson(res, 200, { ok: true, deleted: result.changes });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/data"){
    console.log("Received POST /api/data");
    try {
      console.log("Reading JSON payload...");
      const payload = await readJson(req);
      console.log("Payload reçu:", JSON.stringify(payload));

      if (payload.api_key !== API_KEY && payload.apiKey !== API_KEY) {
        console.log("Invalid API key:", payload.api_key || payload.apiKey);
        sendJson(res, 401, { ok: false, error: "Invalid API key" });
        return;
      }

      const distanceRaw = numberFrom(payload, "distance_raw", "distanceRaw");
      const distanceFiltered = numberFrom(payload, "distance_filtered", "distanceFiltered");

      if (distanceRaw === null || distanceFiltered === null) {
        console.log("Invalid payload, missing distance values:", payload);
        sendJson(res, 400, {
          ok: false,
          error: "distance_raw and distance_filtered are required numbers",
        });
        return;
      }

      const deviceId = String(payload.device_id || payload.deviceId || "ESP32_001");
      const timestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
      const saved = insertReading.run(
        deviceId,
        timestamp.toISOString(),
        distanceRaw,
        distanceFiltered,
        payload.is_spike || payload.isSpike ? 1 : 0,
      );

      sendJson(res, 201, {
        ok: true,
        id: saved.lastInsertRowid,
      });
    } catch (error) {
      console.log("Error processing POST /api/data:", error.message);
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`aquasense backend listening on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
