require("dotenv").config();

const express   = require("express");
const multer    = require("multer");
const axios     = require("axios");
const FormData  = require("form-data");
const fs        = require("fs");
const cors      = require("cors");
const path      = require("path");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const { parseVoiceToFields, splitBatchTranscript } = require("./voiceParser");

const JWT_SECRET = process.env.JWT_SECRET || "bb-hospital-secret-2024-change-in-prod";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({ dest: "uploads/" });

// ── DB (optional — won't crash if unavailable) ──────────────────
let dbReady = false;
let getPool, sql;

async function initDB() {
  try {
    const db = require("./db");
    getPool = db.getPool;
    sql = db.sql;
    const pool = await getPool();
    await pool.request().query("SELECT 1");
    dbReady = true;
    console.log("✅ Database connected");

    // ── Migrate: nurse unit columns ───────────────────────────────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='nurse_unit_received_by')
        ALTER TABLE BloodDeliveries ADD nurse_unit_received_by NVARCHAR(255) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='nurse_unit_name')
        ALTER TABLE BloodDeliveries ADD nurse_unit_name NVARCHAR(255) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='nurse_unit_date')
        ALTER TABLE BloodDeliveries ADD nurse_unit_date DATE NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='nurse_unit_time')
        ALTER TABLE BloodDeliveries ADD nurse_unit_time NVARCHAR(10) NULL;
    `);

    // ── Migrate: saved_by columns ─────────────────────────────────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='saved_by')
        ALTER TABLE TransfusionRequests ADD saved_by NVARCHAR(100) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='saved_by')
        ALTER TABLE BloodDeliveries ADD saved_by NVARCHAR(100) NULL;
    `);

    // ── Migrate: Users table ──────────────────────────────────────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='HospitalUsers')
        CREATE TABLE HospitalUsers (
          user_id    INT IDENTITY(1,1) PRIMARY KEY,
          username   NVARCHAR(50)  UNIQUE NOT NULL,
          full_name  NVARCHAR(100) NOT NULL,
          password_hash NVARCHAR(255) NOT NULL,
          role       NVARCHAR(10)  NOT NULL DEFAULT 'staff',
          active     BIT           NOT NULL DEFAULT 1,
          created_at DATETIME      DEFAULT GETDATE()
        );
    `);

    // ── Seed default admin if no users exist ─────────────────────
    const userCount = await pool.request().query("SELECT COUNT(*) AS cnt FROM HospitalUsers");
    if (userCount.recordset[0].cnt === 0) {
      const hash = await bcrypt.hash("admin123", 10);
      await pool.request()
        .input("username",  sql.NVarChar, "admin")
        .input("full_name", sql.NVarChar, "Administrator")
        .input("hash",      sql.NVarChar, hash)
        .input("role",      sql.NVarChar, "admin")
        .query("INSERT INTO HospitalUsers (username, full_name, password_hash, role) VALUES (@username, @full_name, @hash, @role)");
      console.log("✅ Default admin created — username: admin  password: admin123");
    }

    // ── Migrate: ExternalDeliveries table ────────────────────────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ExternalDeliveries')
        CREATE TABLE ExternalDeliveries (
          delivery_id       INT IDENTITY(1,1) PRIMARY KEY,
          patient_name      NVARCHAR(255) NULL,
          destination       NVARCHAR(255) NULL,
          delivery_date     DATE          NULL,
          delivery_hour     NVARCHAR(10)  NULL,
          technician_name   NVARCHAR(255) NULL,
          frbc_unit_no      NVARCHAR(100) NULL,
          frbc_blood_group  NVARCHAR(20)  NULL,
          frbc_expiry_date  DATE          NULL,
          frbc_notes        NVARCHAR(255) NULL,
          ffp_unit_no       NVARCHAR(100) NULL,
          ffp_blood_group   NVARCHAR(20)  NULL,
          ffp_expiry_date   DATE          NULL,
          ffp_notes         NVARCHAR(255) NULL,
          plt_unit_no       NVARCHAR(100) NULL,
          plt_blood_group   NVARCHAR(20)  NULL,
          plt_expiry_date   DATE          NULL,
          plt_notes         NVARCHAR(255) NULL,
          other1_component  NVARCHAR(100) NULL,
          other1_unit_no    NVARCHAR(100) NULL,
          other1_blood_group NVARCHAR(20) NULL,
          other1_expiry_date DATE         NULL,
          other1_notes      NVARCHAR(255) NULL,
          other2_component  NVARCHAR(100) NULL,
          other2_unit_no    NVARCHAR(100) NULL,
          other2_blood_group NVARCHAR(20) NULL,
          other2_expiry_date DATE         NULL,
          other2_notes      NVARCHAR(255) NULL,
          test_hiv          BIT           DEFAULT 0,
          test_hbsag        BIT           DEFAULT 0,
          test_hcv          BIT           DEFAULT 0,
          test_hb_core      BIT           DEFAULT 0,
          test_sts          BIT           DEFAULT 0,
          test_iat          BIT           DEFAULT 0,
          test_kell         BIT           DEFAULT 0,
          integrity         NVARCHAR(3)   NULL,
          saved_by          NVARCHAR(100) NULL,
          created_at        DATETIME      DEFAULT GETDATE()
        );
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ExternalDeliveries' AND COLUMN_NAME='components_json')
        ALTER TABLE ExternalDeliveries ADD components_json NVARCHAR(MAX) NULL;
    `);

    console.log("✅ Schema up to date");

  } catch (err) {
    dbReady = false;
    console.warn("⚠️  Database not available — voice extraction will still work, saving disabled");
  }
}
initDB();

