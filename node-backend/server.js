require("dotenv").config();

const http      = require("http");
const express   = require("express");
const { Server: IOServer } = require("socket.io");
const multer    = require("multer");
const axios     = require("axios");
const FormData  = require("form-data");
const fs        = require("fs");
const cors      = require("cors");
const helmet    = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path      = require("path");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const { parseVoiceToFields, splitBatchTranscript } = require("./voiceParser");
const { getEdelphynPool, resetEdelphynPool, testEdelphynConnection } = require("./edelphynDb");
const { runCategoryQuery, CATEGORIES: EDELPHYN_CATEGORIES } = require("./edelphynQueries");
const analyticsQueries = require("./edelphynAnalyticsQueries");
const settingsStore = require("./settingsStore");
// Same module instance initDB() lazily wires `getPool`/`sql` from below — required
// directly here too so Settings routes can reset/test the pool without waiting on initDB().
const dbModule = require("./db");

// ── e-Delphyn live category cache: `${category}|${from}|${to}` → { columns, rows, fetchedAt } ──
// Keeps the dashboard near-real-time (60s) without re-querying the hospital's
// production LIS on every click/filter change.
const CATEGORY_CACHE_TTL = 60_000;
const categoryCache = new Map();

async function getCategoryRows(category, dateFrom, dateTo) {
  const key = `${category}|${dateFrom}|${dateTo}`;
  const cached = categoryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CATEGORY_CACHE_TTL) return cached;
  const pool  = await getEdelphynPool();
  const fresh = await runCategoryQuery(pool, category, dateFrom, dateTo);
  const entry = { columns: fresh.columns, rows: fresh.rows, fetchedAt: Date.now() };
  categoryCache.set(key, entry);
  return entry;
}

function ymdLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// eDelphyn queries use an exclusive end date; dashboard date pickers are inclusive.
function nextDayStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Classifies a transfusion row's [Component] text into prc/ffp/plt — mirrors the
// old RBC/PLASMA/PLATELETS Excel file split. Tune these patterns against the real
// DES_COMPONENT values once connected to the live eDelphyn database.
function classifyComponent(name) {
  const s = String(name || '').toLowerCase();
  if (/plat/.test(s)) return 'plt';
  if (/plasma|ffp/.test(s)) return 'ffp';
  if (/red|rbc|prc|pack/.test(s)) return 'prc';
  return null;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set in .env — server will not start");
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);
const io     = new IOServer(server, { cors: { origin: false } });

// ── Socket.io auth middleware ────────────────────────────────────
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// ── Online departments tracker ───────────────────────────────────
const onlineDepts = new Map(); // dept -> socket count

// ── Socket.io connection ─────────────────────────────────────────
io.on('connection', async (socket) => {
  const dept = socket.user.department || 'BLOOD BANK';
  socket.join(dept);
  // Admins additionally join a role-wide room so they can be notified of
  // things no single department chat room covers — e.g. new transfusion
  // requests (see POST /forms/save).
  if (socket.user.role === 'admin') socket.join('admins');
  // Same idea for staff (nurses) — alerted when the blood bank sends a
  // delivery, regardless of which department they're logged in under.
  if (socket.user.role === 'staff') socket.join('staff');

  // Online presence
  onlineDepts.set(dept, (onlineDepts.get(dept) || 0) + 1);
  io.emit('dept_status', { dept, online: true });

  socket.on('disconnect', () => {
    const n = (onlineDepts.get(dept) || 1) - 1;
    if (n <= 0) { onlineDepts.delete(dept); io.emit('dept_status', { dept, online: false }); }
    else onlineDepts.set(dept, n);
  });

  // Typing indicator
  socket.on('typing', ({ to_dept, typing }) => {
    if (dept !== 'BLOOD BANK' && to_dept !== 'BLOOD BANK') return;
    io.to(to_dept).emit('typing', { from_dept: dept, typing });
  });

  // Mark messages read
  socket.on('mark_read', async ({ from_dept }) => {
    try {
      const pool = await getPool();
      await pool.request()
        .input('fdept', sql.NVarChar, from_dept)
        .input('tdept', sql.NVarChar, dept)
        .query(`UPDATE ChatMessages SET read_at=GETDATE()
                WHERE from_dept=@fdept AND to_dept=@tdept AND read_at IS NULL`);
      io.to(from_dept).emit('messages_read', { by_dept: dept });
    } catch (err) { console.error('[chat read]', err.message); }
  });

  // Send message (supports urgent + file attachment)
  socket.on('send_message', async ({ to_dept, message, urgent, file_url, file_name }) => {
    if (!to_dept) return;
    if (dept !== 'BLOOD BANK' && to_dept !== 'BLOOD BANK') return;
    if (!message?.trim() && !file_url) return;
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('uid',       sql.Int,      socket.user.userId)
        .input('name',      sql.NVarChar, socket.user.fullName)
        .input('fdept',     sql.NVarChar, dept)
        .input('tdept',     sql.NVarChar, to_dept)
        .input('msg',       sql.NVarChar, (message || '').trim().slice(0, 2000))
        .input('urgent',    sql.TinyInt,  urgent ? 1 : 0)
        .input('file_url',  sql.NVarChar, file_url  || null)
        .input('file_name', sql.NVarChar, file_name || null)
        .query(`INSERT INTO ChatMessages (from_user_id,from_name,from_dept,to_dept,message,urgent,file_url,file_name)
                OUTPUT INSERTED.message_id, CONVERT(VARCHAR(19),INSERTED.created_at,120) AS created_at
                VALUES (@uid,@name,@fdept,@tdept,@msg,@urgent,@file_url,@file_name)`);
      const msg = {
        message_id: r.recordset[0].message_id,
        from_name:  socket.user.fullName,
        from_dept:  dept,
        to_dept,
        message:    (message || '').trim(),
        urgent:     urgent ? 1 : 0,
        file_url:   file_url  || null,
        file_name:  file_name || null,
        created_at: r.recordset[0].created_at,
        read_at:    null,
        own:        false,
      };
      io.to(dept).emit('new_message', { ...msg, own: true });
      if (to_dept !== dept) io.to(to_dept).emit('new_message', msg);
    } catch (err) { console.error('[chat]', err.message); }
  });
});

// ── Security headers ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // frontend uses inline scripts/styles
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — restrict to same host (internal network only) ────────
app.use(cors({ origin: false }));

// ── Login rate limiter: 10 attempts per 15 min per IP ───────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
});

app.use(express.json({ limit: '20mb' })); // raised for base64 chart-image exports
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({ dest: "uploads/" });

// ── DB (optional — won't crash if unavailable) ──────────────────
let dbReady = false;
let getPool, sql;

