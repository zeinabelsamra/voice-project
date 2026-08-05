require("dotenv").config();
const sql = require("mssql");
const { getConnectionConfig, toMssqlConfig } = require("./settingsStore");

// Connection settings now come from settingsStore (Settings page → Database
// tab), which falls back to .env on first run. See settingsStore.js.
let pool = null;

function buildConfig() {
  return {
    ...getConnectionConfig("bloodbank"),
    pool: { max: 20, min: 2, idleTimeoutMillis: 30000 },
  };
}

async function getPool() {
  if (!pool) {
    try {
      pool = await new sql.ConnectionPool(buildConfig()).connect();
      console.log("✅ Connected to BloodBankDB");
    } catch (err) {
      pool = null;
      console.error("❌ DB Connection failed:", err.message);
      throw err;
    }
  }
  return pool;
}

// Closes the live pool so the next getPool() call reconnects using whatever
// settings are current (called after Settings → Save/Reload changes creds).
async function resetPool() {
  if (pool) {
    try { await pool.close(); } catch { /* already dead — ignore */ }
    pool = null;
  }
}

// One-off connection attempt against arbitrary (not-yet-saved) settings, used
// by the Settings page's "Test Connection" button. Never touches the shared
// pool above, so a bad test can't take down the live connection.
async function testConnection(rawSettings) {
  const cfg = {
    ...toMssqlConfig(rawSettings),
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
    connectionTimeout: 8000,
    requestTimeout: 8000,
  };
  const testPool = new sql.ConnectionPool(cfg);
  try {
    await testPool.connect();
    await testPool.request().query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { await testPool.close(); } catch { /* ignore */ }
  }
}

module.exports = { getPool, resetPool, testConnection, sql };
