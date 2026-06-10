const sql = require("mssql");

const config = {
  server: "ELSAMRA-103080",
  database: "BloodBankDB",
  user: "bloodbank_user",
  password: "BloodBank123!",
  options: {
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  port: 1433,
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function getPool() {
  if (!pool) {
    try {
      pool = await sql.connect(config);
      console.log("✅ Connected to BloodBankDB");
    } catch (err) {
      console.error("❌ DB Connection failed:", err.message);
      throw err;
    }
  }
  return pool;
}

module.exports = { getPool, sql };