// Re-callable: also used by Settings → Save/Reload to pick up new
// credentials without restarting the process. The IF NOT EXISTS migrations
// below are idempotent, so re-running them on an already-migrated DB is safe.
async function initDB() {
  try {
    getPool = dbModule.getPool;
    sql     = dbModule.sql;
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

    // ── Migrate: physician/life-saving signature columns ───────────
    // These hold a base64 PNG data URL captured from the draw-to-sign
    // canvas (easily several KB), so they need NVARCHAR(MAX), not a short
    // text column. The ALTER COLUMN lines widen anyone who already has
    // these columns from an earlier NVARCHAR(200) version of this migration.
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='physician_signature')
        ALTER TABLE TransfusionRequests ADD physician_signature NVARCHAR(MAX) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='life_saving_signature')
        ALTER TABLE TransfusionRequests ADD life_saving_signature NVARCHAR(MAX) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='life_saving_signature')
        ALTER TABLE BloodDeliveries ADD life_saving_signature NVARCHAR(MAX) NULL;
      IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='physician_signature' AND CHARACTER_MAXIMUM_LENGTH <> -1)
        ALTER TABLE TransfusionRequests ALTER COLUMN physician_signature NVARCHAR(MAX) NULL;
      IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='life_saving_signature' AND CHARACTER_MAXIMUM_LENGTH <> -1)
        ALTER TABLE TransfusionRequests ALTER COLUMN life_saving_signature NVARCHAR(MAX) NULL;
      IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='life_saving_signature' AND CHARACTER_MAXIMUM_LENGTH <> -1)
        ALTER TABLE BloodDeliveries ALTER COLUMN life_saving_signature NVARCHAR(MAX) NULL;
    `);

    // ── Migrate: signature lock columns ─────────────────────────────
    // Once a record carries any signature, it records who (which logged-in
    // account) put it there. From then on, only that same account may
    // update or delete the record — enforced in /forms/update/:id and
    // /history/:id, with no admin override. Set once and never overwritten
    // (see the COALESCE in /forms/update/:id), so it's a permanent record
    // of the original signer even if the record is edited further by them.
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='signed_by_user_id')
        ALTER TABLE TransfusionRequests ADD signed_by_user_id INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='signed_by_name')
        ALTER TABLE TransfusionRequests ADD signed_by_name NVARCHAR(100) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='signed_at')
        ALTER TABLE TransfusionRequests ADD signed_at DATETIME NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='signed_by_user_id')
        ALTER TABLE BloodDeliveries ADD signed_by_user_id INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='signed_by_name')
        ALTER TABLE BloodDeliveries ADD signed_by_name NVARCHAR(100) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='signed_at')
        ALTER TABLE BloodDeliveries ADD signed_at DATETIME NULL;
    `);

    // ── Migrate: Notifications (persisted alert list for admins) ───
    // A new transfusion request writes one row here (see POST /forms/save)
    // in addition to the live socket push, so an admin who wasn't logged in
    // at the time still sees it in the bell list next time they open the
    // app. NotificationReads tracks per-admin read state, since more than
    // one admin account can exist and each should get their own unread
    // count rather than one shared "seen" flag.
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Notifications')
        CREATE TABLE Notifications (
          notification_id INT IDENTITY(1,1) PRIMARY KEY,
          type            NVARCHAR(50)  NOT NULL,
          request_id      INT           NULL,
          patient_name    NVARCHAR(200) NULL,
          file_number     NVARCHAR(100) NULL,
          blood_group     NVARCHAR(10)  NULL,
          rh_factor       NVARCHAR(10)  NULL,
          room            NVARCHAR(100) NULL,
          physician       NVARCHAR(200) NULL,
          life_saving     BIT           NOT NULL DEFAULT 0,
          saved_by        NVARCHAR(100) NULL,
          created_at      DATETIME      DEFAULT GETDATE()
        );
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='NotificationReads')
        CREATE TABLE NotificationReads (
          notification_id INT NOT NULL,
          user_id         INT NOT NULL,
          read_at         DATETIME DEFAULT GETDATE(),
          PRIMARY KEY (notification_id, user_id)
        );
    `);

    // ── Migrate: Irradiated RBC + extra Blood Components rows ──────
    // irr_units/irr_type are a first-class component type, same as
    // fpc/ffp/plt. components_json holds any additional rows added via the
    // "+" button beyond each type's first row (the first row of each type
    // still lives in its own flat column, unchanged) — see renderTCompTable
    // in index.html.
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='irr_units')
        ALTER TABLE TransfusionRequests ADD irr_units INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='irr_type')
        ALTER TABLE TransfusionRequests ADD irr_type NVARCHAR(20) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TransfusionRequests' AND COLUMN_NAME='components_json')
        ALTER TABLE TransfusionRequests ADD components_json NVARCHAR(MAX) NULL;
    `);

    // ── Migrate: "Components Issued" on the delivery form ───────────
    // Same "+ add another row" concept as the transfusion table, but for
    // "For Blood Bank Use Only" on the Delivery form — just a component +
    // Nº Units, no urgency. Each type's first row lives in its own flat
    // column; components_json holds any extra rows (see renderDCompTable
    // in index.html).
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='fpc_units')
        ALTER TABLE BloodDeliveries ADD fpc_units INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='ffp_units')
        ALTER TABLE BloodDeliveries ADD ffp_units INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='plt_units')
        ALTER TABLE BloodDeliveries ADD plt_units INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='irr_units')
        ALTER TABLE BloodDeliveries ADD irr_units INT NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='BloodDeliveries' AND COLUMN_NAME='components_json')
        ALTER TABLE BloodDeliveries ADD components_json NVARCHAR(MAX) NULL;
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

    // ── Migrate: department column + ChatMessages ─────────────────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='HospitalUsers' AND COLUMN_NAME='department')
        ALTER TABLE HospitalUsers ADD department NVARCHAR(100) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ChatMessages')
        CREATE TABLE ChatMessages (
          message_id   INT IDENTITY(1,1) PRIMARY KEY,
          from_user_id INT NOT NULL,
          from_name    NVARCHAR(100) NOT NULL,
          from_dept    NVARCHAR(100) NOT NULL,
          to_dept      NVARCHAR(100) NOT NULL,
          message      NVARCHAR(2000) NOT NULL,
          urgent       TINYINT NOT NULL DEFAULT 0,
          file_url     NVARCHAR(500) NULL,
          file_name    NVARCHAR(200) NULL,
          read_at      DATETIME NULL,
          created_at   DATETIME DEFAULT GETDATE()
        );
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ChatMessages' AND COLUMN_NAME='urgent')
        ALTER TABLE ChatMessages ADD urgent TINYINT NOT NULL DEFAULT 0;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ChatMessages' AND COLUMN_NAME='read_at')
        ALTER TABLE ChatMessages ADD read_at DATETIME NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ChatMessages' AND COLUMN_NAME='file_url')
        ALTER TABLE ChatMessages ADD file_url NVARCHAR(500) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ChatMessages' AND COLUMN_NAME='file_name')
        ALTER TABLE ChatMessages ADD file_name NVARCHAR(200) NULL;
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

    // ── Migrate: Departments table (admin-managed, replaces the two
    // hardcoded department lists that used to live in the frontend: the
    // Add/Edit User modal's dropdown and Chat's CHAT_DEPTS array) ───────
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Departments')
        CREATE TABLE Departments (
          department_id INT IDENTITY(1,1) PRIMARY KEY,
          name          NVARCHAR(100) NOT NULL UNIQUE,
          active        BIT           NOT NULL DEFAULT 1,
          sort_order    INT           NOT NULL DEFAULT 0,
          created_at    DATETIME      DEFAULT GETDATE()
        );
    `);
    const deptCount = await pool.request().query("SELECT COUNT(*) AS cnt FROM Departments");
    if (deptCount.recordset[0].cnt === 0) {
      // One-time seed from the list that used to be hardcoded in the
      // frontend, in the same order, so nothing changes for existing users.
      const seedDepartments = [
        'BLOOD BANK', 'CARDIOLOGY', 'CCU + ICU', 'CORONA 3300-3500', 'CORONA 3400',
        'CSU', 'DELIVERY', 'DIALYSIS', 'ENDOSCOPY', 'ER', 'ER CORONA', 'HAEMATOLOGY',
        'ICU 2 CORONA', 'ICU 3', 'ICU CORONA', 'INTERNAL MEDICINE 1', 'MHU',
        'NICU CORONA', 'NICU-PICU', 'NURSERY', 'OBS', 'ODC', 'ONCO ADULT',
        'ONCO PEDIATRIC', 'OPERATING THEATRE', 'OR', 'PEDIATRIC', 'RECOVERY',
        'SURGERY 1', 'WTTC',
      ];
      for (let i = 0; i < seedDepartments.length; i++) {
        await pool.request()
          .input('name', sql.NVarChar, seedDepartments[i])
          .input('sort', sql.Int, i)
          .query("INSERT INTO Departments (name, sort_order) VALUES (@name, @sort)");
      }
      console.log(`✅ Seeded ${seedDepartments.length} departments`);
    }

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
// Settings → Database credentials (admin only)
// Lets an admin edit the BloodBankDB / eDelphyn SQL Server connections from
// the UI instead of hand-editing node-backend/.env and restarting. Saved to
// node-backend/config/db-settings.json (see settingsStore.js).
// ════════════════════════════════════════════════════════════════
function sanitizeDbSettings(input = {}) {
  return {
    server:                 String(input.server || '').trim(),
    port:                   parseInt(input.port) || 1433,
    database:               String(input.database || '').trim(),
    user:                   String(input.user || '').trim(),
    password:               input.password !== undefined ? String(input.password) : '',
    windowsAuth:            !!input.windowsAuth,
    trustServerCertificate: input.trustServerCertificate !== false,
  };
}

app.get('/api/settings/db', requireAdmin, (req, res) => {
  res.json(settingsStore.loadSettings());
});

// Test arbitrary (not-yet-saved) credentials without touching the live pools.
app.post('/api/settings/db/test', requireAdmin, async (req, res) => {
  const { which, ...fields } = req.body || {};
  if (which !== 'bloodbank' && which !== 'edelphyn') {
    return res.status(400).json({ ok: false, error: "which must be 'bloodbank' or 'edelphyn'" });
  }
  const settings = sanitizeDbSettings(fields);
  const result = which === 'bloodbank'
    ? await dbModule.testConnection(settings)
    : await testEdelphynConnection(settings);
  res.json(result);
});

// BloodBankDB isn't hospital-editable — it's a brand-new local DB the app
// manages itself (schema auto-created by initDB() above), so only eDelphyn
// (the hospital's existing LIS) is exposed through Settings.
app.put('/api/settings/db', requireAdmin, async (req, res) => {
  const { edelphyn } = req.body || {};
  if (!edelphyn) return res.status(400).json({ error: 'edelphyn settings required' });
  settingsStore.saveSettings({ edelphyn: sanitizeDbSettings(edelphyn) });

  // Drop the live pool so the very next connection attempt picks up the new
  // credentials, then reconnect right away and report back.
  await resetEdelphynPool();
  let edelphynResult;
  try { await getEdelphynPool(); edelphynResult = { ok: true }; }
  catch (err) { edelphynResult = { ok: false, error: err.message }; }

  res.json({ saved: true, edelphyn: edelphynResult });
});

// Re-reads db-settings.json from disk (in case it was edited by hand) and
// reconnects with whatever it finds, without changing the file.
app.post('/api/settings/db/reload', requireAdmin, async (req, res) => {
  settingsStore.loadSettings({ fresh: true });
  await resetEdelphynPool();
  let edelphynResult;
  try { await getEdelphynPool(); edelphynResult = { ok: true }; }
  catch (err) { edelphynResult = { ok: false, error: err.message }; }

  res.json({ reloaded: true, edelphyn: edelphynResult });
});

// ════════════════════════════════════════════════════════════════
// POST /auth/login
// ════════════════════════════════════════════════════════════════
app.post('/auth/login', loginLimiter, async (req, res) => {
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
      { userId: user.user_id, username: user.username, fullName: user.full_name, role: user.role, department: user.department || 'BLOOD BANK' },
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
      "SELECT user_id, username, full_name, role, department, active, CONVERT(VARCHAR(19), created_at, 120) AS created_at FROM HospitalUsers ORDER BY created_at"
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
  const { username, full_name, password, role, department } = req.body;
  if (!username || !full_name || !password) return res.status(400).json({ error: 'username, full_name and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const validRole = (role === 'admin' || role === 'staff') ? role : 'staff';
  try {
    const pool = await getPool();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.request()
      .input('username',   sql.NVarChar, username.trim().toLowerCase())
      .input('full_name',  sql.NVarChar, full_name.trim())
      .input('hash',       sql.NVarChar, hash)
      .input('role',       sql.NVarChar, validRole)
      .input('department', sql.NVarChar, department || null)
      .query("INSERT INTO HospitalUsers (username, full_name, password_hash, role, department) OUTPUT INSERTED.user_id VALUES (@username, @full_name, @hash, @role, @department)");
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
  const { full_name, role, active, department } = req.body;
  // Prevent admin from deactivating their own account
  if (parseInt(id) === req.user.userId && active === false) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('id',         sql.Int,      parseInt(id))
      .input('full_name',  sql.NVarChar, full_name)
      .input('role',       sql.NVarChar, role === 'admin' ? 'admin' : 'staff')
      .input('active',     sql.Bit,      active ? 1 : 0)
      .input('department', sql.NVarChar, department || null)
      .query("UPDATE HospitalUsers SET full_name=@full_name, role=@role, active=@active, department=@department WHERE user_id=@id");
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
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
// Departments — the single source of truth for the department picklist
// used by the Add/Edit User modal and Chat's department sidebar. Not a
// hard foreign key: HospitalUsers.department and ChatMessages.from_dept/
// to_dept stay free-text NVARCHAR, so removing a department here never
// invalidates historical records — it just stops showing up as a choice
// for *new* ones. "BLOOD BANK" is the app's own home department (hardcoded
// in login/chat/JWT logic elsewhere) and can't be renamed or deactivated.
// ════════════════════════════════════════════════════════════════

// GET /api/departments — any authenticated user (needed for Chat + the
// user modal, not just admins). ?includeInactive=1 for the Settings page.
app.get('/api/departments', requireAuth, async (req, res) => {
  try {
    const pool = await getPool();
    const includeInactive = req.query.includeInactive === '1';
    const result = await pool.request().query(
      `SELECT department_id, name, active, sort_order FROM Departments
       ${includeInactive ? '' : 'WHERE active = 1'}
       ORDER BY sort_order, name`
    );
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/departments  (admin only) — add a new department
app.post('/api/departments', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim().toUpperCase();
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  try {
    const pool = await getPool();
    const maxOrder = await pool.request().query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM Departments');
    const result = await pool.request()
      .input('name', sql.NVarChar, name)
      .input('sort', sql.Int, maxOrder.recordset[0].m + 1)
      .query('INSERT INTO Departments (name, sort_order) OUTPUT INSERTED.department_id VALUES (@name, @sort)');
    res.json({ success: true, department_id: result.recordset[0].department_id });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
      return res.status(409).json({ error: 'A department with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/departments/:id  (admin only) — rename and/or toggle active
app.put('/api/departments/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    const current = await pool.request().input('id', sql.Int, parseInt(id))
      .query('SELECT name FROM Departments WHERE department_id=@id');
    if (!current.recordset[0]) return res.status(404).json({ error: 'Department not found' });
    if (current.recordset[0].name === 'BLOOD BANK') {
      return res.status(400).json({ error: 'BLOOD BANK is the app\'s home department and cannot be renamed or deactivated' });
    }
    const name   = req.body.name !== undefined ? req.body.name.trim().toUpperCase() : current.recordset[0].name;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : undefined;
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    await pool.request()
      .input('id',     sql.Int,      parseInt(id))
      .input('name',   sql.NVarChar, name)
      .input('active', sql.Bit,      active !== undefined ? active : 1)
      .query(active !== undefined
        ? 'UPDATE Departments SET name=@name, active=@active WHERE department_id=@id'
        : 'UPDATE Departments SET name=@name WHERE department_id=@id');
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
      return res.status(409).json({ error: 'A department with this name already exists' });
    }
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

// A record with any drawn signature on it locks to whichever logged-in
// account saved it — from then on nobody else (not even an admin) can
// update or delete it. See /forms/update/:id and /history/:id.
function hasSignature(fields, formType) {
  if (formType === "transfusion") return !!(fields.physician_signature || fields.ls_signature_t);
  return !!fields.ls_signature_d;
}

// Returns { locked: true, signedByName } when this record is signed and the
// requesting account isn't the one who signed it — callers must refuse the
// write in that case, with no role-based exception (admins included).
async function checkSignatureLock(pool, formType, id, userId) {
  const table = formType === "transfusion" ? "TransfusionRequests" : "BloodDeliveries";
  const idCol = formType === "transfusion" ? "request_id" : "delivery_id";
  const result = await pool.request()
    .input("id", sql.Int, id)
    .query(`SELECT signed_by_user_id, signed_by_name FROM ${table} WHERE ${idCol} = @id`);
  const row = result.recordset[0];
  if (!row || row.signed_by_user_id == null || row.signed_by_user_id === userId) return { locked: false };
  return { locked: true, signedByName: row.signed_by_name };
}

// ════════════════════════════════════════════════════════════════
// POST /forms/save
// ════════════════════════════════════════════════════════════════
app.post("/forms/save", requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "Database not connected. Check db.js configuration." });

  const { form_type, ...fields } = req.body;
  const signed          = hasSignature(fields, form_type);
  const signedByUserId  = signed ? (req.user?.userId   || null) : null;
  const signedByName    = signed ? (req.user?.fullName || null) : null;

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
        .input("irr_units",                 sql.Int,      parseInt(fields.irr_units) || null)
        .input("irr_type",                  sql.NVarChar, fields.irr_type || null)
        .input("components_json",           sql.NVarChar, fields.components_json || null)
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
        .input("physician_signature",       sql.NVarChar, fields.physician_signature || null)
        .input("phlebotomist",              sql.NVarChar, fields.phlebotomist || null)
        .input("life_saving",               sql.Bit,      fields.life_saving_t ? 1 : 0)
        .input("life_saving_physician",     sql.NVarChar, fields.ls_physician_t || null)
        .input("life_saving_signature",     sql.NVarChar, fields.ls_signature_t || null)
        .input("life_saving_time",          sql.NVarChar, fields.ls_time_t || null)
        .input("saved_by",                  sql.NVarChar, req.user?.fullName || null)
        .input("signed_by_user_id",         sql.Int,      signedByUserId)
        .input("signed_by_name",            sql.NVarChar, signedByName)
        .query(`INSERT INTO TransfusionRequests (
          request_date, request_time, room, patient_name, file_number,
          blood_group, rh_factor, diagnosis,
          fpc_units, fpc_type, ffp_units, ffp_type, plt_units, plt_type,
          irr_units, irr_type, components_json,
          blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
          blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
          previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
          physician, physician_signature, phlebotomist,
          life_saving, life_saving_physician, life_saving_signature, life_saving_time,
          saved_by, signed_by_user_id, signed_by_name, signed_at
        ) OUTPUT INSERTED.request_id
        VALUES (
          @request_date, @request_time, @room, @patient_name, @file_number,
          @blood_group, @rh_factor, @diagnosis,
          @fpc_units, @fpc_type, @ffp_units, @ffp_type, @plt_units, @plt_type,
          @irr_units, @irr_type, @components_json,
          @blood_unit_1, @blood_unit_2, @blood_unit_3, @blood_unit_4,
          @blood_unit_5, @blood_unit_6, @blood_unit_7, @blood_unit_8,
          @previous_transfusion, @prev_transfusion_place, @prev_transfusion_reaction,
          @physician, @physician_signature, @phlebotomist,
          @life_saving, @life_saving_physician, @life_saving_signature, @life_saving_time,
          @saved_by, @signed_by_user_id, @signed_by_name, ${signedByUserId ? 'GETDATE()' : 'NULL'}
        )`);

      const newId = result.recordset[0].request_id;

      // Persist the alert (so an admin who's offline right now still sees
      // it in the bell list on next login), then push it live to whoever's
      // connected. The insert is best-effort — a hiccup here must never
      // fail the save itself, which already succeeded above.
      let notifRow = null;
      try {
        const notifResult = await pool.request()
          .input('type',         sql.NVarChar, 'new_transfusion_request')
          .input('request_id',   sql.Int,      newId)
          .input('patient_name', sql.NVarChar, fields.patient_name || null)
          .input('file_number',  sql.NVarChar, fields.file_number || null)
          .input('blood_group',  sql.NVarChar, fields.blood_group || null)
          .input('rh_factor',    sql.NVarChar, fields.rh_factor || null)
          .input('room',         sql.NVarChar, fields.room || null)
          .input('physician',    sql.NVarChar, fields.physician || null)
          .input('life_saving',  sql.Bit,      fields.life_saving_t ? 1 : 0)
          .input('saved_by',     sql.NVarChar, req.user?.fullName || null)
          .query(`INSERT INTO Notifications (
            type, request_id, patient_name, file_number, blood_group, rh_factor,
            room, physician, life_saving, saved_by
          ) OUTPUT INSERTED.notification_id, CONVERT(VARCHAR(19), INSERTED.created_at, 120) AS created_at
          VALUES (@type, @request_id, @patient_name, @file_number, @blood_group, @rh_factor,
            @room, @physician, @life_saving, @saved_by)`);
        notifRow = notifResult.recordset[0];
      } catch (notifErr) {
        console.error('[notifications] failed to persist new_transfusion_request:', notifErr.message);
      }

      // Real-time alert to every connected admin — works from any page,
      // same mechanism as department chat (see io.on('connection') above).
      io.to('admins').emit('new_transfusion_request', {
        notification_id: notifRow?.notification_id || null,
        id: newId,
        patient_name: fields.patient_name || 'Unknown patient',
        file_number:  fields.file_number  || '',
        blood_group:  fields.blood_group  || '',
        rh_factor:    fields.rh_factor    || '',
        room:         fields.room         || '',
        physician:    fields.physician    || '',
        life_saving:  !!fields.life_saving_t,
        saved_by:     req.user?.fullName  || 'Unknown',
        created_at:   notifRow?.created_at || new Date().toISOString(),
      });

      return res.json({ success: true, id: newId });

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
        .input("fpc_units",                   sql.Int,      parseInt(fields.d_fpc_units) || null)
        .input("ffp_units",                   sql.Int,      parseInt(fields.d_ffp_units) || null)
        .input("plt_units",                   sql.Int,      parseInt(fields.d_plt_units) || null)
        .input("irr_units",                   sql.Int,      parseInt(fields.d_irr_units) || null)
        .input("components_json",             sql.NVarChar, fields.d_components_json || null)
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
        .input("life_saving_signature",       sql.NVarChar, fields.ls_signature_d || null)
        .input("life_saving_time",            sql.NVarChar, fields.ls_time_d || null)
        .input("saved_by",                    sql.NVarChar, req.user?.fullName || null)
        .input("signed_by_user_id",           sql.Int,      signedByUserId)
        .input("signed_by_name",              sql.NVarChar, signedByName)
        .query(`INSERT INTO BloodDeliveries (
          patient_name, file_number, patient_blood_group, patient_rh, room,
          known_allergies, type_of_blood_requested, blood_unit_numbers,
          type_of_blood, fpc_units, ffp_units, plt_units, irr_units, components_json,
          blood_unit_group, patient_blood_group_delivery,
          technician_name, orderly_name, nurse_name,
          delivery_date, delivery_time,
          leakage, gases, volume, expiry_date, temperature_c,
          received_by, nurse_unit_received_by, nurse_unit_name, nurse_unit_date, nurse_unit_time,
          life_saving, life_saving_physician, life_saving_signature, life_saving_time,
          saved_by, signed_by_user_id, signed_by_name, signed_at
        ) OUTPUT INSERTED.delivery_id
        VALUES (
          @patient_name, @file_number, @patient_blood_group, @patient_rh, @room,
          @known_allergies, @type_of_blood_requested, @blood_unit_numbers,
          @type_of_blood, @fpc_units, @ffp_units, @plt_units, @irr_units, @components_json,
          @blood_unit_group, @patient_blood_group_delivery,
          @technician_name, @orderly_name, @nurse_name,
          @delivery_date, @delivery_time,
          @leakage, @gases, @volume, @expiry_date, @temperature_c,
          @received_by, @nurse_unit_received_by, @nurse_unit_name, @nurse_unit_date, @nurse_unit_time,
          @life_saving, @life_saving_physician, @life_saving_signature, @life_saving_time,
          @saved_by, @signed_by_user_id, @signed_by_name, ${signedByUserId ? 'GETDATE()' : 'NULL'}
        )`);

      const newDeliveryId = result.recordset[0].delivery_id;

      // Same pattern as the new-transfusion-request alert above: persist
      // (so a nurse who's offline right now still sees it in the bell list
      // next login), then push it live to whoever's connected. Best-effort —
      // never fails the save itself, which already succeeded above.
      let deliveryNotifRow = null;
      try {
        const notifResult = await pool.request()
          .input('type',         sql.NVarChar, 'new_delivery')
          .input('request_id',   sql.Int,      newDeliveryId)
          .input('patient_name', sql.NVarChar, fields.d_patient_name || null)
          .input('file_number',  sql.NVarChar, fields.d_file_number || null)
          .input('blood_group',  sql.NVarChar, fields.d_blood_group || null)
          .input('rh_factor',    sql.NVarChar, fields.d_rh || null)
          .input('room',         sql.NVarChar, fields.d_room || null)
          .input('life_saving',  sql.Bit,      fields.life_saving_d ? 1 : 0)
          .input('saved_by',     sql.NVarChar, req.user?.fullName || null)
          .query(`INSERT INTO Notifications (
            type, request_id, patient_name, file_number, blood_group, rh_factor,
            room, life_saving, saved_by
          ) OUTPUT INSERTED.notification_id, CONVERT(VARCHAR(19), INSERTED.created_at, 120) AS created_at
          VALUES (@type, @request_id, @patient_name, @file_number, @blood_group, @rh_factor,
            @room, @life_saving, @saved_by)`);
        deliveryNotifRow = notifResult.recordset[0];
      } catch (notifErr) {
        console.error('[notifications] failed to persist new_delivery:', notifErr.message);
      }

      // Real-time alert to every connected staff (nurse) account — works
      // from any page, same mechanism as the admin alert above.
      io.to('staff').emit('new_delivery', {
        notification_id: deliveryNotifRow?.notification_id || null,
        id: newDeliveryId,
        patient_name: fields.d_patient_name || 'Unknown patient',
        file_number:  fields.d_file_number  || '',
        blood_group:  fields.d_blood_group  || '',
        rh_factor:    fields.d_rh           || '',
        room:         fields.d_room         || '',
        life_saving:  !!fields.life_saving_d,
        saved_by:     req.user?.fullName    || 'Unknown',
        created_at:   deliveryNotifRow?.created_at || new Date().toISOString(),
      });

      return res.json({ success: true, id: newDeliveryId });
    }

    res.status(400).json({ error: "Invalid form_type" });

  } catch (err) {
    console.error("Save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// NOTIFICATIONS — persisted alert list backing the bell icon, shared by
// both roles: admins see 'new_transfusion_request' alerts (a nurse/tech
// just requested blood), staff see 'new_delivery' alerts (the blood bank
// just sent a delivery). Each role only ever queries its own type, so the
// two feeds never mix. Read state is tracked per account in
// NotificationReads, so each user gets their own unread count instead of
// one shared "seen" flag.
// ════════════════════════════════════════════════════════════════
function notificationTypeForRole(role) {
  return role === 'admin' ? 'new_transfusion_request' : 'new_delivery';
}

app.get("/notifications", requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ notifications: [], unread_count: 0 });
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input("uid",  sql.Int,      req.user.userId)
      .input("type", sql.NVarChar, notificationTypeForRole(req.user.role))
      .query(`
        SELECT TOP 50
          n.notification_id, n.type, n.request_id, n.patient_name, n.file_number,
          n.blood_group, n.rh_factor, n.room, n.physician, n.life_saving, n.saved_by,
          CONVERT(VARCHAR(19), n.created_at, 120) AS created_at,
          CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS is_read
        FROM Notifications n
        LEFT JOIN NotificationReads r ON r.notification_id = n.notification_id AND r.user_id = @uid
        WHERE n.type = @type
        ORDER BY n.created_at DESC
      `);
    const notifications = result.recordset.map(n => ({ ...n, is_read: !!n.is_read }));
    const unread_count  = notifications.filter(n => !n.is_read).length;
    res.json({ notifications, unread_count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/notifications/:id/read", requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ success: false });
  try {
    const pool = await getPool();
    await pool.request()
      .input("nid", sql.Int, req.params.id)
      .input("uid", sql.Int, req.user.userId)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM NotificationReads WHERE notification_id=@nid AND user_id=@uid)
          INSERT INTO NotificationReads (notification_id, user_id) VALUES (@nid, @uid);
      `);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/notifications/read-all", requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ success: false });
  try {
    const pool = await getPool();
    await pool.request()
      .input("uid",  sql.Int,      req.user.userId)
      .input("type", sql.NVarChar, notificationTypeForRole(req.user.role))
      .query(`
        INSERT INTO NotificationReads (notification_id, user_id)
        SELECT n.notification_id, @uid
        FROM Notifications n
        WHERE n.type = @type
          AND NOT EXISTS (SELECT 1 FROM NotificationReads r WHERE r.notification_id = n.notification_id AND r.user_id = @uid)
      `);
    res.json({ success: true });
  } catch (err) {
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
        irr_units, irr_type, components_json,
        blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
        blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
        previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
        physician, physician_signature, phlebotomist,
        request_date, request_time,
        life_saving, life_saving_physician, life_saving_signature, life_saving_time,
        saved_by, signed_by_user_id, signed_by_name,
        CONVERT(VARCHAR(19), signed_at, 120) AS signed_at,
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
        fpc_units, ffp_units, plt_units, irr_units, components_json,
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
        life_saving, life_saving_physician, life_saving_signature, life_saving_time,
        saved_by, signed_by_user_id, signed_by_name,
        CONVERT(VARCHAR(19), signed_at, 120) AS signed_at,
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
    const lock = await checkSignatureLock(pool, form_type, id, req.user.userId);
    if (lock.locked) {
      return res.status(403).json({ error: `This record was signed by ${lock.signedByName || 'another user'} — only they can delete it.` });
    }
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
  const signed          = hasSignature(fields, form_type);
  const signedByUserId  = signed ? (req.user?.userId   || null) : null;
  const signedByName    = signed ? (req.user?.fullName || null) : null;

  try {
    const pool = await getPool();

    const lock = await checkSignatureLock(pool, form_type, id, req.user.userId);
    if (lock.locked) {
      return res.status(403).json({ error: `This record was signed by ${lock.signedByName || 'another user'} — only they can edit it.` });
    }

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
        .input("irr_units",                  sql.Int,      parseInt(fields.irr_units) || null)
        .input("irr_type",                   sql.NVarChar, fields.irr_type || null)
        .input("components_json",            sql.NVarChar, fields.components_json || null)
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
        .input("physician_signature",        sql.NVarChar, fields.physician_signature || null)
        .input("phlebotomist",               sql.NVarChar, fields.phlebotomist || null)
        .input("life_saving",                sql.Bit,      fields.life_saving_t ? 1 : 0)
        .input("life_saving_physician",      sql.NVarChar, fields.ls_physician_t || null)
        .input("life_saving_signature",      sql.NVarChar, fields.ls_signature_t || null)
        .input("life_saving_time",           sql.NVarChar, fields.ls_time_t || null)
        .input("signed_by_user_id",          sql.Int,      signedByUserId)
        .input("signed_by_name",             sql.NVarChar, signedByName)
        .query(`UPDATE TransfusionRequests SET
          request_date=@request_date, request_time=@request_time, room=@room,
          patient_name=@patient_name, file_number=@file_number,
          blood_group=@blood_group, rh_factor=@rh_factor, diagnosis=@diagnosis,
          fpc_units=@fpc_units, fpc_type=@fpc_type,
          ffp_units=@ffp_units, ffp_type=@ffp_type,
          plt_units=@plt_units, plt_type=@plt_type,
          irr_units=@irr_units, irr_type=@irr_type, components_json=@components_json,
          blood_unit_1=@blood_unit_1, blood_unit_2=@blood_unit_2,
          blood_unit_3=@blood_unit_3, blood_unit_4=@blood_unit_4,
          blood_unit_5=@blood_unit_5, blood_unit_6=@blood_unit_6,
          blood_unit_7=@blood_unit_7, blood_unit_8=@blood_unit_8,
          previous_transfusion=@previous_transfusion,
          prev_transfusion_place=@prev_transfusion_place,
          prev_transfusion_reaction=@prev_transfusion_reaction,
          physician=@physician, physician_signature=@physician_signature, phlebotomist=@phlebotomist,
          life_saving=@life_saving,
          life_saving_physician=@life_saving_physician,
          life_saving_signature=@life_saving_signature,
          life_saving_time=@life_saving_time,
          signed_by_user_id=COALESCE(signed_by_user_id, @signed_by_user_id),
          signed_by_name=COALESCE(signed_by_name, @signed_by_name),
          signed_at=COALESCE(signed_at, ${signedByUserId ? 'GETDATE()' : 'NULL'})
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
        .input("fpc_units",                   sql.Int,      parseInt(fields.d_fpc_units) || null)
        .input("ffp_units",                   sql.Int,      parseInt(fields.d_ffp_units) || null)
        .input("plt_units",                   sql.Int,      parseInt(fields.d_plt_units) || null)
        .input("irr_units",                   sql.Int,      parseInt(fields.d_irr_units) || null)
        .input("components_json",             sql.NVarChar, fields.d_components_json || null)
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
        .input("life_saving_signature",       sql.NVarChar, fields.ls_signature_d || null)
        .input("life_saving_time",            sql.NVarChar, fields.ls_time_d || null)
        .input("signed_by_user_id",           sql.Int,      signedByUserId)
        .input("signed_by_name",              sql.NVarChar, signedByName)
        .query(`UPDATE BloodDeliveries SET
          patient_name=@patient_name, file_number=@file_number,
          patient_blood_group=@patient_blood_group, patient_rh=@patient_rh, room=@room,
          known_allergies=@known_allergies,
          type_of_blood_requested=@type_of_blood_requested,
          blood_unit_numbers=@blood_unit_numbers,
          type_of_blood=@type_of_blood,
          fpc_units=@fpc_units, ffp_units=@ffp_units, plt_units=@plt_units, irr_units=@irr_units,
          components_json=@components_json,
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
          life_saving_signature=@life_saving_signature,
          life_saving_time=@life_saving_time,
          signed_by_user_id=COALESCE(signed_by_user_id, @signed_by_user_id),
          signed_by_name=COALESCE(signed_by_name, @signed_by_name),
          signed_at=COALESCE(signed_at, ${signedByUserId ? 'GETDATE()' : 'NULL'})
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
// POST /api/rag-chat — proxy to the local Python RAG chatbot service
// (rag-chatbot/app.py, offline Ollama + Chroma over the Excel data)
// ════════════════════════════════════════════════════════════════
app.post('/api/rag-chat', requireAuth, async (req, res) => {
  const { question, history } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });
  try {
    const ragRes = await axios.post(
      'http://127.0.0.1:5000/api/chat',
      { question, history: Array.isArray(history) ? history.slice(-6) : [] },
      { timeout: 180000 }
    );
    res.json(ragRes.data);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'RAG chatbot service not running. Start rag-chatbot/app.py first.' });
    }
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
      return res.status(504).json({ error: 'The AI assistant is taking longer than usual to respond. Try a simpler or more specific question.' });
    }
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
// GET /patient/history?file_number=xxx
// Full transfusion + delivery history for a patient
// ════════════════════════════════════════════════════════════════
app.get('/patient/history', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ found: false });
  const { file_number } = req.query;
  if (!file_number?.trim()) return res.json({ found: false });

  try {
    const pool = await getPool();
    const fn   = file_number.trim();

    const tRes = await pool.request()
      .input('fn', sql.NVarChar, fn)
      .query(`
        SELECT request_id AS id, patient_name, file_number,
          blood_group, rh_factor, room, diagnosis,
          fpc_units, fpc_type, ffp_units, ffp_type, plt_units, plt_type,
          irr_units, irr_type,
          physician, life_saving, prev_transfusion_reaction,
          saved_by,
          CONVERT(VARCHAR(10), created_at, 23)  AS date,
          CONVERT(VARCHAR(5),  created_at, 108) AS time
        FROM TransfusionRequests
        WHERE file_number = @fn
        ORDER BY created_at DESC`);

    const dRes = await pool.request()
      .input('fn', sql.NVarChar, fn)
      .query(`
        SELECT delivery_id AS id, patient_name, file_number,
          patient_blood_group AS blood_group, patient_rh AS rh_factor, room,
          fpc_units, ffp_units, plt_units, irr_units, components_json, blood_unit_group,
          technician_name, life_saving, known_allergies,
          saved_by,
          CONVERT(VARCHAR(10), created_at, 23)  AS date,
          CONVERT(VARCHAR(5),  created_at, 108) AS time
        FROM BloodDeliveries
        WHERE file_number = @fn
        ORDER BY created_at DESC`);

    const t = tRes.recordset;
    const d = dRes.recordset;

    if (!t.length && !d.length) return res.json({ found: false });

    const anchor = t[0] || d[0];
    const totalPrc = t.reduce((s, r) => s + (r.fpc_units || 0), 0);
    const totalFfp = t.reduce((s, r) => s + (r.ffp_units || 0), 0);
    const totalPlt = t.reduce((s, r) => s + (r.plt_units || 0), 0);
    const reactions = t
      .filter(r => r.prev_transfusion_reaction?.trim())
      .map(r => ({ date: r.date, note: r.prev_transfusion_reaction }));

    res.json({
      found: true,
      patient: {
        name:        anchor.patient_name,
        file_number: fn,
        blood_group: anchor.blood_group || '',
        rh_factor:   anchor.rh_factor   || '',
      },
      summary: {
        total_transfusions: t.length,
        total_deliveries:   d.length,
        total_prc:          totalPrc,
        total_ffp:          totalFfp,
        total_plt:          totalPlt,
        total_units:        totalPrc + totalFfp + totalPlt,
        has_reactions:      reactions.length > 0,
        reactions,
      },
      transfusions: t,
      deliveries:   d,
    });

  } catch (err) {
    res.status(500).json({ found: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /dashboard/wastage
// Compares ordered units (TransfusionRequests) vs delivered units
// (BloodDeliveries) for the same file number, component by component
// (Packed Cells / FFP / Platelets / Irradiated RBC). Both sides are the
// structured Nº Units fields — the first row of each type lives in its own
// flat column (fpc_units, ...), any extra rows added via "+" travel in
// components_json — so componentTotal() below adds both together.
// ════════════════════════════════════════════════════════════════
const WASTAGE_COMPONENT_LABELS = { fpc: 'Packed Cells', ffp: 'FFP', plt: 'Platelets', irr: 'Irradiated RBC' };

function componentTotal(row, key) {
  let total = parseInt(row[`${key}_units`]) || 0;
  if (row.components_json) {
    try {
      JSON.parse(row.components_json).forEach(c => {
        if (c.key === key) total += parseInt(c.units) || 0;
      });
    } catch (e) { /* ignore bad JSON */ }
  }
  return total;
}

app.get('/dashboard/wastage', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ error: 'db_not_ready' });
  try {
    const pool = await getPool();

    const deliveries = await pool.request().query(`
      SELECT delivery_id, patient_name, file_number,
        CONVERT(NVARCHAR, delivery_date, 23) AS date,
        fpc_units, ffp_units, plt_units, irr_units, components_json, created_at
      FROM BloodDeliveries
      WHERE file_number IS NOT NULL AND LEN(LTRIM(RTRIM(file_number))) > 0
        AND created_at >= DATEADD(day, -90, GETDATE())
        AND (fpc_units IS NOT NULL OR ffp_units IS NOT NULL OR plt_units IS NOT NULL OR irr_units IS NOT NULL
             OR (components_json IS NOT NULL AND LEN(components_json) > 2))
      ORDER BY created_at DESC
    `);

    const transfusions = await pool.request().query(`
      SELECT request_id, file_number, fpc_units, ffp_units, plt_units, irr_units, components_json, created_at
      FROM TransfusionRequests
      WHERE (fpc_units IS NOT NULL OR ffp_units IS NOT NULL OR plt_units IS NOT NULL OR irr_units IS NOT NULL
             OR (components_json IS NOT NULL AND LEN(components_json) > 2))
        AND file_number IS NOT NULL AND LEN(LTRIM(RTRIM(file_number))) > 0
        AND created_at >= DATEADD(day, -90, GETDATE())
    `);

    const cases = [];
    let totalOrdered = 0, totalUsed = 0;
    let prcWasted = 0, ffpWasted = 0, pltWasted = 0, irrWasted = 0;

    console.log(`[wastage] deliveries found: ${deliveries.recordset.length}, transfusions found: ${transfusions.recordset.length}`);
    for (const d of deliveries.recordset) {
      const match = transfusions.recordset.find(t =>
        t.file_number && t.file_number.trim() === d.file_number.trim()
      );
      if (!match) { console.log(`[wastage] SKIP file=${d.file_number} — no matching transfusion request for this file number`); continue; }

      for (const key of Object.keys(WASTAGE_COMPONENT_LABELS)) {
        const ordered = componentTotal(match, key);
        if (ordered === 0) continue; // nothing requested for this component

        const usedQty = componentTotal(d, key);
        const wasted  = Math.max(0, ordered - usedQty);
        const component = WASTAGE_COMPONENT_LABELS[key];

        if (key === 'fpc') prcWasted += wasted;
        else if (key === 'ffp') ffpWasted += wasted;
        else if (key === 'plt') pltWasted += wasted;
        else if (key === 'irr') irrWasted += wasted;

        console.log(`[wastage] file=${d.file_number} component=${component} ordered=${ordered} used=${usedQty} wasted=${wasted}`);
        totalOrdered += ordered;
        totalUsed    += usedQty;
        cases.push({
          patient_name: d.patient_name, file_number: d.file_number,
          date: d.date, component, ordered, used: usedQty, wasted,
        });
      }
    }

    cases.sort((a, b) => b.wasted - a.wasted);
    const totalWasted = prcWasted + ffpWasted + pltWasted + irrWasted;
    const wastageRate = totalOrdered > 0 ? Math.round((totalWasted / totalOrdered) * 100) : 0;

    res.json({
      summary: { totalOrdered, totalUsed, totalWasted, wastageRate, prcWasted, ffpWasted, pltWasted, irrWasted },
      cases: cases.slice(0, 30),
    });
  } catch (err) {
    console.error('Wastage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /dashboard/consumption?from=YYYY-MM-DD&to=YYYY-MM-DD
// Units consumed, broken down by component, blood type, ward, and
// trend — sourced live from eDelphyn's 'transfusion' category query.
// ════════════════════════════════════════════════════════════════
app.get('/dashboard/consumption', requireAuth, async (req, res) => {
  try {
    const fromDate = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toDate   = req.query.to   || new Date().toISOString().slice(0, 10);

    const { rows, columns } = await getCategoryRows('transfusion', fromDate, nextDayStr(toDate));
    const dateCol = columns.find(c => c.toLowerCase().trim() === 'date');
    const grpCol  = columns.find(c => c.toLowerCase().trim() === 'group');
    const destCol = columns.find(c => c.toLowerCase().trim() === 'destination');
    const compCol = columns.find(c => c.toLowerCase().trim() === 'component');

    let totalPrc = 0, totalFfp = 0, totalPlt = 0;
    const groupMap = {};
    const roomMap  = {};
    const trendMap = {};

    for (const row of rows) {
      const comp = classifyComponent(row[compCol]);
      const d    = row[dateCol];
      if (!comp || !d) continue;

      if (comp === 'prc') totalPrc++;
      else if (comp === 'ffp') totalFfp++;
      else totalPlt++;

      const grp = String(row[grpCol] || '').trim();
      if (grp && grp !== '-') {
        if (!groupMap[grp]) groupMap[grp] = { prc: 0, ffp: 0, plt: 0 };
        groupMap[grp][comp]++;
      }

      const dest = String(row[destCol] || '').trim();
      if (dest && dest !== '-') {
        if (!roomMap[dest]) roomMap[dest] = { prc: 0, ffp: 0, plt: 0 };
        roomMap[dest][comp]++;
      }

      if (!trendMap[d]) trendMap[d] = { prc: 0, ffp: 0, plt: 0 };
      trendMap[d][comp]++;
    }

    const byGroup = Object.entries(groupMap)
      .map(([label, v]) => ({ label, ...v, total: v.prc + v.ffp + v.plt }))
      .sort((a, b) => b.total - a.total);

    const byRoom = Object.entries(roomMap)
      .map(([room, v]) => ({ room, ...v, total: v.prc + v.ffp + v.plt }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Aggregate trend: daily ≤60 days, weekly ≤180 days, monthly otherwise
    const daysDiff = Math.ceil((new Date(toDate) - new Date(fromDate)) / 86400000);
    let trend;

    if (daysDiff > 180) {
      const mo = {};
      Object.entries(trendMap).forEach(([d, v]) => {
        const k = d.slice(0, 7);
        if (!mo[k]) mo[k] = { prc: 0, ffp: 0, plt: 0 };
        mo[k].prc += v.prc; mo[k].ffp += v.ffp; mo[k].plt += v.plt;
      });
      trend = Object.entries(mo).sort(([a],[b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v }));
    } else if (daysDiff > 60) {
      const wk = {};
      Object.entries(trendMap).forEach(([d, v]) => {
        const dt  = new Date(d);
        const day = dt.getUTCDay();
        const mon = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day + (day === 0 ? -6 : 1)));
        const k   = mon.toISOString().slice(0, 10);
        if (!wk[k]) wk[k] = { prc: 0, ffp: 0, plt: 0 };
        wk[k].prc += v.prc; wk[k].ffp += v.ffp; wk[k].plt += v.plt;
      });
      trend = Object.entries(wk).sort(([a],[b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v }));
    } else {
      trend = Object.entries(trendMap).sort(([a],[b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v }));
    }

    res.json({
      summary: { total_prc: totalPrc, total_ffp: totalFfp, total_plt: totalPlt,
                 total_units: totalPrc + totalFfp + totalPlt },
      byGroup, byRoom, trend,
      granularity: daysDiff > 180 ? 'month' : daysDiff > 60 ? 'week' : 'day',
    });

  } catch (err) {
    console.error('Consumption error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET  /report/monthly?month=YYYY-MM   — aggregated KPIs for a month
// POST /report/monthly/pdf             — streams PDF from JSON body
// ════════════════════════════════════════════════════════════════
async function getMonthlyReportData(monthStr) {
  const [yr, mo] = monthStr.split('-').map(Number);
  if (!yr || !mo || mo < 1 || mo > 12) throw new Error('Invalid month');

  const from    = `${yr}-${String(mo).padStart(2,'0')}-01`;
  const lastDay = new Date(yr, mo, 0).getDate();
  const to      = `${yr}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const toEnd   = to + ' 23:59:59';
  const label   = new Date(yr, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const pool = await getPool();

  // DB queries: operational data only (counts, life-saving, staff, response times)
  const [tStats, physStats, dStats, techStats, rtStats] = await Promise.all([
    pool.request().input('f', sql.NVarChar, from).input('t', sql.NVarChar, toEnd).query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN life_saving=1 THEN 1 ELSE 0 END) AS life_saving
      FROM TransfusionRequests
      WHERE created_at >= CAST(@f AS DATETIME) AND created_at <= CAST(@t AS DATETIME)`),

    pool.request().input('f', sql.NVarChar, from).input('t', sql.NVarChar, toEnd).query(`
      SELECT TOP 5 physician, COUNT(*) AS cnt
      FROM TransfusionRequests
      WHERE created_at >= CAST(@f AS DATETIME) AND created_at <= CAST(@t AS DATETIME)
        AND physician IS NOT NULL AND physician <> ''
      GROUP BY physician ORDER BY cnt DESC`),

    pool.request().input('f', sql.NVarChar, from).input('t', sql.NVarChar, toEnd).query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN life_saving=1 THEN 1 ELSE 0 END) AS life_saving
      FROM BloodDeliveries
      WHERE created_at >= CAST(@f AS DATETIME) AND created_at <= CAST(@t AS DATETIME)`),

    pool.request().input('f', sql.NVarChar, from).input('t', sql.NVarChar, toEnd).query(`
      SELECT TOP 5 technician_name, COUNT(*) AS cnt
      FROM BloodDeliveries
      WHERE created_at >= CAST(@f AS DATETIME) AND created_at <= CAST(@t AS DATETIME)
        AND technician_name IS NOT NULL AND technician_name <> ''
      GROUP BY technician_name ORDER BY cnt DESC`),

    pool.request().input('f', sql.NVarChar, from).input('t', sql.NVarChar, toEnd).query(`
      SELECT AVG(CAST(bb_diff AS FLOAT)) AS avg_bb, AVG(CAST(nurse_diff AS FLOAT)) AS avg_nurse,
        COUNT(*) AS total_matched,
        SUM(CASE WHEN is_ls=1 THEN 1 ELSE 0 END) AS ls_count,
        SUM(CASE WHEN is_ls=1 AND bb_diff<=15 THEN 1 ELSE 0 END) AS ls_within,
        SUM(CASE WHEN is_urgent=1 THEN 1 ELSE 0 END) AS urgent_count,
        SUM(CASE WHEN is_urgent=1 AND bb_diff<=45 THEN 1 ELSE 0 END) AS urgent_within
      FROM (
        SELECT
          -- "Emergent (<15 min)" on the components table is its own urgency
          -- tier separate from the Life Saving Cases checkbox, but shares
          -- the same 15-minute target, so it counts toward is_ls here too.
          -- Rows added via "+" (see renderTCompTable in index.html) carry
          -- their own urgency in components_json rather than a flat column —
          -- OPENJSON checks those too, so an urgency set only on an extra
          -- row isn't invisible to this classification.
          CASE WHEN t.life_saving=1 OR d.life_saving=1
                 OR t.fpc_type='Emergent (<15 min)' OR t.ffp_type='Emergent (<15 min)'
                 OR t.plt_type='Emergent (<15 min)' OR t.irr_type='Emergent (<15 min)'
                 OR (t.components_json IS NOT NULL AND EXISTS (
                       SELECT 1 FROM OPENJSON(t.components_json) WITH (ctype NVARCHAR(50) '$.type')
                       WHERE ctype = 'Emergent (<15 min)'
                     ))
               THEN 1 ELSE 0 END AS is_ls,
          CASE WHEN t.fpc_type='Stat' OR t.ffp_type='Stat' OR t.plt_type='Stat' OR t.irr_type='Stat'
                 OR (t.components_json IS NOT NULL AND EXISTS (
                       SELECT 1 FROM OPENJSON(t.components_json) WITH (ctype NVARCHAR(50) '$.type')
                       WHERE ctype = 'Stat'
                     ))
               THEN 1 ELSE 0 END AS is_urgent,
          DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10),er.eff_date,23)+' '+CONVERT(VARCHAR(8),er.eff_time,108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10),d.delivery_date,23)+' '+CONVERT(VARCHAR(8),d.delivery_time,108) AS DATETIME)
          ) AS bb_diff,
          DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10),er.eff_date,23)+' '+CONVERT(VARCHAR(8),er.eff_time,108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10),d.nurse_unit_date,23)+' '+CONVERT(VARCHAR(8),d.nurse_unit_time,108) AS DATETIME)
          ) AS nurse_diff
        FROM TransfusionRequests t
        CROSS APPLY (
          -- Request Date/Time isn't a required field, so fall back to when
          -- the record was actually saved rather than dropping it here.
          SELECT
            COALESCE(t.request_date, CAST(t.created_at AS DATE)) AS eff_date,
            COALESCE(t.request_time, CAST(t.created_at AS TIME)) AS eff_time
        ) er
        OUTER APPLY (
          SELECT TOP 1 delivery_date, delivery_time, life_saving, nurse_unit_date, nurse_unit_time
          FROM (
            SELECT
              bd.delivery_id,
              COALESCE(bd.delivery_date, CAST(bd.created_at AS DATE)) AS delivery_date,
              COALESCE(bd.delivery_time, CAST(bd.created_at AS TIME)) AS delivery_time,
              bd.life_saving,
              COALESCE(bd.nurse_unit_date, CASE WHEN bd.nurse_unit_time IS NOT NULL THEN CAST(bd.created_at AS DATE) END) AS nurse_unit_date,
              COALESCE(bd.nurse_unit_time, CASE WHEN bd.nurse_unit_date IS NOT NULL THEN CAST(bd.created_at AS TIME) END) AS nurse_unit_time
            FROM BloodDeliveries bd
            WHERE bd.file_number = t.file_number AND bd.file_number IS NOT NULL AND bd.file_number <> ''
          ) bdx
          WHERE bdx.delivery_date > er.eff_date
             OR (bdx.delivery_date = er.eff_date AND bdx.delivery_time >= er.eff_time)
          ORDER BY bdx.delivery_date ASC, bdx.delivery_time ASC
        ) d
        WHERE t.created_at >= CAST(@f AS DATETIME) AND t.created_at <= CAST(@t AS DATETIME)
          AND t.file_number IS NOT NULL AND t.file_number <> ''
          AND d.delivery_date IS NOT NULL AND d.delivery_time IS NOT NULL
      ) rt WHERE bb_diff BETWEEN 0 AND 480`),
  ]);

  // Units, blood groups, wards, daily trend — live from eDelphyn's 'transfusion' category
  let livePrc = 0, liveFfp = 0, livePlt = 0;
  const groupMap = {}, destMap = {}, trendMap = {};

  {
    const { rows, columns } = await getCategoryRows('transfusion', from, nextDayStr(to));
    const dateCol = columns.find(c => c.toLowerCase().trim() === 'date');
    const grpCol  = columns.find(c => c.toLowerCase().trim() === 'group');
    const destCol = columns.find(c => c.toLowerCase().trim() === 'destination');
    const compCol = columns.find(c => c.toLowerCase().trim() === 'component');

    for (const row of rows) {
      const comp = classifyComponent(row[compCol]);
      const d    = row[dateCol];
      if (!comp || !d) continue;

      if (comp === 'prc') livePrc++;
      else if (comp === 'ffp') liveFfp++;
      else livePlt++;

      const grp  = String(row[grpCol]  || '').trim();
      const dest = String(row[destCol] || '').trim();

      if (grp && grp !== '-') {
        if (!groupMap[grp]) groupMap[grp] = { prc: 0, ffp: 0, plt: 0 };
        groupMap[grp][comp]++;
      }
      if (dest && dest !== '-') {
        if (!destMap[dest]) destMap[dest] = { prc: 0, ffp: 0, plt: 0 };
        destMap[dest][comp]++;
      }
      if (!trendMap[d]) trendMap[d] = { prc: 0, ffp: 0, plt: 0 };
      trendMap[d][comp]++;
    }
  }

  const blood_groups = Object.entries(groupMap)
    .map(([group, v]) => ({ group, ...v, total: v.prc + v.ffp + v.plt }))
    .sort((a, b) => b.total - a.total);

  const top_rooms = Object.entries(destMap)
    .map(([room, v]) => ({ room, ...v, cnt: v.prc + v.ffp + v.plt }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 8);

  const daily_trend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, prc: v.prc, ffp: v.ffp, plt: v.plt, total: v.prc + v.ffp + v.plt }));

  const tRow  = tStats.recordset[0]  || {};
  const dRow  = dStats.recordset[0]  || {};
  const rtRow = rtStats.recordset[0] || {};
  const lsTotal = (tRow.life_saving || 0) + (dRow.life_saving || 0);

  return {
    period:     { month: monthStr, label, from, to },
    overview:   { transfusions: tRow.total || 0, deliveries: dRow.total || 0, life_saving: lsTotal },
    units:      { prc: livePrc, ffp: liveFfp, plt: livePlt, total: livePrc + liveFfp + livePlt },
    blood_groups,
    top_rooms,
    top_physicians:  physStats.recordset,
    top_technicians: techStats.recordset,
    daily_trend,
    response_times: {
      avg_bb_minutes:    rtRow.avg_bb    != null ? Math.round(rtRow.avg_bb)    : null,
      avg_nurse_minutes: rtRow.avg_nurse != null ? Math.round(rtRow.avg_nurse) : null,
      ls_count:          rtRow.ls_count   || 0,
      ls_within:         rtRow.ls_within  || 0,
      urgent_count:      rtRow.urgent_count  || 0,
      urgent_within:     rtRow.urgent_within || 0,
      total_matched:     rtRow.total_matched || 0,
    },
    generated_at: new Date().toLocaleString('en-GB'),
  };
}

app.get('/report/monthly', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ error: 'db_not_ready' });
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    res.json(await getMonthlyReportData(month));
  } catch (err) {
    console.error('Monthly report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/report/monthly/pdf', requireAuth, async (req, res) => {
  try {
    const { generateMonthlyReportPdf } = require('./exportForm');
    const buf = await generateMonthlyReportPdf(req.body);
    const month = (req.body.period && req.body.period.month) || 'report';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-report-${month}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('Monthly PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /response-times
// For each transfusion request, finds the nearest delivery by the
// same file_number and calculates the elapsed minutes.
// Case rules: life_saving → target 15 min; Stat component → 45 min
//
// Request Date/Time and Delivery Date/Time are NOT required fields on
// either form, so they're often left blank. Rather than silently dropping
// those records from this whole compliance report, we fall back to the
// row's own created_at (always set, that's when it was actually saved) as
// the effective timestamp on both sides.
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
        CONVERT(VARCHAR(10), er.eff_date, 23)                    AS request_date,
        CONVERT(VARCHAR(8),  er.eff_time,  108)                  AS request_time,
        CAST(t.life_saving AS INT)                               AS t_life_saving,
        t.fpc_type, t.ffp_type, t.plt_type, t.irr_type, t.components_json,
        d.delivery_id,
        CONVERT(VARCHAR(10), d.delivery_date,    23)             AS delivery_date,
        CONVERT(VARCHAR(8),  d.delivery_time,   108)             AS delivery_time,
        CAST(d.life_saving AS INT)                               AS d_life_saving,
        CONVERT(VARCHAR(10), d.nurse_unit_date,  23)             AS nurse_unit_date,
        CONVERT(VARCHAR(8),  d.nurse_unit_time, 108)             AS nurse_unit_time,
        -- Blood bank delivery elapsed (request → BB dispatches)
        CASE
          WHEN d.delivery_date IS NOT NULL AND d.delivery_time IS NOT NULL
          THEN DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10), er.eff_date, 23) + ' ' + CONVERT(VARCHAR(8), er.eff_time, 108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10), d.delivery_date, 23) + ' ' + CONVERT(VARCHAR(8), d.delivery_time, 108) AS DATETIME)
          )
          ELSE NULL
        END AS bb_diff_minutes,
        -- Nurse receipt elapsed (request → nurse signs for blood)
        CASE
          WHEN d.nurse_unit_date IS NOT NULL AND d.nurse_unit_time IS NOT NULL
          THEN DATEDIFF(minute,
            CAST(CONVERT(VARCHAR(10), er.eff_date, 23) + ' ' + CONVERT(VARCHAR(8), er.eff_time, 108) AS DATETIME),
            CAST(CONVERT(VARCHAR(10), d.nurse_unit_date, 23) + ' ' + CONVERT(VARCHAR(8), d.nurse_unit_time, 108) AS DATETIME)
          )
          ELSE NULL
        END AS nurse_diff_minutes,
        CONVERT(VARCHAR(19), t.created_at, 120)                  AS created_at
      FROM TransfusionRequests t
      CROSS APPLY (
        SELECT
          COALESCE(t.request_date, CAST(t.created_at AS DATE)) AS eff_date,
          COALESCE(t.request_time, CAST(t.created_at AS TIME)) AS eff_time
      ) er
      OUTER APPLY (
        SELECT TOP 1 delivery_id, delivery_date, delivery_time, life_saving, nurse_unit_date, nurse_unit_time
        FROM (
          SELECT
            bd.delivery_id,
            COALESCE(bd.delivery_date, CAST(bd.created_at AS DATE)) AS delivery_date,
            COALESCE(bd.delivery_time, CAST(bd.created_at AS TIME)) AS delivery_time,
            bd.life_saving,
            -- Nurse date/time are two separate optional fields — someone can
            -- fill in the time and forget the date (or vice versa). Only fill
            -- the missing half when the other half was actually entered; if
            -- neither was, leave both NULL rather than inventing a nurse
            -- receipt event that never happened.
            COALESCE(bd.nurse_unit_date, CASE WHEN bd.nurse_unit_time IS NOT NULL THEN CAST(bd.created_at AS DATE) END) AS nurse_unit_date,
            COALESCE(bd.nurse_unit_time, CASE WHEN bd.nurse_unit_date IS NOT NULL THEN CAST(bd.created_at AS TIME) END) AS nurse_unit_time
          FROM BloodDeliveries bd
          WHERE bd.file_number = t.file_number AND bd.file_number IS NOT NULL AND bd.file_number <> ''
        ) bdx
        WHERE bdx.delivery_date > er.eff_date
           OR (bdx.delivery_date = er.eff_date AND bdx.delivery_time >= er.eff_time)
        ORDER BY bdx.delivery_date ASC, bdx.delivery_time ASC
      ) d
      WHERE t.file_number IS NOT NULL AND t.file_number <> ''
      ORDER BY t.created_at DESC
    `);

    const rows = result.recordset.map(r => {
      const types = [r.fpc_type, r.ffp_type, r.plt_type, r.irr_type];
      // Rows added via "+" beyond each component's first (see renderTCompTable
      // in index.html) carry their own urgency too, but live in components_json
      // rather than a flat column — without reading it here, an urgency set
      // only on an extra row (not the first row of that component) was
      // invisible to this classification and the case silently read as routine.
      if (r.components_json) {
        try { JSON.parse(r.components_json).forEach(c => { if (c.type) types.push(c.type); }); }
        catch (e) { /* ignore bad JSON */ }
      }
      const isLifeSaving  = r.t_life_saving === 1 || r.d_life_saving === 1;
      // "Emergent (<15 min)" is its own urgency tier on the components table,
      // separate from the Life Saving Cases checkbox, but carries the same
      // 15-minute target — without this it fell through to "routine" and
      // got hidden by the urgent/life-saving filter below.
      const isEmergent    = types.some(t => t === 'Emergent (<15 min)');
      const isStat        = types.some(t => t === 'Stat');
      let caseType      = 'routine';
      let targetMinutes = null;
      if (isLifeSaving || isEmergent) { caseType = 'life_saving'; targetMinutes = 15; }
      else if (isStat)                { caseType = 'urgent';      targetMinutes = 45; }
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
const { generateDocx, generatePdf, generateHandoverPdf, generateChartsPdf, generateChartsDocx } = require('./exportForm');

// ════════════════════════════════════════════════════════════════
// GET /handover?date=YYYY-MM-DD&shift=morning|afternoon|night
// Returns all transfusions and deliveries within the shift window
// ════════════════════════════════════════════════════════════════
app.get('/handover', requireAuth, async (req, res) => {
  if (!dbReady) return res.json({ error: 'db_not_ready' });
  try {
    const pool  = await getPool();
    const date  = req.query.date  || new Date().toISOString().slice(0, 10);
    const shift = req.query.shift || 'morning';

    let fromDT, toDT;
    if (shift === 'night') {
      const next = new Date(date); next.setDate(next.getDate() + 1);
      fromDT = `${date} 23:00:00`;
      toDT   = `${next.toISOString().slice(0, 10)} 07:00:00`;
    } else if (shift === 'afternoon') {
      fromDT = `${date} 15:00:00`;
      toDT   = `${date} 23:00:00`;
    } else {
      fromDT = `${date} 07:00:00`;
      toDT   = `${date} 15:00:00`;
    }

    const transfusions = await pool.request()
      .input('from', sql.NVarChar, fromDT)
      .input('to',   sql.NVarChar, toDT)
      .query(`
        SELECT request_id, patient_name, file_number, blood_group, rh_factor, room,
          diagnosis, fpc_units, fpc_type, ffp_units, ffp_type, plt_units, plt_type,
          physician, life_saving, life_saving_physician, life_saving_time,
          saved_by, CONVERT(VARCHAR(5), created_at, 108) AS time_saved
        FROM TransfusionRequests
        WHERE created_at >= CAST(@from AS DATETIME) AND created_at < CAST(@to AS DATETIME)
        ORDER BY created_at ASC
      `);

    const deliveries = await pool.request()
      .input('from', sql.NVarChar, fromDT)
      .input('to',   sql.NVarChar, toDT)
      .query(`
        SELECT delivery_id, patient_name, file_number, patient_blood_group, patient_rh,
          room, fpc_units, ffp_units, plt_units, irr_units, components_json, technician_name,
          life_saving, life_saving_physician, life_saving_time,
          saved_by, CONVERT(VARCHAR(5), created_at, 108) AS time_saved
        FROM BloodDeliveries
        WHERE created_at >= CAST(@from AS DATETIME) AND created_at < CAST(@to AS DATETIME)
        ORDER BY created_at ASC
      `);

    const t  = transfusions.recordset;
    const d2 = deliveries.recordset;
    const totalPrc   = t.reduce((s, r) => s + (r.fpc_units || 0), 0);
    const totalFfp   = t.reduce((s, r) => s + (r.ffp_units || 0), 0);
    const totalPlt   = t.reduce((s, r) => s + (r.plt_units || 0), 0);
    const lifeSaving = [...t, ...d2].filter(r => r.life_saving).length;

    res.json({
      shift, date, from: fromDT, to: toDT,
      summary: {
        transfusions: t.length,  deliveries: d2.length,
        life_saving:  lifeSaving, total_prc: totalPrc,
        total_ffp:    totalFfp,   total_plt: totalPlt,
        total_units:  totalPrc + totalFfp + totalPlt,
      },
      transfusions: t,
      deliveries:   d2,
    });
  } catch (err) {
    console.error('Handover error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /handover/pdf  — generates and streams the handover PDF
// ════════════════════════════════════════════════════════════════
app.post('/handover/pdf', requireAuth, async (req, res) => {
  try {
    const buf = await generateHandoverPdf(req.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="handover-${req.body.date}-${req.body.shift}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('Handover PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
          irr_units, irr_type, components_json,
          blood_unit_1, blood_unit_2, blood_unit_3, blood_unit_4,
          blood_unit_5, blood_unit_6, blood_unit_7, blood_unit_8,
          previous_transfusion, prev_transfusion_place, prev_transfusion_reaction,
          physician, physician_signature, phlebotomist, request_date, request_time,
          life_saving, life_saving_physician, life_saving_signature, life_saving_time,
          saved_by, signed_by_user_id, signed_by_name,
          CONVERT(VARCHAR(19), signed_at, 120) AS signed_at,
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
          fpc_units, ffp_units, plt_units, irr_units, components_json,
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
          life_saving, life_saving_physician, life_saving_signature, life_saving_time,
          saved_by, signed_by_user_id, signed_by_name,
          CONVERT(VARCHAR(19), signed_at, 120) AS signed_at,
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
// LIVE DASHBOARD (e-Delphyn)
// ════════════════════════════════════════════════════════════════
const xlsx = require('xlsx'); // still used by /api/dashboard/category-export

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

// GET /api/dashboard/categories — live row counts per eDelphyn category
app.get('/api/dashboard/categories', requireAuth, async (req, res) => {
  try {
    const now        = new Date();
    const pad        = n => String(n).padStart(2, '0');
    const thisMo     = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const lastMoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMo     = `${lastMoDate.getFullYear()}-${pad(lastMoDate.getMonth() + 1)}`;

    // 13-month rolling window: covers this/last month plus a year of history
    // for the monthly comparison chart, without pulling the DB's entire history.
    const rangeFrom = ymdLocal(new Date(now.getFullYear(), now.getMonth() - 12, 1));
    const rangeTo   = ymdLocal(new Date(now.getFullYear(), now.getMonth() + 1, 1));

    const cats = {};
    const categoryRows = {}; // reused below for topDepts/monthlyComparison

    for (const type of EDELPHYN_CATEGORIES) {
      const { columns, rows } = await getCategoryRows(type, rangeFrom, rangeTo);
      categoryRows[type] = { columns, rows };
      const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
      let thisMonth = 0, lastMonth = 0;
      if (dateCol) {
        rows.forEach(row => {
          const ds = row[dateCol];
          if (!ds || ds.length < 7) return;
          const mo = ds.substring(0, 7);
          if (mo === thisMo) thisMonth++;
          if (mo === lastMo) lastMonth++;
        });
      }
      cats[type] = { source: 'eDelphyn', rowCount: rows.length, thisMonth, lastMonth };
    }

    // Top departments/wards aggregated across transfusion + requests
    const deptMap = {};
    for (const type of ['transfusion', 'requests']) {
      const { columns, rows } = categoryRows[type];
      const deptCol = excelFindCol(columns, 'destination', 'department', 'dept', 'ward');
      if (!deptCol) continue;
      rows.forEach(row => {
        const v = String(row[deptCol] || '').trim();
        if (v) deptMap[v] = (deptMap[v] || 0) + 1;
      });
    }
    const _topDepts = Object.entries(deptMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([label, count]) => ({ label, count }));

    // Monthly comparison: requests vs issued (transfusion)
    const moMap = {};
    for (const type of ['transfusion', 'requests']) {
      const { columns, rows } = categoryRows[type];
      const dc = columns.find(k => k.toLowerCase().trim() === 'date');
      if (!dc) continue;
      rows.forEach(row => {
        const ds = row[dc];
        if (!ds || ds.length < 7) return;
        const mo = ds.substring(0, 7);
        if (!moMap[mo]) moMap[mo] = { requests: 0, transfusion: 0 };
        moMap[mo][type]++;
      });
    }
    const _monthlyComparison = Object.entries(moMap)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, d]) => ({ label, requests: d.requests, transfusion: d.transfusion }));

    res.json({ ...cats, _topDepts, _monthlyComparison });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/dashboard/category-query — filtered/paginated rows + summary for one category
app.post('/api/dashboard/category-query', requireAuth, async (req, res) => {
  try {
    const { category, dateFrom, dateTo, search, page = 1, pageSize = 100 } = req.body;
    if (!EDELPHYN_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });

    const from = dateFrom || '1900-01-01';
    const to   = dateTo ? nextDayStr(dateTo) : '2999-12-31';

    const { columns, rows: allRows } = await getCategoryRows(category, from, to);

    if (allRows.length === 0) {
      return res.json({ columns, rows: [], total: 0, filtered: 0,
        type: category, summary: {}, monthlyChart: [],
        page: 1, pageSize: 100, totalPages: 0 });
    }

    const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');

    // Search filter
    let filtered = allRows;
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
        const ds = row[dateCol];
        if (!ds || ds.length < 7) return;
        const mo = ds.substring(0, 7);
        monthMap[mo] = (monthMap[mo] || 0) + 1;
      });
    }
    const monthlyChart = Object.entries(monthMap)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, count]) => ({ label, count }));

    const summary = excelSummary(category, filtered, columns);

    const total         = allRows.length;
    const filteredTotal = filtered.length;
    const pageInt       = Math.max(1, parseInt(page));
    const pageSizeInt   = Math.min(500, Math.max(1, parseInt(pageSize)));
    const paginatedRows = filtered.slice((pageInt-1)*pageSizeInt, pageInt*pageSizeInt);

    res.json({
      columns,
      rows: paginatedRows,
      total, filtered: filteredTotal,
      dateColumn: dateCol || null,
      monthlyChart, type: category, summary,
      page: pageInt, pageSize: pageSizeInt,
      totalPages: Math.ceil(filteredTotal / pageSizeInt)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/dashboard/category-export — download filtered rows as XLSX
app.post('/api/dashboard/category-export', requireAuth, async (req, res) => {
  try {
    const { category, dateFrom, dateTo, search } = req.body;
    if (!EDELPHYN_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });

    const from = dateFrom || '1900-01-01';
    const to   = dateTo ? nextDayStr(dateTo) : '2999-12-31';
    const { columns, rows: allRows } = await getCategoryRows(category, from, to);

    let rows = allRows;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(row => Object.values(row).some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q)));
    }

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows, { header: columns });
    xlsx.utils.book_append_sheet(wb, ws, category.substring(0, 31));
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${category}-export.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/dashboard/category-charts-export/:fileType (pdf|docx)
// Body: { category, categoryLabel, dateFrom, dateTo, charts: [{ title, image: 'data:image/png;base64,...', width, height }] }
// Charts are captured client-side as PNG snapshots of the on-screen Chart.js canvases.
app.post('/api/dashboard/category-charts-export/:fileType', requireAuth, async (req, res) => {
  try {
    const { fileType } = req.params;
    if (fileType !== 'pdf' && fileType !== 'docx') return res.status(400).json({ error: 'fileType must be pdf or docx' });

    const { category, categoryLabel, dateFrom, dateTo, charts } = req.body;
    if (!EDELPHYN_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });
    if (!Array.isArray(charts)) return res.status(400).json({ error: 'charts must be an array' });

    const cleanCharts = charts
      .filter(c => c && typeof c.image === 'string' && c.image.startsWith('data:image/'))
      .slice(0, 20) // sane cap
      .map(c => ({
        title: String(c.title || 'Chart').slice(0, 120),
        buffer: Buffer.from(c.image.split(',')[1] || '', 'base64'),
        width: Number(c.width) || 0,
        height: Number(c.height) || 0,
      }));

    const meta = {
      categoryLabel: categoryLabel || category,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      generatedAt: new Date().toLocaleString('en-GB', { hour12: false }),
    };

    if (fileType === 'pdf') {
      const buffer = await generateChartsPdf(meta, cleanCharts);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${category}-charts_${Date.now()}.pdf"`);
      res.send(buffer);
    } else {
      const buffer = await generateChartsDocx(meta, cleanCharts);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${category}-charts_${Date.now()}.docx"`);
      res.send(buffer);
    }
  } catch (err) {
    console.error('Charts export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/alerts — rule-based smart alerts from live eDelphyn data
app.get('/api/dashboard/alerts', requireAuth, async (req, res) => {
  try {
    const alerts = [];
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const thisMo = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const lastMoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMo = `${lastMoDate.getFullYear()}-${pad(lastMoDate.getMonth() + 1)}`;

    // 2-month window covers "this month" and "last month" comparisons below.
    const rangeFrom = ymdLocal(lastMoDate);
    const tomorrow  = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const rangeTo   = ymdLocal(tomorrow);

    const catData = {};
    for (const type of ['wasted', 'requests', 'transfusion', 'donors', 'sent_to_centres']) {
      catData[type] = await getCategoryRows(type, rangeFrom, rangeTo);
    }

    const moFilter = (rows, columns, mo) => {
      const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
      if (!dateCol) return [];
      return rows.filter(r => r[dateCol] && r[dateCol].substring(0, 7) === mo);
    };

    // ── Rule 1: Wastage spike (this month vs last month > 20%)
    {
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
    {
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
    {
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
    {
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
    {
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
    {
      const { rows, columns } = catData.sent_to_centres;
      const dateCol = columns.find(k => k.toLowerCase().trim() === 'date');
      const expiryCol = excelFindCol(columns, 'expiry');
      if (dateCol && expiryCol) {
        const thisRows = moFilter(rows, columns, thisMo);
        const nearExpiry = thisRows.filter(r => {
          const sent = new Date(r[dateCol]);
          const exp  = new Date(r[expiryCol]);
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
    {
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

// ════════════════════════════════════════════════════════════════
// /api/analytics/* — advanced e-Delphyn analytics (KPI cards, trends,
// donor behaviour, fulfilment/turnaround, expiry risk, demand heatmap,
// anomaly detection). Each route defaults to a sensible date range so
// the dashboard works with no query params.
// ════════════════════════════════════════════════════════════════
function defaultRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return { from: ymdLocal(from), to: ymdLocal(to) };
}

app.get('/api/analytics/kpi-summary', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(30);
    const dateFrom   = req.query.from || defFrom;
    const dateTo     = nextDayStr(req.query.to || defTo);
    const expiryDays = parseInt(req.query.expiryDays) || 14;
    const pool = await getEdelphynPool();
    const data = await analyticsQueries.kpiTrend(pool, dateFrom, dateTo, expiryDays);
    res.json(data);
  } catch (err) { console.error('kpi-summary error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/monthly-trend', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(365);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.monthlyTrend(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('monthly-trend error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/donation-types', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(30);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.donationTypes(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('donation-types error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/donor-retention', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(365);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.donorRetention(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('donor-retention error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/donor-recall', requireAuth, async (req, res) => {
  try {
    const inactiveDays = parseInt(req.query.inactiveDays) || 180;
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.donorRecall(pool, inactiveDays);
    res.json(rows);
  } catch (err) { console.error('donor-recall error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/fulfilment', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(30);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.fulfilmentRate(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('fulfilment error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/turnaround', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(30);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.turnaroundTime(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('turnaround error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/return-rate', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(30);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.returnRate(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('return-rate error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/expiry-risk', requireAuth, async (req, res) => {
  try {
    const expiryDays = parseInt(req.query.expiryDays) || 14;
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.expiryRisk(pool, expiryDays);
    res.json(rows);
  } catch (err) { console.error('expiry-risk error:', err.message); res.status(500).json({ error: err.message }); }
});

// Backs the Expiry Calendar's month-grid — one month at a time, so browsing
// never has to pull the whole (potentially huge) backlog to render a grid.
app.get('/api/analytics/expiry-risk/month', requireAuth, async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ error: 'month must be 1-12' });
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.expiryRiskForMonth(pool, year, month);
    res.json(rows);
  } catch (err) { console.error('expiry-risk-month error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/demand-heatmap', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(180);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.demandHeatmap(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('demand-heatmap error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/anomaly', requireAuth, async (req, res) => {
  try {
    const { from: defFrom, to: defTo } = defaultRange(365);
    const dateFrom = req.query.from || defFrom;
    const dateTo   = nextDayStr(req.query.to || defTo);
    const pool = await getEdelphynPool();
    const rows = await analyticsQueries.anomalyDetection(pool, dateFrom, dateTo);
    res.json(rows);
  } catch (err) { console.error('anomaly error:', err.message); res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════
// GET /chat/history?from=DEPT_A&to=DEPT_B
// ════════════════════════════════════════════════════════════════
app.get('/chat/history', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json([]);
  if (from !== 'BLOOD BANK' && to !== 'BLOOD BANK') return res.json([]);
  const myDept = req.user.department || 'BLOOD BANK';
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('d1', sql.NVarChar, from)
      .input('d2', sql.NVarChar, to)
      .query(`SELECT TOP 100 message_id, from_name, from_dept, to_dept, message,
                urgent, file_url, file_name, read_at,
                CONVERT(VARCHAR(19), created_at, 120) AS created_at
              FROM ChatMessages
              WHERE (from_dept=@d1 AND to_dept=@d2) OR (from_dept=@d2 AND to_dept=@d1)
              ORDER BY created_at DESC`);
    const rows = r.recordset.reverse().map(m => ({ ...m, own: m.from_dept === myDept }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /chat/online — which departments currently have active sockets
app.get('/chat/online', requireAuth, (req, res) => {
  res.json([...onlineDepts.keys()]);
});

// POST /chat/upload — file attachment (max 5 MB)
const chatUploadDir = path.join(__dirname, 'uploads', 'chat');
const chatUpload = multer({
  dest: chatUploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|webm|ogg|mp4|wav|mp3/i;
    const okMime  = /^(image|audio|video)\//i.test(file.mimetype) ||
                    /pdf|msword|officedocument|spreadsheet/i.test(file.mimetype);
    cb(null, allowed.test(path.extname(file.originalname || '.webm')) || okMime);
  }
});
app.post('/chat/upload', requireAuth, chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or unsupported type' });
  res.json({ url: `/uploads/chat/${req.file.filename}`, name: req.file.originalname });
});
app.use('/uploads/chat', express.static(chatUploadDir));

server.listen(3000, () => console.log("✅ Blood Bank server running on http://localhost:3000"));