const sql = require("mssql");

// Blood-bank stock management — read-only queries against e-Delphyn.
//
// "In stock" uses the same rule as the Analytics expiry-risk queries
// (edelphynAnalyticsQueries.js) so the numbers agree across pages: a unit is
// in stock unless it has an open transfusion, an open delivery to another
// centre, or has been destroyed. A return (DAT_RETURN set) puts it back.
//
// Alert / critical levels come from eDelphyn's own STOCK + STOCK_COMPONENT
// tables, so the blood bank keeps maintaining them where it already does.

const GROUPS = ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"];

// COD_GROUP / COD_RH are free-ish text in eDelphyn ("+", "POS", "Positive"…),
// so normalise them in SQL once and only ever compare the clean values.
const GROUP_SQL = `UPPER(LTRIM(RTRIM(COALESCE(U.COD_GROUP, ''))))`;
const RH_SQL = `CASE
    WHEN UPPER(LTRIM(RTRIM(COALESCE(U.COD_RH, '')))) IN ('+', 'POS', 'POSITIVE', 'P', 'D+', '1') THEN '+'
    WHEN UPPER(LTRIM(RTRIM(COALESCE(U.COD_RH, '')))) IN ('-', 'NEG', 'NEGATIVE', 'N', 'D-', '0') THEN '-'
    ELSE '' END`;

const IN_STOCK_SQL = `
      NOT EXISTS (SELECT 1 FROM dbo.TRANSFUSION T WHERE T.ID_UNIT = U.ID_UNIT AND T.DAT_RETURN IS NULL)
  AND NOT EXISTS (SELECT 1 FROM dbo.DELIVERYDETAIL DD WHERE DD.ID_UNIT = U.ID_UNIT AND DD.DAT_RETURN IS NULL)
  AND NOT EXISTS (SELECT 1 FROM dbo.DESTROYBOXUNIT DBU WHERE DBU.ID_UNIT = U.ID_UNIT)`;

// Expired units that were never discarded are listed only if they expired
// within this many days. Older ones are just counted: in a real eDelphyn
// history there can be thousands of old units that left the bank some other
// way, and listing them would bury today's stock.
const EXPIRED_LIST_DAYS = 30;
const MAX_UNIT_ROWS = 5000;

function dateInput(request, name, value) {
  request.input(name, sql.Date, new Date(`${value}T00:00:00Z`));
}

// ── 1. Units currently in stock ─────────────────────────────────────
// Returns one row per unit (in date, plus recently expired), and the total
// number of expired-but-never-discarded units.
async function stockUnits(pool) {
  const request = pool.request();
  request.input("ExpiredListDays", sql.Int, EXPIRED_LIST_DAYS);
  request.input("MaxRows", sql.Int, MAX_UNIT_ROWS);
  const result = await request.query(`
    SET NOCOUNT ON;
    DECLARE @Today date = CAST(GETDATE() AS date);

    SELECT TOP (@MaxRows)
        U.ID_UNIT,
        U.COD_UNIT AS UnitNumber,
        U.COD_DIVISION AS Division,
        U.ID_COMPONENT AS ComponentId,
        COALESCE(C.DES_COMPONENT, 'Unknown component') AS Component,
        CT.DES_COMPONENTTYPE AS ComponentType,
        ${GROUP_SQL} AS AboGroup,
        ${RH_SQL} AS Rh,
        U.DAT_EXPIRY AS ExpiryDate,
        DATEDIFF(DAY, @Today, U.DAT_EXPIRY) AS DaysToExpiry
    FROM dbo.UNIT U
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = U.ID_COMPONENT
    LEFT JOIN dbo.COMPONENTTYPE CT ON CT.ID_COMPONENTTYPE = C.ID_COMPONENTTYPE
    WHERE (U.DAT_EXPIRY IS NULL OR U.DAT_EXPIRY >= DATEADD(DAY, -@ExpiredListDays, @Today))
      AND ${IN_STOCK_SQL}
    ORDER BY CASE WHEN U.DAT_EXPIRY IS NULL THEN 1 ELSE 0 END, U.DAT_EXPIRY, U.ID_UNIT;

    SELECT COUNT(*) AS ExpiredNotDiscarded
    FROM dbo.UNIT U
    WHERE U.DAT_EXPIRY < @Today
      AND ${IN_STOCK_SQL};
  `);
  const [units, [counts]] = result.recordsets;
  return {
    units,
    expiredNotDiscardedTotal: counts?.ExpiredNotDiscarded || 0,
    truncated: units.length >= MAX_UNIT_ROWS,
  };
}