// ════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ════════════════════════════════════════════════════════════════
// POST /auth/login
// ════════════════════════════════════════════════════════════════
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!dbReady) return res.status(503).json({ error: 'Database not connected' });
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('username', sql.NVarChar, username.trim().toLowerCase())
      .query("SELECT * FROM HospitalUsers WHERE LOWER(username)=@username AND active=1");
    const user = result.recordset[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign(
      { userId: user.user_id, username: user.username, fullName: user.full_name, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, user: { userId: user.user_id, username: user.username, fullName: user.full_name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /users  (admin only)
// ════════════════════════════════════════════════════════════════
app.get('/users', requireAdmin, async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(
      "SELECT user_id, username, full_name, role, active, CONVERT(VARCHAR(19), created_at, 120) AS created_at FROM HospitalUsers ORDER BY created_at"
    );
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /users  (admin only) — create user
// ════════════════════════════════════════════════════════════════
app.post('/users', requireAdmin, async (req, res) => {
  const { username, full_name, password, role } = req.body;
  if (!username || !full_name || !password) return res.status(400).json({ error: 'username, full_name and password are required' });
  const validRole = (role === 'admin' || role === 'staff') ? role : 'staff';
  try {
    const pool = await getPool();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.request()
      .input('username',  sql.NVarChar, username.trim().toLowerCase())
      .input('full_name', sql.NVarChar, full_name.trim())
      .input('hash',      sql.NVarChar, hash)
      .input('role',      sql.NVarChar, validRole)
      .query("INSERT INTO HospitalUsers (username, full_name, password_hash, role) OUTPUT INSERTED.user_id VALUES (@username, @full_name, @hash, @role)");
    res.json({ success: true, user_id: result.recordset[0].user_id });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// PUT /users/:id  (admin only) — update name, role, active
// ════════════════════════════════════════════════════════════════
app.put('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { full_name, role, active } = req.body;
  // Prevent admin from deactivating their own account
  if (parseInt(id) === req.user.userId && active === false) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',        sql.Int,      parseInt(id))
      .input('full_name', sql.NVarChar, full_name)
      .input('role',      sql.NVarChar, role === 'admin' ? 'admin' : 'staff')
      .input('active',    sql.Bit,      active ? 1 : 0)
      .query("UPDATE HospitalUsers SET full_name=@full_name, role=@role, active=@active WHERE user_id=@id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// PUT /users/:id/password  (admin only) — reset password
// ════════════════════════════════════════════════════════════════
app.put('/users/:id/password', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const pool = await getPool();
    const hash = await bcrypt.hash(password, 10);
    await pool.request()
      .input('id',   sql.Int,      parseInt(id))
      .input('hash', sql.NVarChar, hash)
      .query("UPDATE HospitalUsers SET password_hash=@hash WHERE user_id=@id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /upload  — transcribe → extract fields → (optional) log
// ════════════════════════════════════════════════════════════════
app.post("/upload", requireAuth, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file received" });
  const formType = req.body.form_type || "both";

  try {
    // 1. Transcribe with Whisper
    const formData = new FormData();
    formData.append("audio", fs.createReadStream(req.file.path), {
      filename: "recording.webm",
      contentType: "audio/webm",
    });

    const whisperRes = await axios.post("http://localhost:5001/transcribe", formData, {
      headers: formData.getHeaders(),
      timeout: 300000,
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const { text, language, word_count } = whisperRes.data;

    if (!text || text === "No speech detected") {
      return res.json({ text, language, word_count, fields: {} });
    }

    // 2. Rule-based field extraction
    const { fields: extractedFields, method } = await parseVoiceToFields(text, formType);

    // 3. Log to DB only if available — never block on failure
    if (dbReady && Object.keys(extractedFields).length > 0) {
      try {
        const pool = await getPool();
        for (const [fieldName, extractedValue] of Object.entries(extractedFields)) {
          await pool.request()
            .input("form_type",         sql.NVarChar, formType)
            .input("field_name",        sql.NVarChar, fieldName)
            .input("raw_text",          sql.NVarChar, text)
            .input("extracted_value",   sql.NVarChar, String(extractedValue))
            .input("language",          sql.NVarChar, language)
            .input("word_count",        sql.Int,      word_count)
            .input("extraction_method", sql.NVarChar, method)
            .query(`INSERT INTO VoiceTranscriptions
              (form_type, field_name, raw_text, extracted_value, language, word_count, extraction_method)
              VALUES (@form_type, @field_name, @raw_text, @extracted_value, @language, @word_count, @extraction_method)`);
        }
      } catch (dbErr) {
        console.warn("⚠️ DB log failed (non-fatal):", dbErr.message);
      }
    }

    res.json({ text, language, word_count, fields: extractedFields, method });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("Upload error:", err.message);
    if (err.code === "ECONNREFUSED") {
      return res.status(503).json({ error: "Python Whisper service not running. Start whisper_service.py first." });
    }
    res.status(500).json({ error: err.message });
  }
});


// ════════════════════════════════════════════════════════════════
// POST /upload/batch  — transcribe once → split → parse all segments
// ════════════════════════════════════════════════════════════════
app.post("/upload/batch", requireAuth, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file received" });
  const globalFormType = req.body.form_type || "transfusion";

  try {
    // 1. Transcribe with Whisper
    const formData = new FormData();
    formData.append("audio", fs.createReadStream(req.file.path), {
      filename: "recording.webm",
      contentType: "audio/webm",
    });

    const whisperRes = await axios.post("http://localhost:5001/transcribe", formData, {
      headers: formData.getHeaders(),
      timeout: 300000,
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const { text, language, word_count } = whisperRes.data;

    if (!text || text === "No speech detected") {
      return res.json({ text, language, word_count, patients: [] });
    }

    // 2. Split transcript into patient segments
    const segments = splitBatchTranscript(text, globalFormType);

    // If no split triggers found — treat whole thing as single patient
    if (segments.length === 0) {
      const { fields, method } = await parseVoiceToFields(text, globalFormType);
      return res.json({
        text, language, word_count,
        patients: [{ index: 1, rawText: text, formType: globalFormType, fields, method }]
      });
    }

    // 3. Parse each segment independently
    const patients = [];
    for (const seg of segments) {
      const { fields, method } = await parseVoiceToFields(seg.rawText, seg.detectedFormType);
      patients.push({
        index:    seg.index,
        rawText:  seg.rawText,
        formType: seg.detectedFormType,
        fields,
        method,
      });
    }

    // 4. Log to DB if available
    if (dbReady) {
      try {
        const pool = await getPool();
        for (const p of patients) {
          for (const [fieldName, extractedValue] of Object.entries(p.fields)) {
            await pool.request()
              .input("form_type",         sql.NVarChar, p.formType)
              .input("field_name",        sql.NVarChar, fieldName)
              .input("raw_text",          sql.NVarChar, p.rawText)
              .input("extracted_value",   sql.NVarChar, String(extractedValue))
              .input("language",          sql.NVarChar, language)
              .input("word_count",        sql.Int,      word_count)
              .input("extraction_method", sql.NVarChar, p.method)
              .query(`INSERT INTO VoiceTranscriptions
                (form_type, field_name, raw_text, extracted_value, language, word_count, extraction_method)
                VALUES (@form_type, @field_name, @raw_text, @extracted_value, @language, @word_count, @extraction_method)`);
          }
        }
      } catch (dbErr) {
        console.warn("⚠️ DB log failed (non-fatal):", dbErr.message);
      }
    }

    res.json({ text, language, word_count, patients });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("Batch upload error:", err.message);
    if (err.code === "ECONNREFUSED") {
      return res.status(503).json({ error: "Python Whisper service not running." });
    }
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /forms/save
// ════════════════════════════════════════════════════════════════
app.post("/forms/save", requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "Database not connected. Check db.js configuration." });

  const { form_type, ...fields } = req.body;

  try {
    const pool = await getPool();

    if (form_type === "transfusion") {
      const result = await pool.request()
        .input("request_date",              sql.Date,     fields.request_date || null)
        .input("request_time",              sql.NVarChar, fields.request_time || null)
        .input("room",                      sql.NVarChar, fields.room || null)
        .input("patient_name",              sql.NVarChar, fields.patient_name || null)
        .input("file_number",               sql.NVarChar, fields.file_number || null)
        .input("blood_group",               sql.NVarChar, fields.blood_group || null)
        .input("rh_factor",                 sql.NVarChar, fields.rh_factor || null)
        .input("diagnosis",                 sql.NVarChar, fields.diagnosis || null)
        .input("fpc_units",                 sql.Int,      parseInt(fields.fpc_units) || null)
        .input("fpc_type",                  sql.NVarChar, fields.fpc_type || null)
        .input("ffp_units",                 sql.Int,      parseInt(fields.ffp_units) || null)
        .input("ffp_type",                  sql.NVarChar, fields.ffp_type || null)
        .input("plt_units",                 sql.Int,      parseInt(fields.plt_units) || null)
        .input("plt_type",                  sql.NVarChar, fields.plt_type || null)
        .input("blood_unit_1",              sql.NVarChar, fields.blood_unit_1 || null)
        .input("blood_unit_2",              sql.NVarChar, fields.blood_unit_2 || null)
        .input("blood_unit_3",              sql.NVarChar, fields.blood_unit_3 || null)
        .input("blood_unit_4",              sql.NVarChar, fields.blood_unit_4 || null)
        .input("blood_unit_5",              sql.NVarChar, fields.blood_unit_5 || null)
        .input("blood_unit_6",              sql.NVarChar, fields.blood_unit_6 || null)
        .input("blood_unit_7",              sql.NVarChar, fields.blood_unit_7 || null)
        .input("blood_unit_8",              sql.NVarChar, fields.blood_unit_8 || null)
        .input("previous_transfusion",      sql.Bit,      fields.previous_transfusion === true || fields.previous_transfusion === 'true' ? 1 : 0)
        .input("prev_transfusion_place",    sql.NVarChar, fields.prev_transfusion_place || null)
        .input("prev_transfusion_reaction", sql.NVarChar, fields.prev_transfusion_reaction || null)
        .input("physician",                 sql.NVarChar, fields.physician || null)
        .input("phlebotomist",              sql.NVarChar, fields.phlebotomist || null)
        .input("life_saving",               sql.Bit,      fields.life_saving_t ? 1 : 0)
        .input("life_saving_physician",     sql.NVarChar, fields.ls_physician_t || null)
        .input("life_saving_time",          sql.NVarChar, fields.ls_time_t || null)
        .input("saved_by",                  sql.NVarChar, req.user?.fullName || null)
        .query(`INSERT INTO TransfusionRequests (
          request_date, request_time, room, patient_name, file_number,
          blood_group, rh_factor, diagnosis,
          fpc_units, fpc_type, ffp_units, ffp_type, plt_units, plt_type,
          blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
          blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
          previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
          physician, phlebotomist,
          life_saving, life_saving_physician, life_saving_time,
          saved_by
        ) OUTPUT INSERTED.request_id
        VALUES (
          @request_date, @request_time, @room, @patient_name, @file_number,
          @blood_group, @rh_factor, @diagnosis,
          @fpc_units, @fpc_type, @ffp_units, @ffp_type, @plt_units, @plt_type,
          @blood_unit_1, @blood_unit_2, @blood_unit_3, @blood_unit_4,
          @blood_unit_5, @blood_unit_6, @blood_unit_7, @blood_unit_8,
          @previous_transfusion, @prev_transfusion_place, @prev_transfusion_reaction,
          @physician, @phlebotomist,
          @life_saving, @life_saving_physician, @life_saving_time,
          @saved_by
        )`);

      return res.json({ success: true, id: result.recordset[0].request_id });

    } else if (form_type === "delivery") {
      const result = await pool.request()
        .input("patient_name",                sql.NVarChar, fields.d_patient_name || null)
        .input("file_number",                 sql.NVarChar, fields.d_file_number || null)
        .input("patient_blood_group",         sql.NVarChar, fields.d_blood_group || null)
        .input("patient_rh",                  sql.NVarChar, fields.d_rh || null)
        .input("room",                        sql.NVarChar, fields.d_room || null)
        .input("known_allergies",             sql.NVarChar, fields.allergy_details || null)
        .input("type_of_blood_requested",     sql.NVarChar, fields.blood_type_requested || null)
        .input("blood_unit_numbers",          sql.NVarChar, fields.blood_unit_numbers || null)
        .input("type_of_blood",               sql.NVarChar, fields.type_of_blood || null)
        .input("blood_unit_group",            sql.NVarChar, fields.blood_unit_group || null)
        .input("patient_blood_group_delivery",sql.NVarChar, fields.patient_bg_delivery || null)
        .input("technician_name",             sql.NVarChar, fields.technician || null)
        .input("orderly_name",                sql.NVarChar, fields.orderly || null)
        .input("nurse_name",                  sql.NVarChar, fields.nurse || null)
        .input("delivery_date",               sql.Date,     fields.delivery_date || null)
        .input("delivery_time",               sql.NVarChar, fields.delivery_time || null)
        .input("leakage",                     sql.NVarChar, fields.leakage || null)
        .input("gases",                       sql.NVarChar, fields.gases || null)
        .input("volume",                      sql.NVarChar, fields.volume || null)
        .input("expiry_date",                 sql.Date,     fields.expiry_date || null)
        .input("temperature_c",               sql.Float,    parseFloat(fields.temperature) || null)
        .input("received_by",                 sql.NVarChar, fields.received_by || null)
        .input("nurse_unit_received_by",      sql.NVarChar, fields.nurse_received_by || null)
        .input("nurse_unit_name",             sql.NVarChar, fields.nurse_name || null)
        .input("nurse_unit_date",             sql.Date,     fields.nurse_date || null)
        .input("nurse_unit_time",             sql.NVarChar, fields.nurse_time || null)
        .input("life_saving",                 sql.Bit,      fields.life_saving_d ? 1 : 0)
        .input("life_saving_physician",       sql.NVarChar, fields.ls_physician_d || null)
        .input("life_saving_time",            sql.NVarChar, fields.ls_time_d || null)
        .input("saved_by",                    sql.NVarChar, req.user?.fullName || null)
        .query(`INSERT INTO BloodDeliveries (
          patient_name, file_number, patient_blood_group, patient_rh, room,
          known_allergies, type_of_blood_requested, blood_unit_numbers,
          type_of_blood, blood_unit_group, patient_blood_group_delivery,
          technician_name, orderly_name, nurse_name,
          delivery_date, delivery_time,
          leakage, gases, volume, expiry_date, temperature_c,
          received_by, nurse_unit_received_by, nurse_unit_name, nurse_unit_date, nurse_unit_time,
          life_saving, life_saving_physician, life_saving_time,
          saved_by
        ) OUTPUT INSERTED.delivery_id
        VALUES (
          @patient_name, @file_number, @patient_blood_group, @patient_rh, @room,
          @known_allergies, @type_of_blood_requested, @blood_unit_numbers,
          @type_of_blood, @blood_unit_group, @patient_blood_group_delivery,
          @technician_name, @orderly_name, @nurse_name,
          @delivery_date, @delivery_time,
          @leakage, @gases, @volume, @expiry_date, @temperature_c,
          @received_by, @nurse_unit_received_by, @nurse_unit_name, @nurse_unit_date, @nurse_unit_time,
          @life_saving, @life_saving_physician, @life_saving_time,
          @saved_by
        )`);

      return res.json({ success: true, id: result.recordset[0].delivery_id });
    }

    res.status(400).json({ error: "Invalid form_type" });

  } catch (err) {
    console.error("Save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /history
// ════════════════════════════════════════════════════════════════
app.get("/history", requireAuth, async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const pool = await getPool();

    const transfusions = await pool.request().query(`
      SELECT TOP 20
        request_id    AS id,
        'transfusion' AS form_type,
        patient_name, diagnosis, blood_group, rh_factor, file_number, room,
        fpc_units, fpc_type, ffp_units, ffp_type, plt_units, plt_type,
        blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
        blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
        previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
        physician, phlebotomist,
        request_date, request_time,
        life_saving, life_saving_physician, life_saving_time,
        saved_by,
        CONVERT(VARCHAR(19), created_at, 120) AS created_at
      FROM TransfusionRequests
      ORDER BY created_at DESC
    `);

    const deliveries = await pool.request().query(`
      SELECT TOP 20
        delivery_id  AS id,
        'delivery'   AS form_type,
        patient_name, file_number,
        patient_blood_group     AS blood_group,
        patient_rh              AS rh_factor,
        room,
        known_allergies         AS allergy_details,
        type_of_blood_requested,
        blood_unit_numbers,
        type_of_blood,
        blood_unit_group,
        patient_blood_group_delivery,
        technician_name         AS technician,
        orderly_name            AS orderly,
        nurse_name              AS nurse,
        delivery_date, delivery_time,
        leakage, gases, volume, expiry_date,
        temperature_c           AS temperature,
        received_by,
        nurse_unit_received_by, nurse_unit_name,
        nurse_unit_date, nurse_unit_time,
        life_saving, life_saving_physician, life_saving_time,
        saved_by,
        CONVERT(VARCHAR(19), created_at, 120) AS created_at
      FROM BloodDeliveries
      ORDER BY created_at DESC
    `);

    const combined = [...transfusions.recordset, ...deliveries.recordset]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 30);

    res.json(combined);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /history/:id
// ════════════════════════════════════════════════════════════════
app.delete("/history/:id", requireAdmin, async (req, res) => {
  if (!dbReady) return res.json({ success: false });
  const { id } = req.params;
  const { form_type } = req.query;
  try {
    const pool = await getPool();
    if (form_type === "transfusion")
      await pool.request().input("id", sql.Int, id).query("DELETE FROM TransfusionRequests WHERE request_id = @id");
    else if (form_type === "delivery")
      await pool.request().input("id", sql.Int, id).query("DELETE FROM BloodDeliveries WHERE delivery_id = @id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// PUT /forms/update/:id
// ════════════════════════════════════════════════════════════════
app.put("/forms/update/:id", requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "Database not connected." });
  const { id } = req.params;
  const { form_type, ...fields } = req.body;

  try {
    const pool = await getPool();

    if (form_type === "transfusion") {
      await pool.request()
        .input("id",                         sql.Int,      parseInt(id))
        .input("request_date",               sql.Date,     fields.request_date || null)
        .input("request_time",               sql.NVarChar, fields.request_time || null)
        .input("room",                       sql.NVarChar, fields.room || null)
        .input("patient_name",               sql.NVarChar, fields.patient_name || null)
        .input("file_number",                sql.NVarChar, fields.file_number || null)
        .input("blood_group",                sql.NVarChar, fields.blood_group || null)
        .input("rh_factor",                  sql.NVarChar, fields.rh_factor || null)
        .input("diagnosis",                  sql.NVarChar, fields.diagnosis || null)
        .input("fpc_units",                  sql.Int,      parseInt(fields.fpc_units) || null)
        .input("fpc_type",                   sql.NVarChar, fields.fpc_type || null)
        .input("ffp_units",                  sql.Int,      parseInt(fields.ffp_units) || null)
        .input("ffp_type",                   sql.NVarChar, fields.ffp_type || null)
        .input("plt_units",                  sql.Int,      parseInt(fields.plt_units) || null)
        .input("plt_type",                   sql.NVarChar, fields.plt_type || null)
        .input("blood_unit_1",               sql.NVarChar, fields.blood_unit_1 || null)
        .input("blood_unit_2",               sql.NVarChar, fields.blood_unit_2 || null)
        .input("blood_unit_3",               sql.NVarChar, fields.blood_unit_3 || null)
        .input("blood_unit_4",               sql.NVarChar, fields.blood_unit_4 || null)
        .input("blood_unit_5",               sql.NVarChar, fields.blood_unit_5 || null)
        .input("blood_unit_6",               sql.NVarChar, fields.blood_unit_6 || null)
        .input("blood_unit_7",               sql.NVarChar, fields.blood_unit_7 || null)
        .input("blood_unit_8",               sql.NVarChar, fields.blood_unit_8 || null)
        .input("previous_transfusion",       sql.Bit,      fields.previous_transfusion === true || fields.previous_transfusion === 'true' ? 1 : 0)
        .input("prev_transfusion_place",     sql.NVarChar, fields.prev_transfusion_place || null)
        .input("prev_transfusion_reaction",  sql.NVarChar, fields.prev_transfusion_reaction || null)
        .input("physician",                  sql.NVarChar, fields.physician || null)
        .input("phlebotomist",               sql.NVarChar, fields.phlebotomist || null)
        .input("life_saving",                sql.Bit,      fields.life_saving_t ? 1 : 0)
        .input("life_saving_physician",      sql.NVarChar, fields.ls_physician_t || null)
        .input("life_saving_time",           sql.NVarChar, fields.ls_time_t || null)
        .query(`UPDATE TransfusionRequests SET
          request_date=@request_date, request_time=@request_time, room=@room,
          patient_name=@patient_name, file_number=@file_number,
          blood_group=@blood_group, rh_factor=@rh_factor, diagnosis=@diagnosis,
          fpc_units=@fpc_units, fpc_type=@fpc_type,
          ffp_units=@ffp_units, ffp_type=@ffp_type,
          plt_units=@plt_units, plt_type=@plt_type,
          blood_unit_1=@blood_unit_1, blood_unit_2=@blood_unit_2,
          blood_unit_3=@blood_unit_3, blood_unit_4=@blood_unit_4,
          blood_unit_5=@blood_unit_5, blood_unit_6=@blood_unit_6,
          blood_unit_7=@blood_unit_7, blood_unit_8=@blood_unit_8,
          previous_transfusion=@previous_transfusion,
          prev_transfusion_place=@prev_transfusion_place,
          prev_transfusion_reaction=@prev_transfusion_reaction,
          physician=@physician, phlebotomist=@phlebotomist,
          life_saving=@life_saving,
          life_saving_physician=@life_saving_physician,
          life_saving_time=@life_saving_time
        WHERE request_id=@id`);

      return res.json({ success: true });

    } else if (form_type === "delivery") {
      await pool.request()
        .input("id",                          sql.Int,      parseInt(id))
        .input("patient_name",                sql.NVarChar, fields.d_patient_name || null)
        .input("file_number",                 sql.NVarChar, fields.d_file_number || null)
        .input("patient_blood_group",         sql.NVarChar, fields.d_blood_group || null)
        .input("patient_rh",                  sql.NVarChar, fields.d_rh || null)
        .input("room",                        sql.NVarChar, fields.d_room || null)
        .input("known_allergies",             sql.NVarChar, fields.allergy_details || null)
        .input("type_of_blood_requested",     sql.NVarChar, fields.blood_type_requested || null)
        .input("blood_unit_numbers",          sql.NVarChar, fields.blood_unit_numbers || null)
        .input("type_of_blood",               sql.NVarChar, fields.type_of_blood || null)
        .input("blood_unit_group",            sql.NVarChar, fields.blood_unit_group || null)
        .input("patient_blood_group_delivery",sql.NVarChar, fields.patient_bg_delivery || null)
        .input("technician_name",             sql.NVarChar, fields.technician || null)
        .input("orderly_name",                sql.NVarChar, fields.orderly || null)
        .input("nurse_name",                  sql.NVarChar, fields.nurse || null)
        .input("delivery_date",               sql.Date,     fields.delivery_date || null)
        .input("delivery_time",               sql.NVarChar, fields.delivery_time || null)
        .input("leakage",                     sql.NVarChar, fields.leakage || null)
        .input("gases",                       sql.NVarChar, fields.gases || null)
        .input("volume",                      sql.NVarChar, fields.volume || null)
        .input("expiry_date",                 sql.Date,     fields.expiry_date || null)
        .input("temperature_c",               sql.Float,    parseFloat(fields.temperature) || null)
        .input("received_by",                 sql.NVarChar, fields.received_by || null)
        .input("nurse_unit_received_by",      sql.NVarChar, fields.nurse_received_by || null)
        .input("nurse_unit_name",             sql.NVarChar, fields.nurse_name || null)
        .input("nurse_unit_date",             sql.Date,     fields.nurse_date || null)
        .input("nurse_unit_time",             sql.NVarChar, fields.nurse_time || null)
        .input("life_saving",                 sql.Bit,      fields.life_saving_d ? 1 : 0)
        .input("life_saving_physician",       sql.NVarChar, fields.ls_physician_d || null)
        .input("life_saving_time",            sql.NVarChar, fields.ls_time_d || null)
        .query(`UPDATE BloodDeliveries SET
          patient_name=@patient_name, file_number=@file_number,
          patient_blood_group=@patient_blood_group, patient_rh=@patient_rh, room=@room,
          known_allergies=@known_allergies,
          type_of_blood_requested=@type_of_blood_requested,
          blood_unit_numbers=@blood_unit_numbers,
          type_of_blood=@type_of_blood,
          blood_unit_group=@blood_unit_group,
          patient_blood_group_delivery=@patient_blood_group_delivery,
          technician_name=@technician_name, orderly_name=@orderly_name, nurse_name=@nurse_name,
          delivery_date=@delivery_date, delivery_time=@delivery_time,
          leakage=@leakage, gases=@gases, volume=@volume,
          expiry_date=@expiry_date, temperature_c=@temperature_c,
          received_by=@received_by,
          nurse_unit_received_by=@nurse_unit_received_by,
          nurse_unit_name=@nurse_unit_name,
          nurse_unit_date=@nurse_unit_date,
          nurse_unit_time=@nurse_unit_time,
          life_saving=@life_saving,
          life_saving_physician=@life_saving_physician,
          life_saving_time=@life_saving_time
        WHERE delivery_id=@id`);

      return res.json({ success: true });
    }

    res.status(400).json({ error: "Invalid form_type" });

  } catch (err) {
    console.error("Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /dashboard/stats
// ════════════════════════════════════════════════════════════════
app.get('/dashboard/stats', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ error: 'db_not_ready' });
  try {
    const pool = await getPool();

    // ── Counts: today / week / month ─────────────────────────
    const counts = await pool.request().query(`
      SELECT
        SUM(CASE WHEN src='t' AND CAST(created_at AS DATE)=CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS t_today,
        SUM(CASE WHEN src='t' AND created_at >= DATEADD(day,-7,GETDATE())  THEN 1 ELSE 0 END) AS t_week,
        SUM(CASE WHEN src='t' AND created_at >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS t_month,
        SUM(CASE WHEN src='d' AND CAST(created_at AS DATE)=CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS d_today,
        SUM(CASE WHEN src='d' AND created_at >= DATEADD(day,-7,GETDATE())  THEN 1 ELSE 0 END) AS d_week,
        SUM(CASE WHEN src='d' AND created_at >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS d_month,
        SUM(CASE WHEN life_saving=1 AND created_at >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS life_saving_month
      FROM (
        SELECT 't' AS src, created_at, life_saving FROM TransfusionRequests
        UNION ALL
        SELECT 'd' AS src, created_at, life_saving FROM BloodDeliveries
      ) x
    `);

    // ── Blood group distribution (last 30 days, both tables) ─
    const bgRows = await pool.request().query(`
      SELECT blood_group, COUNT(*) AS cnt FROM (
        SELECT blood_group FROM TransfusionRequests
          WHERE blood_group IS NOT NULL AND blood_group <> ''
            AND created_at >= DATEADD(day,-30,GETDATE())
        UNION ALL
        SELECT patient_blood_group AS blood_group FROM BloodDeliveries
          WHERE patient_blood_group IS NOT NULL AND patient_blood_group <> ''
            AND created_at >= DATEADD(day,-30,GETDATE())
      ) x
      GROUP BY blood_group ORDER BY cnt DESC
    `);

    // ── Daily activity last 7 days ────────────────────────────
    const daily = await pool.request().query(`
      SELECT
        CONVERT(NVARCHAR,day,23) AS date,
        SUM(t) AS transfusions,
        SUM(d) AS deliveries
      FROM (
        SELECT CAST(created_at AS DATE) AS day, 1 AS t, 0 AS d FROM TransfusionRequests
          WHERE created_at >= DATEADD(day,-6,CAST(GETDATE() AS DATE))
        UNION ALL
        SELECT CAST(created_at AS DATE) AS day, 0 AS t, 1 AS d FROM BloodDeliveries
          WHERE created_at >= DATEADD(day,-6,CAST(GETDATE() AS DATE))
      ) x
      GROUP BY day ORDER BY day ASC
    `);

    // ── Recent 10 records ─────────────────────────────────────
    const recent = await pool.request().query(`
      SELECT TOP 10 * FROM (
        SELECT 'transfusion' AS form_type, patient_name, blood_group, rh_factor,
          room, physician AS staff,
          CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM TransfusionRequests
        UNION ALL
        SELECT 'delivery' AS form_type, patient_name, patient_blood_group AS blood_group,
          patient_rh AS rh_factor, room, technician_name AS staff,
          CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM BloodDeliveries
      ) x ORDER BY created_at DESC
    `);

    const c = counts.recordset[0];
    res.json({
      today:            { transfusions: c.t_today, deliveries: c.d_today },
      week:             { transfusions: c.t_week,  deliveries: c.d_week  },
      month:            { transfusions: c.t_month, deliveries: c.d_month },
      lifeSavingMonth:  c.life_saving_month,
      bloodGroups:      bgRows.recordset,
      dailyActivity:    daily.recordset,
      recent:           recent.recordset,
    });

  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /check-duplicate?file_number=xxx&form_type=transfusion
// Checks if a record for this patient already exists today
// ════════════════════════════════════════════════════════════════
app.get('/check-duplicate', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ duplicate: false });
  const { file_number, form_type } = req.query;
  if (!file_number || !form_type) return res.json({ duplicate: false });

  try {
    const pool = await getPool();
    let result;

    if (form_type === 'transfusion') {
      result = await pool.request()
        .input('fn', sql.NVarChar, file_number.trim())
        .query(`SELECT TOP 1 patient_name,
                  CONVERT(VARCHAR(19), created_at, 120) AS created_at
                FROM TransfusionRequests
                WHERE file_number = @fn
                  AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)
                ORDER BY created_at DESC`);
    } else {
      result = await pool.request()
        .input('fn', sql.NVarChar, file_number.trim())
        .query(`SELECT TOP 1 patient_name,
                  CONVERT(VARCHAR(19), created_at, 120) AS created_at
                FROM BloodDeliveries
                WHERE file_number = @fn
                  AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)
                ORDER BY created_at DESC`);
    }

    if (!result.recordset.length) return res.json({ duplicate: false });

    const r = result.recordset[0];
    res.json({
      duplicate:    true,
      patient_name: r.patient_name,
      saved_at:     r.created_at,
    });

  } catch (err) {
    res.status(500).json({ duplicate: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /patient/lookup?file_number=xxx
// Returns the most recent patient info for a given file number
// ════════════════════════════════════════════════════════════════
app.get('/patient/lookup', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ found: false });
  const { file_number } = req.query;
  if (!file_number || !file_number.trim()) return res.json({ found: false });

  try {
    const pool   = await getPool();
    const search = file_number.trim();

    // Search both tables, pick the most recent match
    const t = await pool.request()
      .input('fn', sql.NVarChar, search)
      .query(`SELECT TOP 1 patient_name, blood_group, rh_factor, diagnosis,
                CONVERT(VARCHAR(19), created_at, 120) AS created_at
              FROM TransfusionRequests
              WHERE file_number = @fn
              ORDER BY created_at DESC`);

    const d = await pool.request()
      .input('fn', sql.NVarChar, search)
      .query(`SELECT TOP 1 patient_name, patient_blood_group AS blood_group,
                patient_rh AS rh_factor, NULL AS diagnosis,
                CONVERT(VARCHAR(19), created_at, 120) AS created_at
              FROM BloodDeliveries
              WHERE file_number = @fn
              ORDER BY created_at DESC`);

    const rows = [...t.recordset, ...d.recordset]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (!rows.length) return res.json({ found: false });

    const r = rows[0];
    return res.json({
      found:       true,
      patient_name: r.patient_name,
      blood_group:  r.blood_group,
      rh_factor:    r.rh_factor,
      diagnosis:    r.diagnosis || '',
    });

  } catch (err) {
    res.status(500).json({ found: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /dashboard/wastage
// Compares ordered units (TransfusionRequests) vs delivered units
// (BloodDeliveries.type_of_blood) for the same patient/file number.
// ════════════════════════════════════════════════════════════════
app.get('/dashboard/wastage', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ error: 'db_not_ready' });
  try {
    const pool = await getPool();

    const deliveries = await pool.request().query(`
      SELECT delivery_id, patient_name, file_number,
        CONVERT(NVARCHAR, delivery_date, 23) AS date,
        type_of_blood, type_of_blood_requested, created_at
      FROM BloodDeliveries
      WHERE type_of_blood IS NOT NULL AND LEN(LTRIM(RTRIM(type_of_blood))) > 0
        AND file_number IS NOT NULL AND LEN(LTRIM(RTRIM(file_number))) > 0
        AND created_at >= DATEADD(day, -90, GETDATE())
      ORDER BY created_at DESC
    `);

    const transfusions = await pool.request().query(`
      SELECT request_id, file_number, fpc_units, ffp_units, plt_units, created_at
      FROM TransfusionRequests
      WHERE (fpc_units IS NOT NULL OR ffp_units IS NOT NULL OR plt_units IS NOT NULL)
        AND file_number IS NOT NULL AND LEN(LTRIM(RTRIM(file_number))) > 0
        AND created_at >= DATEADD(day, -90, GETDATE())
    `);

    const cases = [];
    let totalOrdered = 0, totalUsed = 0;
    let prcWasted = 0, ffpWasted = 0, pltWasted = 0;

    console.log(`[wastage] deliveries found: ${deliveries.recordset.length}, transfusions found: ${transfusions.recordset.length}`);
    for (const d of deliveries.recordset) {
      // Extract number from anywhere in the field: "2 FFP", "FFP 3", "3 units FFP" all work
      const numMatch = (d.type_of_blood || '').match(/\d+/);
      const usedQty  = numMatch ? parseInt(numMatch[0]) : 0;
      if (usedQty === 0) { console.log(`[wastage] SKIP file=${d.file_number} type_of_blood="${d.type_of_blood}" — no number found`); continue; }

      const match = transfusions.recordset.find(t =>
        t.file_number && t.file_number.trim() === d.file_number.trim()
      );
      if (!match) { console.log(`[wastage] SKIP file=${d.file_number} — no matching transfusion request for this file number`); continue; }

      // Use type_of_blood_requested to detect component type (avoids false "PC" match inside type_of_blood qty field)
      const reqText  = (d.type_of_blood_requested || '').toLowerCase();
      const typeText = reqText + ' ' + (d.type_of_blood || '').toLowerCase();
      let ordered = 0, component = 'Blood';
      if (/ffp|plasma|fresh/i.test(reqText)) {
        ordered = match.ffp_units || 0; component = 'FFP';          ffpWasted += Math.max(0, ordered - usedQty);
      } else if (/platelet|plt/i.test(reqText)) {
        ordered = match.plt_units || 0; component = 'Platelets';    pltWasted += Math.max(0, ordered - usedQty);
      } else if (/pack|prc|p\.?c/i.test(reqText)) {
        ordered = match.fpc_units || 0; component = 'Packed Cells'; prcWasted += Math.max(0, ordered - usedQty);
      } else {
        // fallback: check the full combined text
        if (/ffp|plasma|fresh/i.test(typeText))       { ordered = match.ffp_units || 0; component = 'FFP';          ffpWasted += Math.max(0, ordered - usedQty); }
        else if (/platelet|plt/i.test(typeText))      { ordered = match.plt_units || 0; component = 'Platelets';    pltWasted += Math.max(0, ordered - usedQty); }
        else if (/pack|prc|p\.?c/i.test(typeText))   { ordered = match.fpc_units || 0; component = 'Packed Cells'; prcWasted += Math.max(0, ordered - usedQty); }
        else { ordered = (match.fpc_units || 0) + (match.ffp_units || 0) + (match.plt_units || 0); component = d.type_of_blood_requested || 'Blood'; }
      }
      console.log(`[wastage] file=${d.file_number} reqText="${reqText}" usedQty=${usedQty} ordered=${ordered} component=${component} fpc=${match.fpc_units} ffp=${match.ffp_units} plt=${match.plt_units}`);
      if (ordered === 0) { console.log(`[wastage] SKIP file=${d.file_number} — ordered=0 (transfusion request has no units for this component)`); continue; }

      const wasted = Math.max(0, ordered - usedQty);
      totalOrdered += ordered;
      totalUsed    += usedQty;
      cases.push({
        patient_name: d.patient_name, file_number: d.file_number,
        date: d.date, component, ordered, used: usedQty, wasted,
      });
    }

    cases.sort((a, b) => b.wasted - a.wasted);
    const totalWasted = prcWasted + ffpWasted + pltWasted;
    const wastageRate = totalOrdered > 0 ? Math.round((totalWasted / totalOrdered) * 100) : 0;

    res.json({
      summary: { totalOrdered, totalUsed, totalWasted, wastageRate, prcWasted, ffpWasted, pltWasted },
      cases: cases.slice(0, 30),
    });
  } catch (err) {
    console.error('Wastage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /response-times
// For each transfusion request, finds the nearest delivery by the
// same file_number and calculates the elapsed minutes.
// Case rules: life_saving → target 15 min; Stat component → 45 min
// ════════════════════════════════════════════════════════════════
app.get('/response-times', requireAuth, async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const pool   = await getPool();
    const result = await pool.request().query(`
      SELECT
        t.request_id,
        t.patient_name,
        t.file_number,
        CONVERT(VARCHAR(10), t.request_date, 23)                AS request_date,
        CONVERT(VARCHAR(8),  t.request_time,  108)              AS request_time,
        CAST(t.life_saving AS INT)                               AS t_life_saving,
        t.fpc_type, t.ffp_type, t.plt_type,
        d.delivery_id,
        CONVERT(VARCHAR(10), d.delivery_date,    23)             AS delivery_date,
        CONVERT(VARCHAR(8),  d.delivery_time,   108)             AS delivery_time,
        CAST(d.life_saving AS INT)                               AS d_life_saving,
        CONVERT(VARCHAR(10), d.nurse_unit_date,  23)             AS nurse_unit_date,
        CONVERT(VARCHAR(8),  d.nurse_unit_time, 108)             AS nurse_unit_time,
        -- Blood bank delivery elapsed (request → BB dispatches)
        CASE
          WHEN t.request_date IS NOT NULL AND t.request_time IS NOT NULL
               AND d.delivery_date IS NOT NULL AND d.delivery_time IS NOT NULL
          THEN DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10), t.request_date, 23) + ' ' + CONVERT(VARCHAR(8), t.request_time, 108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10), d.delivery_date, 23) + ' ' + CONVERT(VARCHAR(8), d.delivery_time, 108) AS DATETIME)
          )
          ELSE NULL
        END AS bb_diff_minutes,
        -- Nurse receipt elapsed (request → nurse signs for blood)
        CASE
          WHEN t.request_date IS NOT NULL AND t.request_time IS NOT NULL
               AND d.nurse_unit_date IS NOT NULL AND d.nurse_unit_time IS NOT NULL
          THEN DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10), t.request_date, 23) + ' ' + CONVERT(VARCHAR(8), t.request_time, 108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10), d.nurse_unit_date, 23) + ' ' + CONVERT(VARCHAR(8), d.nurse_unit_time, 108) AS DATETIME)
          )
          ELSE NULL
        END AS nurse_diff_minutes,
        CONVERT(VARCHAR(19), t.created_at, 120)                  AS created_at
      FROM TransfusionRequests t
      OUTER APPLY (
        SELECT TOP 1
          delivery_id, delivery_date, delivery_time, life_saving,
          nurse_unit_date, nurse_unit_time
        FROM BloodDeliveries bd
        WHERE bd.file_number = t.file_number
          AND bd.file_number IS NOT NULL AND bd.file_number <> ''
          AND (
            bd.delivery_date > t.request_date
            OR (bd.delivery_date = t.request_date AND bd.delivery_time >= t.request_time)
          )
        ORDER BY bd.delivery_date ASC, bd.delivery_time ASC
      ) d
      WHERE t.request_date IS NOT NULL AND t.request_time IS NOT NULL
        AND t.file_number IS NOT NULL AND t.file_number <> ''
      ORDER BY t.created_at DESC
    `);

    const rows = result.recordset.map(r => {
      const isLifeSaving = r.t_life_saving === 1 || r.d_life_saving === 1;
      const isStat       = [r.fpc_type, r.ffp_type, r.plt_type].some(t => t === 'Stat');
      let caseType      = 'routine';
      let targetMinutes = null;
      if (isLifeSaving)      { caseType = 'life_saving'; targetMinutes = 15; }
      else if (isStat)       { caseType = 'urgent';      targetMinutes = 45; }
      const bbWithin    = targetMinutes !== null && r.bb_diff_minutes    !== null
        ? r.bb_diff_minutes    <= targetMinutes : null;
      const nurseWithin = targetMinutes !== null && r.nurse_diff_minutes !== null
        ? r.nurse_diff_minutes <= targetMinutes : null;
      return { ...r, caseType, targetMinutes, bbWithin, nurseWithin };
    });

    res.json(rows);
  } catch (err) {
    console.error('Response times error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /mode-check
// ════════════════════════════════════════════════════════════════
app.get("/mode-check", (req, res) => {
  res.json({ mode: "rules", ollamaRunning: false, hasModel: false, dbReady });
});
// ════════════════════════════════════════════════════════════════
// POST /export/pdf   — generate and download PDF
// POST /export/docx  — generate and download DOCX
// ════════════════════════════════════════════════════════════════
const { generateDocx, generatePdf } = require('./exportForm');

app.post('/export/pdf', requireAuth, async (req, res) => {
  const { form_type, ...fields } = req.body;
  try {
    const buffer = await generatePdf(form_type, fields);
    const name   = `${form_type}_${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/export/docx', requireAuth, async (req, res) => {
  const { form_type, ...fields } = req.body;
  try {
    const buffer = await generateDocx(form_type, fields);
    const name   = `${form_type}_${Date.now()}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  } catch (err) {
    console.error('DOCX export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /history/search?q=...&type=...&date=...
// ════════════════════════════════════════════════════════════════
app.get('/history/search', requireAuth, async (req, res) => {
  if (!dbReady) return res.json([]);
  const { q = '', type = 'all', date = '' } = req.query;

  try {
    const pool   = await getPool();
    const search = `%${q}%`;
    let combined = [];

    // ── TRANSFUSION ──────────────────────────────────────────────
    if (type === 'all' || type === 'transfusion') {
      let query = `
        SELECT TOP 60
          request_id AS id, 'transfusion' AS form_type,
          patient_name, diagnosis, blood_group, rh_factor,
          file_number, room, fpc_units, fpc_type,
          ffp_units, ffp_type, plt_units, plt_type,
          blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
          blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
          previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
          physician, phlebotomist, request_date, request_time,
          life_saving, life_saving_physician, life_saving_time,
          saved_by,
          CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM TransfusionRequests
        WHERE (
          @search = '%%' OR patient_name LIKE @search OR file_number LIKE @search
        )`;
      if (date) query += ` AND CONVERT(NVARCHAR, created_at, 23) = @date`;
      query += ` ORDER BY created_at DESC`;

      const req1 = pool.request().input('search', sql.NVarChar, search);
      if (date) req1.input('date', sql.NVarChar, date);
      const t = await req1.query(query);
      combined.push(...t.recordset);
    }

    // ── DELIVERY ─────────────────────────────────────────────────
    if (type === 'all' || type === 'delivery') {
      let query = `
        SELECT TOP 60
          delivery_id AS id, 'delivery' AS form_type,
          patient_name, file_number,
          patient_blood_group AS blood_group,
          patient_rh          AS rh_factor,
          room,
          known_allergies          AS allergy_details,
          type_of_blood_requested,
          blood_unit_numbers,
          type_of_blood,
          blood_unit_group,
          patient_blood_group_delivery,
          technician_name  AS technician,
          orderly_name     AS orderly,
          nurse_name       AS nurse,
          delivery_date, delivery_time,
          leakage, gases, volume, expiry_date,
          temperature_c    AS temperature,
          received_by,
          nurse_unit_received_by, nurse_unit_name,
          nurse_unit_date, nurse_unit_time,
          life_saving, life_saving_physician, life_saving_time,
          saved_by,
          CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM BloodDeliveries
        WHERE (
          @search = '%%' OR patient_name LIKE @search OR file_number LIKE @search
        )`;
      if (date) query += ` AND CONVERT(NVARCHAR, created_at, 23) = @date`;
      query += ` ORDER BY created_at DESC`;

      const req2 = pool.request().input('search', sql.NVarChar, search);
      if (date) req2.input('date', sql.NVarChar, date);
      const d = await req2.query(query);
      combined.push(...d.recordset);
    }

    // Sort and limit
    combined = combined
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 80);

    res.json(combined);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ════════════════════════════════════════════════════════════════
// POST /ext-delivery/save  (admin only)
// ════════════════════════════════════════════════════════════════
app.post('/ext-delivery/save', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Database not connected.' });
  const f = req.body;
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('patient_name',       sql.NVarChar, f.patient_name       || null)
      .input('destination',        sql.NVarChar, f.destination         || null)
      .input('delivery_date',      sql.Date,     f.delivery_date       || null)
      .input('delivery_hour',      sql.NVarChar, f.delivery_hour       || null)
      .input('technician_name',    sql.NVarChar, f.technician_name     || null)
      .input('frbc_unit_no',       sql.NVarChar, f.frbc_unit_no        || null)
      .input('frbc_blood_group',   sql.NVarChar, f.frbc_blood_group    || null)
      .input('frbc_expiry_date',   sql.Date,     f.frbc_expiry_date    || null)
      .input('frbc_notes',         sql.NVarChar, f.frbc_notes          || null)
      .input('ffp_unit_no',        sql.NVarChar, f.ffp_unit_no         || null)
      .input('ffp_blood_group',    sql.NVarChar, f.ffp_blood_group     || null)
      .input('ffp_expiry_date',    sql.Date,     f.ffp_expiry_date     || null)
      .input('ffp_notes',          sql.NVarChar, f.ffp_notes           || null)
      .input('plt_unit_no',        sql.NVarChar, f.plt_unit_no         || null)
      .input('plt_blood_group',    sql.NVarChar, f.plt_blood_group     || null)
      .input('plt_expiry_date',    sql.Date,     f.plt_expiry_date     || null)
      .input('plt_notes',          sql.NVarChar, f.plt_notes           || null)
      .input('other1_component',   sql.NVarChar, f.other1_component    || null)
      .input('other1_unit_no',     sql.NVarChar, f.other1_unit_no      || null)
      .input('other1_blood_group', sql.NVarChar, f.other1_blood_group  || null)
      .input('other1_expiry_date', sql.Date,     f.other1_expiry_date  || null)
      .input('other1_notes',       sql.NVarChar, f.other1_notes        || null)
      .input('other2_component',   sql.NVarChar, f.other2_component    || null)
      .input('other2_unit_no',     sql.NVarChar, f.other2_unit_no      || null)
      .input('other2_blood_group', sql.NVarChar, f.other2_blood_group  || null)
      .input('other2_expiry_date', sql.Date,     f.other2_expiry_date  || null)
      .input('other2_notes',       sql.NVarChar, f.other2_notes        || null)
      .input('test_hiv',           sql.Bit,      f.test_hiv     ? 1 : 0)
      .input('test_hbsag',         sql.Bit,      f.test_hbsag   ? 1 : 0)
      .input('test_hcv',           sql.Bit,      f.test_hcv     ? 1 : 0)
      .input('test_hb_core',       sql.Bit,      f.test_hb_core ? 1 : 0)
      .input('test_sts',           sql.Bit,      f.test_sts     ? 1 : 0)
      .input('test_iat',           sql.Bit,      f.test_iat     ? 1 : 0)
      .input('test_kell',          sql.Bit,      f.test_kell    ? 1 : 0)
      .input('integrity',          sql.NVarChar, f.integrity           || null)
      .input('saved_by',           sql.NVarChar, req.user?.fullName    || null)
      .input('components_json',    sql.NVarChar, f.components ? JSON.stringify(f.components) : null)
      .query(`INSERT INTO ExternalDeliveries (
        patient_name, destination, delivery_date, delivery_hour, technician_name,
        frbc_unit_no, frbc_blood_group, frbc_expiry_date, frbc_notes,
        ffp_unit_no,  ffp_blood_group,  ffp_expiry_date,  ffp_notes,
        plt_unit_no,  plt_blood_group,  plt_expiry_date,  plt_notes,
        other1_component, other1_unit_no, other1_blood_group, other1_expiry_date, other1_notes,
        other2_component, other2_unit_no, other2_blood_group, other2_expiry_date, other2_notes,
        test_hiv, test_hbsag, test_hcv, test_hb_core, test_sts, test_iat, test_kell,
        integrity, saved_by, components_json
      ) OUTPUT INSERTED.delivery_id VALUES (
        @patient_name, @destination, @delivery_date, @delivery_hour, @technician_name,
        @frbc_unit_no, @frbc_blood_group, @frbc_expiry_date, @frbc_notes,
        @ffp_unit_no,  @ffp_blood_group,  @ffp_expiry_date,  @ffp_notes,
        @plt_unit_no,  @plt_blood_group,  @plt_expiry_date,  @plt_notes,
        @other1_component, @other1_unit_no, @other1_blood_group, @other1_expiry_date, @other1_notes,
        @other2_component, @other2_unit_no, @other2_blood_group, @other2_expiry_date, @other2_notes,
        @test_hiv, @test_hbsag, @test_hcv, @test_hb_core, @test_sts, @test_iat, @test_kell,
        @integrity, @saved_by, @components_json
      )`);
    res.json({ success: true, id: result.recordset[0].delivery_id });
  } catch (err) {
    console.error('Ext delivery save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /ext-delivery  (admin only)
// ════════════════════════════════════════════════════════════════
app.get('/ext-delivery', requireAdmin, async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const pool   = await getPool();
    const result = await pool.request().query(`
      SELECT TOP 50 *,
        CONVERT(VARCHAR(10), delivery_date, 23)  AS delivery_date_str,
        CONVERT(VARCHAR(19), created_at, 120)    AS created_at_str
      FROM ExternalDeliveries ORDER BY created_at DESC
    `);
    const ds = d => d ? (typeof d === 'string' ? d.slice(0,10) : new Date(d).toISOString().slice(0,10)) : '';
    const records = result.recordset.map(r => {
      let components = null;
      if (r.components_json) { try { components = JSON.parse(r.components_json); } catch(e){} }
      if (!components) {
        components = [
          { key:'frbc', label:'Filtered RBC', unit_no:r.frbc_unit_no||'', blood_group:r.frbc_blood_group||'', expiry_date:ds(r.frbc_expiry_date), notes:r.frbc_notes||'' },
          { key:'ffp',  label:'FFP',          unit_no:r.ffp_unit_no||'',  blood_group:r.ffp_blood_group||'',  expiry_date:ds(r.ffp_expiry_date),  notes:r.ffp_notes||''  },
          { key:'plt',  label:'Platelets',    unit_no:r.plt_unit_no||'',  blood_group:r.plt_blood_group||'',  expiry_date:ds(r.plt_expiry_date),  notes:r.plt_notes||''  },
          { key:'oth1', label:r.other1_component||'', unit_no:r.other1_unit_no||'', blood_group:r.other1_blood_group||'', expiry_date:ds(r.other1_expiry_date), notes:r.other1_notes||'' },
          { key:'oth2', label:r.other2_component||'', unit_no:r.other2_unit_no||'', blood_group:r.other2_blood_group||'', expiry_date:ds(r.other2_expiry_date), notes:r.other2_notes||'' },
        ];
      }
      return { ...r, components };
    });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// PUT /ext-delivery/:id  (admin only)
// ════════════════════════════════════════════════════════════════
app.put('/ext-delivery/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Database not connected.' });
  const f = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',                 sql.Int,      parseInt(req.params.id))
      .input('patient_name',       sql.NVarChar, f.patient_name       || null)
      .input('destination',        sql.NVarChar, f.destination         || null)
      .input('delivery_date',      sql.Date,     f.delivery_date       || null)
      .input('delivery_hour',      sql.NVarChar, f.delivery_hour       || null)
      .input('technician_name',    sql.NVarChar, f.technician_name     || null)
      .input('frbc_unit_no',       sql.NVarChar, f.frbc_unit_no        || null)
      .input('frbc_blood_group',   sql.NVarChar, f.frbc_blood_group    || null)
      .input('frbc_expiry_date',   sql.Date,     f.frbc_expiry_date    || null)
      .input('frbc_notes',         sql.NVarChar, f.frbc_notes          || null)
      .input('ffp_unit_no',        sql.NVarChar, f.ffp_unit_no         || null)
      .input('ffp_blood_group',    sql.NVarChar, f.ffp_blood_group     || null)
      .input('ffp_expiry_date',    sql.Date,     f.ffp_expiry_date     || null)
      .input('ffp_notes',          sql.NVarChar, f.ffp_notes           || null)
      .input('plt_unit_no',        sql.NVarChar, f.plt_unit_no         || null)
      .input('plt_blood_group',    sql.NVarChar, f.plt_blood_group     || null)
      .input('plt_expiry_date',    sql.Date,     f.plt_expiry_date     || null)
      .input('plt_notes',          sql.NVarChar, f.plt_notes           || null)
      .input('other1_component',   sql.NVarChar, f.other1_component    || null)
      .input('other1_unit_no',     sql.NVarChar, f.other1_unit_no      || null)
      .input('other1_blood_group', sql.NVarChar, f.other1_blood_group  || null)
      .input('other1_expiry_date', sql.Date,     f.other1_expiry_date  || null)
      .input('other1_notes',       sql.NVarChar, f.other1_notes        || null)
      .input('other2_component',   sql.NVarChar, f.other2_component    || null)
      .input('other2_unit_no',     sql.NVarChar, f.other2_unit_no      || null)
      .input('other2_blood_group', sql.NVarChar, f.other2_blood_group  || null)
      .input('other2_expiry_date', sql.Date,     f.other2_expiry_date  || null)
      .input('other2_notes',       sql.NVarChar, f.other2_notes        || null)
      .input('test_hiv',           sql.Bit,      f.test_hiv     ? 1 : 0)
      .input('test_hbsag',         sql.Bit,      f.test_hbsag   ? 1 : 0)
      .input('test_hcv',           sql.Bit,      f.test_hcv     ? 1 : 0)
      .input('test_hb_core',       sql.Bit,      f.test_hb_core ? 1 : 0)
      .input('test_sts',           sql.Bit,      f.test_sts     ? 1 : 0)
      .input('test_iat',           sql.Bit,      f.test_iat     ? 1 : 0)
      .input('test_kell',          sql.Bit,      f.test_kell    ? 1 : 0)
      .input('integrity',          sql.NVarChar, f.integrity           || null)
      .input('components_json',    sql.NVarChar, f.components ? JSON.stringify(f.components) : null)
      .query(`UPDATE ExternalDeliveries SET
        patient_name=@patient_name, destination=@destination,
        delivery_date=@delivery_date, delivery_hour=@delivery_hour,
        technician_name=@technician_name,
        frbc_unit_no=@frbc_unit_no, frbc_blood_group=@frbc_blood_group,
        frbc_expiry_date=@frbc_expiry_date, frbc_notes=@frbc_notes,
        ffp_unit_no=@ffp_unit_no, ffp_blood_group=@ffp_blood_group,
        ffp_expiry_date=@ffp_expiry_date, ffp_notes=@ffp_notes,
        plt_unit_no=@plt_unit_no, plt_blood_group=@plt_blood_group,
        plt_expiry_date=@plt_expiry_date, plt_notes=@plt_notes,
        other1_component=@other1_component, other1_unit_no=@other1_unit_no,
        other1_blood_group=@other1_blood_group, other1_expiry_date=@other1_expiry_date,
        other1_notes=@other1_notes,
        other2_component=@other2_component, other2_unit_no=@other2_unit_no,
        other2_blood_group=@other2_blood_group, other2_expiry_date=@other2_expiry_date,
        other2_notes=@other2_notes,
        test_hiv=@test_hiv, test_hbsag=@test_hbsag, test_hcv=@test_hcv,
        test_hb_core=@test_hb_core, test_sts=@test_sts, test_iat=@test_iat,
        test_kell=@test_kell, integrity=@integrity, components_json=@components_json
      WHERE delivery_id=@id`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /ext-delivery/:id  (admin only)
// ════════════════════════════════════════════════════════════════
app.delete('/ext-delivery/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.json({ success: false });
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, parseInt(req.params.id))
      .query('DELETE FROM ExternalDeliveries WHERE delivery_id=@id');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /ext-delivery/export/pdf  +  /ext-delivery/export/docx
// ════════════════════════════════════════════════════════════════
app.post('/ext-delivery/export/pdf', requireAdmin, async (req, res) => {
  try {
    const buffer = await generatePdf('external_delivery', req.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ext_delivery_${Date.now()}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/ext-delivery/export/docx', requireAdmin, async (req, res) => {
  try {
    const buffer = await generateDocx('external_delivery', req.body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="ext_delivery_${Date.now()}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// EXCEL FILES DASHBOARD
// ════════════════════════════════════════════════════════════════
const xlsx = require('xlsx');

const EXCEL_DIR = path.join(__dirname, 'uploads', 'excel');
if (!fs.existsSync(EXCEL_DIR)) fs.mkdirSync(EXCEL_DIR, { recursive: true });

const excelUpload = multer({
  storage: multer.diskStorage({
    destination: EXCEL_DIR,
    filename: (req, file, cb) => cb(null, `_tmp_${Date.now()}_${file.originalname}`)
  }),
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx and .xls files are allowed'));
  }
});

app.get('/api/excel/files', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(EXCEL_DIR)
      .filter(f => /\.(xlsx|xls)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(EXCEL_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/excel/upload', requireAuth, excelUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const targetName = path.basename((req.body && req.body.targetName) || req.file.originalname);
  if (!/\.(xlsx|xls)$/i.test(targetName)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Invalid file type' });
  }
  const finalPath = path.join(EXCEL_DIR, targetName);
  fs.renameSync(req.file.path, finalPath);
  excelFileCache.delete(targetName);   // bust cache so next query reads fresh data
  res.json({ success: true, name: targetName });
});

app.delete('/api/excel/files/:filename', requireAdmin, (req, res) => {
  try {
    const filePath = path.join(EXCEL_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filePath);
    excelFileCache.delete(path.basename(req.params.filename));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Excel shared date normaliser (module-level) ─────────────
function normalizeExcelDate(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) return val.toISOString().split('T')[0];
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  return s;
}

// Normalises any Excel cell value — handles both dates and time-only cells.
// SheetJS builds Date objects using local time, so we use local-time getters
// to avoid timezone-offset errors (e.g. UTC+2 would show times 2 hrs early).
function normalizeExcelValue(val) {
  if (!(val instanceof Date)) return val;
  // Time-only cells: Excel epoch is 1899-12-30 (local year = 1899)
  if (val.getFullYear() === 1899) {
    const h = String(val.getHours()).padStart(2, '0');
    const m = String(val.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  // Regular date: use local date parts to avoid UTC midnight shift
  const y  = val.getFullYear();
  const mo = String(val.getMonth() + 1).padStart(2, '0');
  const d  = String(val.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// ── Parsed-file cache: filename → { columns, rows, mtime } ──
const excelFileCache = new Map();

function getCachedRows(filename) {
  const filePath = path.join(EXCEL_DIR, filename);
  const mtime    = fs.statSync(filePath).mtime.getTime();
  const cached   = excelFileCache.get(filename);
  if (cached && cached.mtime === mtime) return cached;

  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows  = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Deduplicate header names
  const headerRow = rawRows[0] || [];
  const columns   = [];
  const colSeen   = {};
  headerRow.forEach(h => {
    const name = String(h).trim() || '(empty)';
    colSeen[name] = colSeen[name] ?? -1;
    colSeen[name]++;
    columns.push(colSeen[name] === 0 ? name : `${name}_${colSeen[name]}`);
  });

  const rows = rawRows.slice(1)
    .filter(r => r.some(v => v !== '' && v !== null && v !== undefined))
    .map(r => {
      const obj = {};
      columns.forEach((c, i) => {
        const v = r[i] ?? '';
        obj[c] = (v instanceof Date) ? normalizeExcelValue(v) : v;
      });
      return obj;
    });

  const entry = { columns, rows, mtime };
  excelFileCache.set(filename, entry);
  return entry;
}

// ── Excel type detection & summary helpers ──────────────────
function detectExcelType(columns) {
  const s = new Set(columns.map(c => String(c).toLowerCase().trim()));
  // Donors first — dob+gender is unique to registered donor files; donor+nationality
  // also covers donor sheets that may lack a dob column. Must run before external_units
  // because donor registration files also contain seq/donation type/bag columns.
  if ((s.has('dob') && s.has('gender')) || (s.has('donor') && s.has('nationality') && s.has('dob'))) return 'donors';
  // External units from other centres
  if (s.has('seq') && s.has('donation type') && s.has('bag'))                                return 'external_units';
  // Units sent to other centres — hospital + expiry are unique to this type
  if (s.has('hospital') && s.has('expiry'))                                                  return 'sent_to_centres';
  // Patient requests — IAT or Request type are unique
  if (s.has('request type') || s.has('iat'))                                                 return 'requests';
  // Wasted units — Reason column is unique (exclude transfusion files that also have destination)
  if (s.has('reason') && s.has('unit') && !s.has('destination'))                             return 'wasted';
  // Transfusion: 'issued' is the strongest signal; fall back to patient number or destination+returned
  if (s.has('issued') || s.has('patient number') || (s.has('destination') && s.has('returned'))) return 'transfusion';
  // Donors fallback — donor+nationality without dob (older file formats)
  if (s.has('donor') && s.has('nationality'))                                                 return 'donors';
  return 'generic';
}

function excelCountBy(rows, col, topN) {
  if (!col) return [];
  const map = {};
  rows.forEach(r => {
    const v = String(r[col] ?? '').trim();
    if (v && v !== '-') map[v] = (map[v] || 0) + 1;
  });
  const arr = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  return topN ? arr.slice(0, topN) : arr;
}

function excelFindCol(columns, ...names) {
  for (const name of names) {
    const m = columns.find(c => c.toLowerCase().trim() === name.toLowerCase());
    if (m) return m;
  }
  return null;
}

function peakHours(rows, columns) {
  const timeCol = excelFindCol(columns, 'time');
  if (!timeCol) return [];
  const counts = new Array(24).fill(0);
  rows.forEach(row => {
    const t = String(row[timeCol] || '').trim();
    const m = t.match(/^(\d{1,2}):/);
    if (m) { const h = parseInt(m[1]); if (h >= 0 && h < 24) counts[h]++; }
  });
  return counts.map((count, h) => ({ label: `${String(h).padStart(2,'0')}:00`, count })).filter(d => d.count > 0);
}

function excelSummary(type, rows, columns) {
  const g = (...n) => excelFindCol(columns, ...n);
  switch (type) {
    case 'transfusion': {
      const retCol  = g('returned');
      const retList = excelCountBy(rows, retCol);
      const retYes  = retList.find(x => /yes/i.test(x.label))?.count || 0;
      const patCol  = g('patient number');
      return {
        uniquePatients:   patCol ? new Set(rows.map(r => r[patCol]).filter(Boolean)).size : 0,
        returnedCount:    retYes,
        notReturnedCount: rows.length - retYes,
        byGroup:       excelCountBy(rows, g('group'),       10),
        byComponent:   excelCountBy(rows, g('component'),   10),
        byReturned:    retList,
        byDestination: excelCountBy(rows, g('destination'), 10),
        byHour:        peakHours(rows, columns)
      };
    }
    case 'requests': {
      const patCol = g('patient');
      const iatCol = g('iat');
      const iatList = excelCountBy(rows, iatCol);
      const iatPos  = iatList.find(x => /pos|\+/i.test(x.label))?.count || 0;
      return {
        uniquePatients: patCol ? new Set(rows.map(r => r[patCol]).filter(Boolean)).size : 0,
        iatPositive:    iatPos,
        iatTotal:       iatCol ? rows.filter(r => r[iatCol] && String(r[iatCol]).trim()).length : 0,
        byDepartment:   excelCountBy(rows, g('department'),   10),
        byGroup:        excelCountBy(rows, g('group'),        10),
        byRequestType:  excelCountBy(rows, g('request type'), 10),
        byIAT:          iatList,
        byHour:         peakHours(rows, columns)
      };
    }
    case 'donors': {
      const gList  = excelCountBy(rows, g('gender'));
      const male   = gList.find(x => /^male$/i.test(x.label))?.count || 0;
      const female = gList.find(x => /female/i.test(x.label))?.count || 0;

      // Age groups from DOB column
      const dobCol = g('dob');
      const now    = new Date();
      const ageBuckets = { 'Under 18': 0, '18–25': 0, '26–35': 0, '36–45': 0, '46–55': 0, '56+': 0 };
      if (dobCol) {
        rows.forEach(row => {
          const raw = String(row[dobCol] || '').trim();
          if (!raw) return;
          let yr, mo = 0, dy = 1;
          const m1 = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
          const m2 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (m1)      { yr = +m1[1]; mo = +m1[2] - 1; dy = +m1[3]; }
          else if (m2) { yr = +m2[3]; mo = +m2[2] - 1; dy = +m2[1]; }
          else return;
          if (!yr || yr < 1900 || yr > now.getFullYear()) return;
          let age = now.getFullYear() - yr;
          if (now.getMonth() < mo || (now.getMonth() === mo && now.getDate() < dy)) age--;
          if      (age < 18)  ageBuckets['Under 18']++;
          else if (age <= 25) ageBuckets['18–25']++;
          else if (age <= 35) ageBuckets['26–35']++;
          else if (age <= 45) ageBuckets['36–45']++;
          else if (age <= 55) ageBuckets['46–55']++;
          else                ageBuckets['56+']++;
        });
      }
      const byAgeGroup = Object.entries(ageBuckets)
        .filter(([, c]) => c > 0)
        .map(([label, count]) => ({ label, count }));

      // New vs returning donors
      const donorCol = g('donor', 'donor id', 'donor no', 'name');
      let newDonors = 0, returningDonors = 0;
      const byFrequentDonors = [];
      if (donorCol) {
        const donorMap = {};
        rows.forEach(row => {
          const id = String(row[donorCol] || '').trim();
          if (id) donorMap[id] = (donorMap[id] || 0) + 1;
        });
        Object.values(donorMap).forEach(c => { if (c === 1) newDonors++; else returningDonors++; });
        Object.entries(donorMap).sort((a,b) => b[1]-a[1]).slice(0,10)
          .forEach(([label, count]) => byFrequentDonors.push({ label, count }));
      }

      const cityCol  = excelFindCol(columns, 'city/town', 'city', 'town');
      const mohaCol  = excelFindCol(columns, 'mohafaza', 'region', 'province', 'governorate');
      return {
        maleCount: male, femaleCount: female,
        newDonors, returningDonors,
        byGender:         gList,
        byGroup:          excelCountBy(rows, g('group'),       10),
        byNationality:    excelCountBy(rows, g('nationality'), 8),
        byAgeGroup,
        byFrequentDonors,
        byCity:           excelCountBy(rows, cityCol, 15),
        byMohafaza:       excelCountBy(rows, mohaCol, 20)
      };
    }
    case 'wasted': {
      const reasonCol = g('reason');
      let expiryWaste = 0, operationalWaste = 0;
      if (reasonCol) {
        rows.forEach(row => {
          const r = String(row[reasonCol] || '').trim();
          if (!r) return;
          if (/expir|منتهي|تالف/i.test(r)) expiryWaste++;
          else operationalWaste++;
        });
      }
      const byWasteType = [
        expiryWaste      ? { label: 'Expiry-Related', count: expiryWaste }      : null,
        operationalWaste ? { label: 'Operational',    count: operationalWaste }  : null
      ].filter(Boolean);

      // Pareto: sorted reasons with cumulative %
      const rawReasons = excelCountBy(rows, reasonCol, 20);
      const reasonTotal = rawReasons.reduce((s, d) => s + d.count, 0);
      let cumulative = 0;
      const byReasonPareto = rawReasons
        .sort((a, b) => b.count - a.count)
        .map(d => {
          cumulative += d.count;
          return { label: d.label, count: d.count, cumPct: Math.round((cumulative / reasonTotal) * 100) };
        });

      // Expiry days histogram: days between waste date and expiry date
      const dateCol   = excelFindCol(columns, 'date');
      const expiryCol = excelFindCol(columns, 'expiry', 'expiry date');
      const expiryDaysHist = [];
      if (dateCol && expiryCol) {
        const bins = { '0-2 days': 0, '3-7 days': 0, '8-14 days': 0, '15-30 days': 0, '>30 days': 0 };
        rows.forEach(row => {
          const d = new Date(normalizeExcelDate(row[dateCol]));
          const e = new Date(normalizeExcelDate(row[expiryCol]));
          if (isNaN(d.getTime()) || isNaN(e.getTime())) return;
          const days = Math.round((e - d) / 86400000);
          if (days < 0) return;
          if      (days <= 2)  bins['0-2 days']++;
          else if (days <= 7)  bins['3-7 days']++;
          else if (days <= 14) bins['8-14 days']++;
          else if (days <= 30) bins['15-30 days']++;
          else                 bins['>30 days']++;
        });
        Object.entries(bins).forEach(([label, count]) => { if (count > 0) expiryDaysHist.push({ label, count }); });
      }

      return {
        expiryWaste, operationalWaste,
        byWasteType,
        byReason:        excelCountBy(rows, reasonCol,      10),
        byReasonPareto,
        byComponent:     excelCountBy(rows, g('component'), 10),
        byGroup:         excelCountBy(rows, g('group'),     10),
        expiryDaysHist
      };
    }
    case 'sent_to_centres': {
      const retCol  = g('returned');
      const retList = excelCountBy(rows, retCol);
      const retYes  = retList.find(x => /yes/i.test(x.label))?.count || 0;
      const compCols    = columns.filter(c => /^component/i.test(c.trim()));
      const textCompCol = compCols.find(c => rows.slice(0, 20).some(r => r[c] && isNaN(String(r[c]).trim())));

      // Near-expiry: units sent within 14 days of their expiry date
      const dateCol   = columns.find(k => k.toLowerCase().trim() === 'date');
      const expiryCol = g('expiry');
      let nearExpiryCount = 0;
      if (dateCol && expiryCol) {
        rows.forEach(row => {
          const sent   = new Date(normalizeExcelDate(row[dateCol]));
          const expiry = new Date(normalizeExcelDate(row[expiryCol]));
          if (isNaN(sent.getTime()) || isNaN(expiry.getTime())) return;
          const days = (expiry - sent) / 86400000;
          if (days >= 0 && days <= 14) nearExpiryCount++;
        });
      }

      return {
        returnedCount: retYes, notReturnedCount: rows.length - retYes,
        nearExpiryCount,
        byHospital:  excelCountBy(rows, g('hospital'),             10),
        byGroup:     excelCountBy(rows, g('group'),                10),
        byReturned:  retList,
        byComponent: excelCountBy(rows, textCompCol || compCols[0], 10)
      };
    }
    case 'external_units': {
      return {
        byDonationType: excelCountBy(rows, g('donation type'), 10),
        byBag:          excelCountBy(rows, g('bag'),           10),
        byGroup:        excelCountBy(rows, g('group'),         10)
      };
    }
    default:
      return { byGroup: excelCountBy(rows, g('group'), 10) };
  }
}

// GET /api/excel/categories  — files grouped by detected type
app.get('/api/excel/categories', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(EXCEL_DIR).filter(f => /\.(xlsx|xls)$/i.test(f));
    const cats  = {};
    const now       = new Date();
    const pad       = n => String(n).padStart(2, '0');
    const thisMo    = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const lastMoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMo    = `${lastMoDate.getFullYear()}-${pad(lastMoDate.getMonth() + 1)}`;

    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(EXCEL_DIR, f));
        const { columns, rows } = getCachedRows(f);
        const type    = detectExcelType(columns);
        const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
        let thisMonth = 0, lastMonth = 0;
        if (dateCol) {
          rows.forEach(row => {
            const ds = normalizeExcelDate(row[dateCol]);
            if (!ds || ds.length < 7) return;
            const mo = ds.substring(0, 7);
            if (mo === thisMo) thisMonth++;
            if (mo === lastMo) lastMonth++;
          });
        }
        if (!cats[type]) cats[type] = [];
        cats[type].push({ name: f, size: stat.size, modified: stat.mtime, rowCount: rows.length, thisMonth, lastMonth });
      } catch (_) { /* skip unreadable files */ }
    }

    // Top departments/wards aggregated across transfusion + requests
    const deptMap = {};
    for (const type of ['transfusion', 'requests']) {
      for (const fi of (cats[type] || [])) {
        try {
          const { columns, rows } = getCachedRows(fi.name);
          const deptCol = excelFindCol(columns, 'destination', 'department', 'dept', 'ward');
          if (!deptCol) continue;
          rows.forEach(row => {
            const v = String(row[deptCol] || '').trim();
            if (v) deptMap[v] = (deptMap[v] || 0) + 1;
          });
        } catch (_) {}
      }
    }
    const _topDepts = Object.entries(deptMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([label, count]) => ({ label, count }));

    // Monthly comparison: requests vs issued (transfusion)
    const moMap = {};
    for (const type of ['transfusion', 'requests']) {
      for (const fi of (cats[type] || [])) {
        try {
          const { columns: fc, rows: fr } = getCachedRows(fi.name);
          const dc = fc.find(k => k.toLowerCase().trim() === 'date');
          if (!dc) continue;
          fr.forEach(row => {
            const ds = normalizeExcelDate(row[dc]);
            if (!ds || ds.length < 7) return;
            const mo = ds.substring(0, 7);
            if (!moMap[mo]) moMap[mo] = { requests: 0, transfusion: 0 };
            moMap[mo][type]++;
          });
        } catch (_) {}
      }
    }
    const _monthlyComparison = Object.entries(moMap)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, d]) => ({ label, requests: d.requests, transfusion: d.transfusion }));

    res.json({ ...cats, _topDepts, _monthlyComparison });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/excel/category-query  — combined query across all files in a category
app.post('/api/excel/category-query', requireAuth, (req, res) => {
  try {
    const { category, dateFrom, dateTo, search, page = 1, pageSize = 100 } = req.body;
    if (!category) return res.status(400).json({ error: 'category required' });

    const files   = fs.readdirSync(EXCEL_DIR).filter(f => /\.(xlsx|xls)$/i.test(f));
    const catFiles = [];
    const colSet   = new Set();

    for (const f of files) {
      try {
        const { columns } = getCachedRows(f);
        if (detectExcelType(columns) === category) {
          catFiles.push(f);
          columns.forEach(c => colSet.add(c));
        }
      } catch (_) {}
    }

    if (catFiles.length === 0) {
      return res.json({ columns: [], rows: [], total: 0, filtered: 0,
        type: category, summary: {}, monthlyChart: [], files: [],
        page: 1, pageSize: 100, totalPages: 0 });
    }

    const columns = [...colSet];
    const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');

    // Merge all rows, tagging each with its source file
    const allRows = [];
    for (const f of catFiles) {
      getCachedRows(f).rows.forEach(row => allRows.push({ ...row, _file: f }));
    }

    // Date filter
    let filtered = allRows;
    if (dateCol && (dateFrom || dateTo)) {
      filtered = allRows.filter(row => {
        const ds = normalizeExcelDate(row[dateCol]);
        if (!ds) return true;
        if (dateFrom && ds < dateFrom) return false;
        if (dateTo   && ds > dateTo)   return false;
        return true;
      });
    }

    // Search filter
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(row =>
        Object.values(row).some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q))
      );
    }

    // Monthly chart
    const monthMap = {};
    if (dateCol) {
      filtered.forEach(row => {
        const ds = normalizeExcelDate(row[dateCol]);
        if (!ds || ds.length < 7) return;
        const mo = ds.substring(0, 7);
        monthMap[mo] = (monthMap[mo] || 0) + 1;
      });
    }
    const monthlyChart = Object.entries(monthMap)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, count]) => ({ label, count }));

    const summary  = excelSummary(category, filtered, columns);

    // Per-file breakdown (total rows vs filtered rows)
    const fileBreakdown = catFiles.map(f => ({
      name:     f,
      total:    allRows .filter(r => r._file === f).length,
      filtered: filtered.filter(r => r._file === f).length
    }));

    const total         = allRows.length;
    const filteredTotal = filtered.length;
    const pageInt       = Math.max(1, parseInt(page));
    const pageSizeInt   = Math.min(500, Math.max(1, parseInt(pageSize)));
    const paginatedRows = filtered.slice((pageInt-1)*pageSizeInt, pageInt*pageSizeInt);

    res.json({
      columns: [...columns, '_file'],
      rows: paginatedRows,
      total, filtered: filteredTotal,
      dateColumn: dateCol || null,
      monthlyChart, type: category, summary,
      files: fileBreakdown,
      page: pageInt, pageSize: pageSizeInt,
      totalPages: Math.ceil(filteredTotal / pageSizeInt)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/excel/category-export  — download all filtered rows as XLSX
app.post('/api/excel/category-export', requireAuth, (req, res) => {
  try {
    const { category, dateFrom, dateTo, search } = req.body;
    if (!category) return res.status(400).json({ error: 'category required' });

    const files = fs.readdirSync(EXCEL_DIR).filter(f => /\.(xlsx|xls)$/i.test(f));
    const colSet = new Set();
    const catFiles = [];
    for (const f of files) {
      try {
        const { columns } = getCachedRows(f);
        if (detectExcelType(columns) === category) { catFiles.push(f); columns.forEach(c => colSet.add(c)); }
      } catch (_) {}
    }

    const columns = [...colSet];
    const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');

    let rows = [];
    for (const f of catFiles) getCachedRows(f).rows.forEach(row => rows.push({ ...row, _file: f }));

    if (dateCol && (dateFrom || dateTo)) {
      rows = rows.filter(row => {
        const ds = normalizeExcelDate(row[dateCol]);
        if (!ds) return true;
        if (dateFrom && ds < dateFrom) return false;
        if (dateTo   && ds > dateTo)   return false;
        return true;
      });
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(row => Object.values(row).some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q)));
    }

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows, { header: [...columns, '_file'] });
    xlsx.utils.book_append_sheet(wb, ws, category.substring(0, 31));
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${category}-export.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/excel/alerts — rule-based smart alerts from all Excel data
app.get('/api/excel/alerts', requireAuth, (req, res) => {
  try {
    const alerts = [];
    const files = fs.readdirSync(EXCEL_DIR).filter(f => /\.(xlsx|xls)$/i.test(f));

    // Build per-category data (columns + rows) using cache
    const catData = {};
    for (const f of files) {
      try {
        const { columns, rows } = getCachedRows(f);
        const type = detectExcelType(columns);
        if (!catData[type]) catData[type] = { columns: [], rows: [] };
        rows.forEach(r => catData[type].rows.push({ ...r, _file: f }));
        columns.forEach(c => { if (!catData[type].columns.includes(c)) catData[type].columns.push(c); });
      } catch (_) {}
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const thisMo = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const lastMoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMo = `${lastMoDate.getFullYear()}-${pad(lastMoDate.getMonth() + 1)}`;

    const moFilter = (rows, columns, mo) => {
      const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
      if (!dateCol) return [];
      return rows.filter(r => {
        const ds = normalizeExcelDate(r[dateCol]);
        return ds && ds.substring(0, 7) === mo;
      });
    };

    // ── Rule 1: Wastage spike (this month vs last month > 20%)
    if (catData.wasted) {
      const { rows, columns } = catData.wasted;
      const thisCount = moFilter(rows, columns, thisMo).length;
      const lastCount = moFilter(rows, columns, lastMo).length;
      if (lastCount > 0 && thisCount > lastCount * 1.2) {
        const pct = Math.round((thisCount - lastCount) / lastCount * 100);
        alerts.push({
          id: 'wastage_spike',
          severity: pct > 50 ? 'critical' : 'warning',
          icon: 'trash',
          title: 'Wastage Spike Detected',
          message: `Blood wastage is up ${pct}% compared to last month (${thisCount} vs ${lastCount} units). Review expiry management.`,
          category: 'wasted'
        });
      }
    }

    // ── Rule 2: High IAT positive rate (> 5% of this month's requests)
    if (catData.requests) {
      const { rows, columns } = catData.requests;
      const thisRows = moFilter(rows, columns, thisMo);
      const iatCol = excelFindCol(columns, 'iat');
      if (iatCol && thisRows.length >= 5) {
        const iatPos = thisRows.filter(r => /pos|\+/i.test(String(r[iatCol] || ''))).length;
        const iatPct = (iatPos / thisRows.length) * 100;
        if (iatPct > 5) {
          alerts.push({
            id: 'iat_high',
            severity: iatPct > 10 ? 'critical' : 'warning',
            icon: 'flask',
            title: 'High IAT Positive Rate',
            message: `${iatPct.toFixed(1)}% of blood requests this month are IAT positive (${iatPos} of ${thisRows.length}). Check for alloimmunized patients.`,
            category: 'requests'
          });
        }
      }
    }

    // ── Rule 3: Requests surge (this month > last month by > 30%)
    if (catData.requests) {
      const { rows, columns } = catData.requests;
      const thisCount = moFilter(rows, columns, thisMo).length;
      const lastCount = moFilter(rows, columns, lastMo).length;
      if (lastCount > 0 && thisCount > lastCount * 1.3) {
        const pct = Math.round((thisCount - lastCount) / lastCount * 100);
        alerts.push({
          id: 'requests_surge',
          severity: pct > 60 ? 'critical' : 'warning',
          icon: 'chart',
          title: 'Blood Requests Surge',
          message: `Requests jumped ${pct}% vs last month (${thisCount} vs ${lastCount}). Consider increasing stock levels.`,
          category: 'requests'
        });
      }
    }

    // ── Rule 4: High return rate in transfusion (returned > 15% of issued)
    if (catData.transfusion) {
      const { rows, columns } = catData.transfusion;
      const thisRows = moFilter(rows, columns, thisMo);
      const retCol = excelFindCol(columns, 'returned');
      if (retCol && thisRows.length >= 5) {
        const returned = thisRows.filter(r => /yes|1|true/i.test(String(r[retCol] || ''))).length;
        const retPct = (returned / thisRows.length) * 100;
        if (retPct > 15) {
          alerts.push({
            id: 'high_return_rate',
            severity: retPct > 30 ? 'critical' : 'warning',
            icon: 'return',
            title: 'High Transfusion Return Rate',
            message: `${retPct.toFixed(1)}% of issued units were returned this month (${returned} of ${thisRows.length}). Investigate over-ordering.`,
            category: 'transfusion'
          });
        }
      }
    }

    // ── Rule 5: Rare blood group — very few donations this month
    if (catData.donors) {
      const { rows, columns } = catData.donors;
      const thisRows = moFilter(rows, columns, thisMo);
      const groupCol = excelFindCol(columns, 'group');
      if (groupCol && thisRows.length > 0) {
        const rareGroups = ['AB-', 'B-', 'O-', 'A-'];
        const groupCounts = {};
        thisRows.forEach(r => {
          const g = String(r[groupCol] || '').trim().toUpperCase();
          if (g) groupCounts[g] = (groupCounts[g] || 0) + 1;
        });
        const shortage = rareGroups.filter(g => !groupCounts[g] || groupCounts[g] < 2);
        if (shortage.length > 0) {
          const critical = shortage.some(g => g === 'O-' || g === 'AB-');
          alerts.push({
            id: 'rare_blood_low',
            severity: critical ? 'critical' : 'warning',
            icon: 'blood',
            title: 'Rare Blood Group Shortage',
            message: `Critical blood groups with very few or no donations this month: ${shortage.join(', ')}. Drive donation campaigns.`,
            category: 'donors'
          });
        }
      }
    }

    // ── Rule 6: Near-expiry units sent (≤ 7 days to expiry)
    if (catData.sent_to_centres) {
      const { rows, columns } = catData.sent_to_centres;
      const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
      const expiryCol = excelFindCol(columns, 'expiry');
      if (dateCol && expiryCol) {
        const thisRows = moFilter(rows, columns, thisMo);
        const nearExpiry = thisRows.filter(r => {
          const sent = new Date(normalizeExcelDate(r[dateCol]));
          const exp  = new Date(normalizeExcelDate(r[expiryCol]));
          if (isNaN(sent) || isNaN(exp)) return false;
          const days = (exp - sent) / 86400000;
          return days >= 0 && days <= 14;
        }).length;
        if (nearExpiry > 0) {
          alerts.push({
            id: 'near_expiry_sent',
            severity: nearExpiry >= 5 ? 'critical' : 'warning',
            icon: 'clock',
            title: 'Near-Expiry Units Sent Out',
            message: `${nearExpiry} unit${nearExpiry > 1 ? 's' : ''} sent to other centres this month had 14 days or less until expiry. Review inventory rotation.`,
            category: 'sent_to_centres'
          });
        }
      }
    }

    // ── Rule 7: Expiry-related waste > 50% of total waste this month
    if (catData.wasted) {
      const { rows, columns } = catData.wasted;
      const thisRows = moFilter(rows, columns, thisMo);
      const reasonCol = excelFindCol(columns, 'reason');
      if (reasonCol && thisRows.length >= 3) {
        const expiryWaste = thisRows.filter(r => /expir|منتهي|تالف/i.test(String(r[reasonCol] || ''))).length;
        const pct = (expiryWaste / thisRows.length) * 100;
        if (pct > 50 && !alerts.find(a => a.id === 'wastage_spike')) {
          alerts.push({
            id: 'expiry_waste_high',
            severity: 'warning',
            icon: 'calendar',
            title: 'High Expiry-Related Waste',
            message: `${pct.toFixed(0)}% of wasted units this month expired before use (${expiryWaste} of ${thisRows.length}). Consider earlier redistribution to centres.`,
            category: 'wasted'
          });
        }
      }
    }

    // Sort: critical first, then warning
    alerts.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));

    res.json({ alerts, generatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/excel/query', requireAuth, (req, res) => {
  try {
    const { filename, dateFrom, dateTo, page = 1, pageSize = 100 } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const filePath = path.join(EXCEL_DIR, path.basename(filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Read as arrays first so we can deduplicate column headers
    const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rawRows.length === 0) {
      return res.json({ columns: [], rows: [], total: 0, filtered: 0, dateColumn: null, monthlyChart: [], type: 'generic', summary: {} });
    }

    // Build unique column names (handles duplicate headers like two "Component" columns)
    const headerRow = rawRows[0];
    const columns = [];
    const colSeen = {};
    headerRow.forEach(h => {
      const name = String(h).trim() || '(empty)';
      colSeen[name] = (colSeen[name] || 0);
      columns.push(colSeen[name] === 0 ? name : `${name}_${colSeen[name]}`);
      colSeen[name]++;
    });

    // Build object rows
    const rows = rawRows.slice(1)
      .filter(r => r.some(v => v !== '' && v !== null && v !== undefined))
      .map(r => {
        const obj = {};
        columns.forEach((c, i) => { obj[c] = r[i] ?? ''; });
        return obj;
      });

    if (rows.length === 0) {
      return res.json({ columns, rows: [], total: 0, filtered: 0, dateColumn: null, monthlyChart: [], type: detectExcelType(columns), summary: {} });
    }

    const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');

    function normalizeDate(val) {
      if (!val && val !== 0) return '';
      if (val instanceof Date) return val.toISOString().split('T')[0];
      const s = String(val).trim();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
      return s;
    }

    const normalizedRows = rows.map(row => {
      const nr = {};
      for (const [k, v] of Object.entries(row)) {
        nr[k] = (v instanceof Date) ? normalizeDate(v) : v;
      }
      return nr;
    });

    let filtered = normalizedRows;
    if (dateCol && (dateFrom || dateTo)) {
      filtered = normalizedRows.filter(row => {
        const ds = normalizeDate(row[dateCol]);
        if (!ds) return true;
        if (dateFrom && ds < dateFrom) return false;
        if (dateTo   && ds > dateTo)   return false;
        return true;
      });
    }

    // Monthly chart
    const monthMap = {};
    if (dateCol) {
      filtered.forEach(row => {
        const ds = normalizeDate(row[dateCol]);
        if (!ds || ds.length < 7) return;
        const month = ds.substring(0, 7);
        monthMap[month] = (monthMap[month] || 0) + 1;
      });
    }
    const monthlyChart = Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, count]) => ({ label, count }));

    const type          = detectExcelType(columns);
    const summary       = excelSummary(type, filtered, columns);
    const total         = normalizedRows.length;
    const filteredTotal = filtered.length;
    const pageInt       = Math.max(1, parseInt(page));
    const pageSizeInt   = Math.min(500, Math.max(1, parseInt(pageSize)));
    const paginatedRows = filtered.slice((pageInt - 1) * pageSizeInt, pageInt * pageSizeInt);

    res.json({
      columns, rows: paginatedRows,
      total, filtered: filteredTotal,
      dateColumn: dateCol || null,
      monthlyChart, type, summary,
      page: pageInt, pageSize: pageSizeInt,
      totalPages: Math.ceil(filteredTotal / pageSizeInt)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("✅ Blood Bank server running on http://localhost:3000"));