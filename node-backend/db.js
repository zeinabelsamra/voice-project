require("dotenv").config();
const sql = require("mssql");

const config = {
  server:   process.env.DB_SERVER   || "ELSAMRA-103080",
  database: process.env.DB_NAME     || "BloodBankDB",
  user:     process.env.DB_USER     || "bloodbank_user",
  password: process.env.DB_PASSWORD || "",
  options: {
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  port: parseInt(process.env.DB_PORT) || 1433,
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