// ── 2. Alert / critical levels from STOCK + STOCK_COMPONENT ─────────
// One STOCK row is a stock category (e.g. "Red cells") and STOCK_COMPONENT
// lists the components that count towards it, so its levels are compared
// with the combined count of all those components.
// Returns no rows when the tables don't exist (older eDelphyn installs, or a
// test DB without them), and the dashboard then says levels aren't set.
const LEVEL_COLUMNS = {
  "A+": "APOS", "A-": "ANEG", "B+": "BPOS", "B-": "BNEG",
  "O+": "OPOS", "O-": "ONEG", "AB+": "ABPOS", "AB-": "ABNEG",
  // "No Rh" levels apply to the ABO group as a whole (both Rh together).
  "A": "NORHA", "B": "NORHB", "O": "NORHO", "AB": "NORHAB",
};

async function stockLevels(pool) {
  const exists = await pool.request().query(`
    SELECT CASE WHEN OBJECT_ID('dbo.STOCK', 'U') IS NOT NULL
                 AND OBJECT_ID('dbo.STOCK_COMPONENT', 'U') IS NOT NULL THEN 1 ELSE 0 END AS HasTables
  `);
  if (!exists.recordset[0].HasTables) return { available: false, rows: [] };

  const cols = Object.values(LEVEL_COLUMNS)
    .map(k => `S.NUM_ALERT_${k}, S.NUM_CRITICAL_${k}`)
    .join(",\n        ");
  const result = await pool.request().query(`
    SELECT S.ID_STOCK, S.ID_CENTRE, S.DES_STOCK, S.NUM_ORDER,
        ${cols}
    FROM dbo.STOCK S
    WHERE EXISTS (SELECT 1 FROM dbo.STOCK_COMPONENT SC WHERE SC.ID_STOCK = S.ID_STOCK);

    SELECT SC.ID_STOCK, SC.ID_COMPONENT, COALESCE(C.DES_COMPONENT, CONCAT('Component #', SC.ID_COMPONENT)) AS Component
    FROM dbo.STOCK_COMPONENT SC
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = SC.ID_COMPONENT;
  `);
  const [stockRows, componentRows] = result.recordsets;
  const rows = stockRows.map(s => ({
    ...s,
    components: componentRows.filter(c => c.ID_STOCK === s.ID_STOCK)
      .map(c => ({ id: c.ID_COMPONENT, name: c.Component })),
  }));
  return { available: true, rows };
}

