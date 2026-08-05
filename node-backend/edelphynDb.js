require("dotenv").config();
const sql = require("mssql");
const { getConnectionConfig, toMssqlConfig } = require("./settingsStore");

// Separate, read-only connection to the hospital's e-Delphyn LIS database.
// Fully independent from db.js/BloodBankDB — the voice-entry forms pool is
// never touched by anything in this file.
//
// Connection settings come from settingsStore (Settings page → Database tab
// → eDelphyn), which falls back to .env on first run. See settingsStore.js.
let pool = null;

function buildConfig() {
  return {
    ...getConnectionConfig("edelphyn"),
    pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
  };
}

// IMPORTANT: sql.connect(config) (the bare/global form) shares ONE connection
// across the whole process -- db.js uses its own ConnectionPool for
// BloodBankDB, so calling the bare form here would risk handing back that
// same connection instead of opening one to eDelphyn. new sql.ConnectionPool
// (config) creates a fully independent pool instead, which is what we
// actually want.
async function getEdelphynPool() {
  if (!pool) {
    try {
      pool = await new sql.ConnectionPool(buildConfig()).connect();
      console.log("✅ Connected to eDelphyn");
    } catch (err) {
      pool = null;
      console.error("❌ eDelphyn connection failed:", err.message);
      throw err;
    }
  }
  return pool;
}

// Closes the live pool so the next getEdelphynPool() call reconnects using
// whatever settings are current (called after Settings → Save/Reload).
async function resetEdelphynPool() {
  if (pool) {
    try { await pool.close(); } catch { /* already dead — ignore */ }
    pool = null;
  }
}

// One-off connection attempt against arbitrary (not-yet-saved) settings, used
// by the Settings page's "Test Connection" button.
async function testEdelphynConnection(rawSettings) {
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

module.exports = { getEdelphynPool, resetEdelphynPool, testEdelphynConnection, sql };
