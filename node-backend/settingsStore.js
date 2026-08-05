// Persists admin-editable connection settings (currently: the two SQL Server
// connections — BloodBankDB and eDelphyn) to a local JSON file, so credentials
// can be changed from the Settings page in the UI instead of hand-editing
// .env and restarting for every deployment.
//
// .env values are still used as the *first-run* defaults (see envDefaults())
// — once an admin saves via the Settings page, config/db-settings.json takes
// over as the source of truth and .env is no longer consulted for these
// fields.
const fs   = require("fs");
const path = require("path");

const CONFIG_DIR  = path.join(__dirname, "config");
const CONFIG_FILE = path.join(CONFIG_DIR, "db-settings.json");

function envDefaults() {
  return {
    bloodbank: {
      server:                 process.env.DB_SERVER   || "",
      port:                   parseInt(process.env.DB_PORT) || 1433,
      database:               process.env.DB_NAME     || "BloodBankDB",
      user:                   process.env.DB_USER     || "",
      password:               process.env.DB_PASSWORD || "",
      windowsAuth:            false,
      trustServerCertificate: true,
    },
    edelphyn: {
      server:                 process.env.EDELPHYN_DB_SERVER   || "",
      port:                   parseInt(process.env.EDELPHYN_DB_PORT) || 1433,
      database:               process.env.EDELPHYN_DB_NAME     || "eDelphyn",
      user:                   process.env.EDELPHYN_DB_USER     || "",
      password:               process.env.EDELPHYN_DB_PASSWORD || "",
      windowsAuth:            false,
      trustServerCertificate: true,
    },
  };
}

let cache = null;

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null; // missing or corrupt — fall back to .env defaults
  }
}

// Returns { bloodbank, edelphyn }. Pass { fresh: true } to bypass the
// in-memory cache and re-read the file from disk (used by "Reload & Test").
function loadSettings({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const fromFile = readFile();
  const defaults = envDefaults();
  cache = {
    bloodbank: { ...defaults.bloodbank, ...(fromFile?.bloodbank || {}) },
    edelphyn:  { ...defaults.edelphyn,  ...(fromFile?.edelphyn  || {}) },
  };
  return cache;
}

function saveSettings(next) {
  const current = loadSettings();
  const merged = {
    bloodbank: { ...current.bloodbank, ...(next.bloodbank || {}) },
    edelphyn:  { ...current.edelphyn,  ...(next.edelphyn  || {}) },
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  cache = merged;
  return merged;
}

// Converts our settings shape into the config object `mssql` expects.
function toMssqlConfig(s) {
  return {
    server:   s.server,
    database: s.database,
    user:     s.user,
    password: s.password,
    port:     parseInt(s.port) || 1433,
    options: {
      trustServerCertificate: s.trustServerCertificate !== false,
      enableArithAbort: true,
    },
  };
}

function getConnectionConfig(which) {
  return toMssqlConfig(loadSettings()[which]);
}

module.exports = { loadSettings, saveSettings, getConnectionConfig, toMssqlConfig, CONFIG_FILE };