// ── 3. Stock movements over a period ────────────────────────────────
// Event counts per day, component and blood group:
//   received  – units whose donation (COD_DONATION = COD_UNIT) was collected,
//               or entered as an external unit, in the period
//   issued    – TRANSFUSION rows (same source as Consumption / Units Issued)
//   sent      – DELIVERYDETAIL rows (units sent to other centres)
//   returned  – returns from either of the two above
//   discarded – DESTROYBOXUNIT rows (same source as Analytics' Wasted Units)
async function stockMovements(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH Events AS (
      SELECT 'received' AS Kind, COALESCE(D.DAT_EXTERNALENTRY, D.DAT_DONATION) AS EventDate, U.ID_UNIT
      FROM dbo.UNIT U
      INNER JOIN dbo.DONATION D ON D.COD_DONATION = U.COD_UNIT
      WHERE COALESCE(D.DAT_EXTERNALENTRY, D.DAT_DONATION) >= @DateFrom
        AND COALESCE(D.DAT_EXTERNALENTRY, D.DAT_DONATION) < @DateTo
      UNION ALL
      SELECT 'issued', T.DAT_TRANSFUSION, T.ID_UNIT FROM dbo.TRANSFUSION T
      WHERE T.DAT_TRANSFUSION >= @DateFrom AND T.DAT_TRANSFUSION < @DateTo
      UNION ALL
      SELECT 'sent', DD.DAT_DELIVERYDETAIL, DD.ID_UNIT FROM dbo.DELIVERYDETAIL DD
      WHERE DD.DAT_DELIVERYDETAIL >= @DateFrom AND DD.DAT_DELIVERYDETAIL < @DateTo
      UNION ALL
      SELECT 'returned', T.DAT_RETURN, T.ID_UNIT FROM dbo.TRANSFUSION T
      WHERE T.DAT_RETURN >= @DateFrom AND T.DAT_RETURN < @DateTo
      UNION ALL
      SELECT 'returned', DD.DAT_RETURN, DD.ID_UNIT FROM dbo.DELIVERYDETAIL DD
      WHERE DD.DAT_RETURN >= @DateFrom AND DD.DAT_RETURN < @DateTo
      UNION ALL
      SELECT 'discarded', COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX), DBU.ID_UNIT
      FROM dbo.DESTROYBOXUNIT DBU
      INNER JOIN dbo.DESTROYBOX DB ON DB.ID_DESTROYBOX = DBU.ID_DESTROYBOX
      WHERE COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) >= @DateFrom
        AND COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) < @DateTo
    )
    SELECT
        E.Kind,
        E.EventDate,
        U.ID_COMPONENT AS ComponentId,
        COALESCE(C.DES_COMPONENT, 'Unknown component') AS Component,
        ${GROUP_SQL} AS AboGroup,
        ${RH_SQL} AS Rh,
        COUNT(*) AS Units
    FROM Events E
    INNER JOIN dbo.UNIT U ON U.ID_UNIT = E.ID_UNIT
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = U.ID_COMPONENT
    GROUP BY E.Kind, E.EventDate, U.ID_COMPONENT, C.DES_COMPONENT, ${GROUP_SQL}, ${RH_SQL}
    ORDER BY E.EventDate;
  `);
  return result.recordset;
}

// ════════════════════════════════════════════════════════════════
// Shaping (plain JS — shared by the stock routes and Smart Alerts)
// ════════════════════════════════════════════════════════════════
function ymd(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function bloodGroup(abo, rh) {
  const g = `${abo || ""}${rh || ""}`;
  return g || "Unknown";
}

function levelStatus(count, alert, critical) {
  if (critical != null && count <= critical) return "critical";
  if (alert != null && count <= alert) return "low";
  return "ok";
}

// ABO-only key ("A") matches both Rh; a full key ("A+") matches just itself.
function groupMatches(levelKey, unitGroup) {
  return /[+-]$/.test(levelKey) ? unitGroup === levelKey : unitGroup.replace(/[+-]$/, "") === levelKey;
}

// One entry per STOCK category, with a row for every blood group that has
// a level set: current count (all the category's components together),
// alert / critical level and status.
function evaluateLevels(levelRows, shapedUnits) {
  const inDate = shapedUnits.filter(u => u.status !== "expired");
  return levelRows
    .slice()
    .sort((a, b) => (a.NUM_ORDER ?? 999) - (b.NUM_ORDER ?? 999) || a.ID_STOCK - b.ID_STOCK)
    .map(row => {
      const compIds = new Set(row.components.map(c => c.id));
      const units = inDate.filter(u => compIds.has(u.componentId));
      const groups = [];
      for (const [groupKey, col] of Object.entries(LEVEL_COLUMNS)) {
        const alert = row[`NUM_ALERT_${col}`];
        const critical = row[`NUM_CRITICAL_${col}`];
        if (alert == null && critical == null) continue;
        const count = units.filter(u => groupMatches(groupKey, u.group)).length;
        groups.push({ group: groupKey, count, alert, critical, status: levelStatus(count, alert, critical) });
      }
      return {
        stockId: row.ID_STOCK,
        name: row.DES_STOCK || `Stock #${row.ID_STOCK}`,
        centreId: row.ID_CENTRE,
        components: row.components.map(c => c.name),
        groups,
      };
    })
    .filter(s => s.groups.length > 0);
}

// Builds everything the stock dashboard and the alerts need from the raw
// unit list + levels:
//   components  – per component: available / near-expiry / expired per group
//   levels      – per STOCK category: count vs alert / critical per group
//   nextToIssue – oldest in-date unit per component + group (oldest-first)
//   units       – the in-stock list, already oldest-first
function buildStockOverview({ units, expiredNotDiscardedTotal, truncated }, levelInfo, nearDays) {
  const components = new Map(); // componentId -> row

  const shapedUnits = units.map(u => {
    const days = u.DaysToExpiry;
    const status = days == null ? "ok" : days < 0 ? "expired" : days <= nearDays ? "near" : "ok";
    return {
      id: u.ID_UNIT,
      unitNumber: u.UnitNumber,
      division: u.Division || "",
      componentId: u.ComponentId,
      component: u.Component,
      componentType: u.ComponentType || "",
      abo: u.AboGroup || "",
      group: bloodGroup(u.AboGroup, u.Rh),
      expiryDate: ymd(u.ExpiryDate),
      daysToExpiry: days,
      status,
    };
  });

  for (const u of shapedUnits) {
    if (!components.has(u.componentId)) {
      components.set(u.componentId, {
        componentId: u.componentId, component: u.component, componentType: u.componentType,
        groups: {}, available: 0, near: 0, expired: 0,
      });
    }
    const c = components.get(u.componentId);
    const g = (c.groups[u.group] ||= { available: 0, near: 0, expired: 0, oldestExpiry: null });
    if (u.status === "expired") { g.expired++; c.expired++; continue; }
    g.available++; c.available++;
    if (u.status === "near") { g.near++; c.near++; }
    if (u.expiryDate && (!g.oldestExpiry || u.expiryDate < g.oldestExpiry)) g.oldestExpiry = u.expiryDate;
  }

  const levels = evaluateLevels(levelInfo.rows, shapedUnits);
  const levelGroups = levels.flatMap(s => s.groups);

  const nextToIssue = [];
  const seen = new Set();
  for (const u of shapedUnits) { // already oldest-first
    if (u.status === "expired") continue;
    const key = `${u.componentId}|${u.group}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nextToIssue.push(u);
  }

  const componentRows = [...components.values()].sort((a, b) => b.available - a.available);

  const totals = {
    available: componentRows.reduce((s, c) => s + c.available, 0),
    near: componentRows.reduce((s, c) => s + c.near, 0),
    expiredNotDiscarded: expiredNotDiscardedTotal,
    lowLevels: levelGroups.filter(l => l.status === "low").length,
    criticalLevels: levelGroups.filter(l => l.status === "critical").length,
  };

  return {
    generatedAt: new Date().toISOString(),
    nearDays,
    groups: GROUPS,
    levelsConfigured: levelInfo.available && levelInfo.rows.length > 0,
    levelsTableExists: levelInfo.available,
    totals,
    components: componentRows,
    levels,
    nextToIssue,
    units: shapedUnits,
    expiredListDays: EXPIRED_LIST_DAYS,
    truncated,
  };
}

function buildMovementSummary(rows, dateFrom, dateToExclusive) {
  const KINDS = ["received", "issued", "sent", "returned", "discarded"];
  const empty = () => Object.fromEntries(KINDS.map(k => [k, 0]));
  const totals = empty();
  const byComponent = new Map();
  const byGroup = new Map();
  const byDay = new Map();

  for (const r of rows) {
    const n = r.Units;
    totals[r.Kind] += n;
    const compKey = r.ComponentId;
    if (!byComponent.has(compKey)) byComponent.set(compKey, { componentId: compKey, component: r.Component, ...empty() });
    byComponent.get(compKey)[r.Kind] += n;
    const group = bloodGroup(r.AboGroup, r.Rh);
    if (!byGroup.has(group)) byGroup.set(group, { group, ...empty() });
    byGroup.get(group)[r.Kind] += n;
    const day = ymd(r.EventDate);
    if (!byDay.has(day)) byDay.set(day, { date: day, ...empty() });
    byDay.get(day)[r.Kind] += n;
  }

  // Fill gaps so the chart's x-axis is continuous.
  const daily = [];
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateToExclusive}T00:00:00Z`);
  for (let d = start; d < end && daily.length < 400; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    daily.push(byDay.get(key) || { date: key, ...empty() });
  }

  return {
    from: dateFrom,
    to: ymd(new Date(end.getTime() - 86400000)),
    totals,
    byComponent: [...byComponent.values()].sort((a, b) => (b.issued + b.received) - (a.issued + a.received)),
    byGroup: [...byGroup.values()].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)),
    daily,
  };
}

// ── Smart-alert rules (used by /api/dashboard/alerts) ───────────────
function stockAlerts(overview) {
  const alerts = [];
  const flat = overview.levels.flatMap(s => s.groups.map(g => ({ ...g, stockId: s.stockId, stock: s.name })));
  const crit = flat.filter(l => l.status === "critical");
  const low = flat.filter(l => l.status === "low");
  const describe = l => `${l.stock} ${l.group}: ${l.count} (level ${l.status === "critical" ? l.critical : l.alert})`;
  const list = items => {
    const shown = items.slice(0, 6).map(describe).join("; ");
    return items.length > 6 ? `${shown}; and ${items.length - 6} more` : shown;
  };
  // The id changes when the set of affected groups changes, so a dismissed
  // alert comes back if a different group drops low.
  const idOf = items => items.map(l => `${l.stockId}${l.group}`).join("_").replace(/\+/g, "p").replace(/-/g, "n");

  if (crit.length) {
    alerts.push({
      id: `stock_critical_${idOf(crit)}`,
      severity: "critical", icon: "blood", page: "stock",
      title: "Critical Stock Level",
      message: `${crit.length} blood group${crit.length > 1 ? "s are" : " is"} at or below the critical level. ${list(crit)}.`,
    });
  }
  if (low.length) {
    alerts.push({
      id: `stock_low_${idOf(low)}`,
      severity: "warning", icon: "blood", page: "stock",
      title: "Low Stock",
      message: `${low.length} blood group${low.length > 1 ? "s are" : " is"} at or below the alert level. ${list(low)}.`,
    });
  }

  const near = overview.units.filter(u => u.status === "near");
  if (near.length) {
    const soonest = near.filter(u => u.daysToExpiry <= 2).length;
    const byComp = {};
    for (const u of near) byComp[u.component] = (byComp[u.component] || 0) + 1;
    alerts.push({
      id: `stock_near_expiry_${near.length}_${soonest}`,
      severity: soonest > 0 ? "critical" : "warning", icon: "clock", page: "stock",
      title: "Units Near Expiry",
      message: `${near.length} unit${near.length > 1 ? "s" : ""} in stock expire within ${overview.nearDays} days` +
        (soonest ? ` (${soonest} within 2 days)` : "") +
        `: ${Object.entries(byComp).map(([c, n]) => `${n} ${c}`).join(", ")}. Issue these first.`,
    });
  }

  if (overview.totals.expiredNotDiscarded > 0) {
    const n = overview.totals.expiredNotDiscarded;
    alerts.push({
      id: `stock_expired_${n}`,
      severity: "warning", icon: "calendar", page: "stock",
      title: "Expired Units Not Discarded",
      message: `${n} expired unit${n > 1 ? "s are" : " is"} still recorded as in stock. Discard ${n > 1 ? "them" : "it"} in eDelphyn so stock counts stay accurate.`,
    });
  }
  return alerts;
}

async function getStockOverview(pool, nearDays) {
  const [unitData, levelInfo] = await Promise.all([stockUnits(pool), stockLevels(pool)]);
  return buildStockOverview(unitData, levelInfo, nearDays);
}

module.exports = {
  getStockOverview,
  stockMovements,
  buildMovementSummary,
  stockAlerts,
};
