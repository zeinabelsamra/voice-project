const sql = require("mssql");

// Read-only extraction queries against the hospital's e-Delphyn schema.
// Column aliases ([Date], [Group], [Component], [Reason], [Hospital], [Returned],
// [IAT], [Department], [Request type], [Donation type], [Bag], [DOB], [Gender], ...)
// are chosen to match what excelFindCol()/excelSummary() in server.js already look
// for by name, so the existing aggregation logic works unchanged against these rows.

const QUERIES = {
  external_units: `
    SELECT
        COALESCE(d.DAT_EXTERNALENTRY, d.DAT_DONATION)              AS [Date],
        COALESCE(d.TIM_EXTERNALENTRY, d.TIM_START, d.TIM_DONATION) AS [Time],
        dt.DES_DONATIONTYPE                                        AS [Donation type],
        d.COD_DONATION                                             AS [Donation],
        COALESCE(d.DES_BAGSERIAL, bt.COD_BAGTYPE, bt.DES_BAGTYPE)  AS [Bag]
    FROM dbo.DONATION AS d
    LEFT JOIN dbo.DONATIONTYPE AS dt ON dt.ID_DONATIONTYPE = d.ID_DONATIONTYPE
    LEFT JOIN dbo.BAGTYPE      AS bt ON bt.ID_BAGTYPE = d.ID_BAGTYPE
    WHERE COALESCE(d.DAT_EXTERNALENTRY, d.DAT_DONATION) >= @DateFrom
      AND COALESCE(d.DAT_EXTERNALENTRY, d.DAT_DONATION) <  @DateTo
      AND (d.LOG_ENTRY = 1 OR d.DAT_EXTERNALENTRY IS NOT NULL OR d.ID_BAGORIGIN IS NOT NULL)
    ORDER BY [Date], [Time], d.COD_DONATION;
  `,

  donors: `
    SELECT
        d.ID_DONATION                                              AS [seq],
        LTRIM(RTRIM(CONCAT(p.DES_NAME, ' ', p.DES_MIDDLENAME, ' ', p.DES_SURNAME))) AS [Donor],
        n.DES_NATIONALITY                                          AS [Nationality],
        COALESCE(t.DES_TOWN, p.DES_TOWN)                            AS [City],
        st.DES_STATE                                               AS [Mohafaza],
        d.DAT_DONATION                                             AS [Date],
        COALESCE(d.TIM_START, d.TIM_DONATION)                       AS [Time],
        dt.DES_DONATIONTYPE                                        AS [Donation type],
        d.COD_DONATION                                             AS [Donation],
        COALESCE(d.DES_BAGSERIAL, bt.COD_BAGTYPE, bt.DES_BAGTYPE)  AS [Bag],
        NULLIF(CONCAT(NULLIF(p.COD_GROUP, ''), NULLIF(p.COD_RH, '')), '') AS [Group],
        cs.DES_CELLSEPARATOR                                       AS [Separator],
        CAST(NULL AS nvarchar(200))                                 AS [Patient],
        CASE p.COD_GENDER WHEN 'M' THEN 'Male' WHEN 'F' THEN 'Female' ELSE p.COD_GENDER END AS [Gender],
        p.DAT_BIRTH                                                AS [DOB]
    FROM dbo.DONATION AS d
    INNER JOIN dbo.PERSON AS p ON p.ID_PERSON = d.ID_PERSON
    LEFT JOIN dbo.NATIONALITY  AS n  ON n.ID_NATIONALITY = p.ID_NATIONALITY
    LEFT JOIN dbo.TOWN         AS t  ON t.ID_TOWN = p.ID_TOWN
    LEFT JOIN dbo.STATE        AS st ON st.ID_STATE = COALESCE(p.ID_STATE, t.ID_STATE)
    LEFT JOIN dbo.DONATIONTYPE AS dt ON dt.ID_DONATIONTYPE = d.ID_DONATIONTYPE
    LEFT JOIN dbo.BAGTYPE      AS bt ON bt.ID_BAGTYPE = d.ID_BAGTYPE
    LEFT JOIN dbo.CELLSEPARATOR AS cs ON cs.ID_CELLSEPARATOR = d.ID_CELLSEPARATOR
    WHERE d.DAT_DONATION >= @DateFrom
      AND d.DAT_DONATION <  @DateTo
    ORDER BY d.DAT_DONATION, COALESCE(d.TIM_START, d.TIM_DONATION), d.COD_DONATION;
  `,

  transfusion: `
    SELECT
        tr.DAT_TRANSFUSION                                        AS [Date],
        tr.TIM_TRANSFUSION                                        AS [Time],
        ofm.COD_ORDERFORM                                          AS [Order form],
        sm.COD_SAMPLE                                              AS [Sample],
        o.DES_ORIGIN                                               AS [Origin],
        LTRIM(RTRIM(CONCAT(p.DES_NAME, ' ', p.DES_MIDDLENAME, ' ', p.DES_SURNAME))) AS [Patient],
        hn.COD_HOSPITALNUMBER                                     AS [Patient number],
        NULLIF(CONCAT(NULLIF(p.COD_GROUP, ''), NULLIF(p.COD_RH, '')), '') AS [Group],
        c.DES_COMPONENT                                            AS [Component],
        CONCAT(u.COD_UNIT, CASE WHEN NULLIF(u.COD_DIVISION, '') IS NULL THEN '' ELSE CONCAT('-', u.COD_DIVISION) END) AS [Unit],
        NULLIF(CONCAT(NULLIF(u.COD_GROUP, ''), NULLIF(u.COD_RH, '')), '') AS [Unit Group],
        tr.DES_TAKENBY                                             AS [Hand to],
        COALESCE(dst.DES_DESTINATION, tr.DES_WARD, w.DES_WARD)      AS [Destination],
        u.COD_CMV                                                  AS [C.M.],
        CASE WHEN tr.DAT_TRANSFUSION IS NOT NULL THEN 1 ELSE 0 END AS [Issued],
        CASE WHEN tr.DAT_RETURN IS NOT NULL OR tr.COD_RETURN NOT IN ('', '0') THEN 1 ELSE 0 END AS [Returned],
        cust.DES_CUSTOMER                                          AS [Customer],
        pr.DES_PRIORITY                                            AS [Priority]
    FROM dbo.TRANSFUSION AS tr
    LEFT JOIN dbo.ORDERFORM AS ofm ON ofm.ID_ORDERFORM = tr.ID_ORDERFORM
    LEFT JOIN dbo.PERSON    AS p   ON p.ID_PERSON = COALESCE(tr.ID_PERSON, ofm.ID_PERSON)
    LEFT JOIN dbo.UNIT      AS u   ON u.ID_UNIT = tr.ID_UNIT
    LEFT JOIN dbo.COMPONENT AS c   ON c.ID_COMPONENT = u.ID_COMPONENT
    LEFT JOIN dbo.DESTINATION AS dst ON dst.ID_DESTINATION = COALESCE(tr.ID_DESTINATION, ofm.ID_DESTINATION)
    LEFT JOIN dbo.WARD      AS w   ON w.ID_WARD = COALESCE(tr.ID_WARD, ofm.ID_WARD)
    LEFT JOIN dbo.ORIGIN    AS o   ON o.ID_ORIGIN = ofm.ID_ORIGIN
    LEFT JOIN dbo.CUSTOMER  AS cust ON cust.ID_CUSTOMER = ofm.ID_CUSTOMER
    LEFT JOIN dbo.PRIORITY  AS pr  ON pr.ID_PRIORITY = ofm.ID_PRIORITY
    OUTER APPLY (
        SELECT TOP (1) s.COD_SAMPLE
        FROM dbo.ORDERFORM_SAMPLE AS ofs
        INNER JOIN dbo.SAMPLE AS s ON s.ID_SAMPLE = ofs.ID_SAMPLE
        WHERE ofs.ID_ORDERFORM = ofm.ID_ORDERFORM
        ORDER BY s.DAT_SAMPLE DESC, s.TIM_SAMPLE DESC, s.ID_SAMPLE DESC
    ) AS sm
    OUTER APPLY (
        SELECT TOP (1) h.COD_HOSPITALNUMBER
        FROM dbo.HOSPITALNUMBER AS h
        WHERE h.ID_PERSON = p.ID_PERSON
          AND (h.ID_CENTRE = ofm.ID_CENTRE OR ofm.ID_CENTRE IS NULL)
        ORDER BY CASE WHEN h.ID_CENTRE = ofm.ID_CENTRE THEN 0 ELSE 1 END
    ) AS hn
    WHERE tr.DAT_TRANSFUSION >= @DateFrom
      AND tr.DAT_TRANSFUSION <  @DateTo
    ORDER BY tr.DAT_TRANSFUSION, tr.TIM_TRANSFUSION, ofm.COD_ORDERFORM, u.COD_UNIT;
  `,

  sent_to_centres: `
    SELECT
        rd.DES_REQUESTDEST                                         AS [Hospital],
        dn.COD_DELIVERYNOTE                                        AS [Delivery Note],
        c.DES_COMPONENT                                            AS [Component],
        ct.DES_COMPONENTTYPE                                       AS [Component Type],
        COALESCE(dd.DAT_DELIVERYDETAIL, dn.DAT_DELIVERYNOTE, r.DAT_DELIVERY) AS [Date],
        COALESCE(dd.TIM_DELIVERYDETAIL, dn.TIM_DELIVERYNOTE, r.TIM_DELIVERY) AS [Time],
        CONCAT(u.COD_UNIT, CASE WHEN NULLIF(u.COD_DIVISION, '') IS NULL THEN '' ELSE CONCAT('-', u.COD_DIVISION) END) AS [Unit],
        NULLIF(CONCAT(NULLIF(u.COD_GROUP, ''), NULLIF(u.COD_RH, '')), '') AS [Group],
        COALESCE(dd.DAT_EXPIRY, u.DAT_EXPIRY)                       AS [Expiry],
        CASE WHEN dd.DAT_RETURN IS NOT NULL OR dd.COD_RETURN NOT IN ('', '0') THEN 1 ELSE 0 END AS [Returned]
    FROM dbo.DELIVERYDETAIL AS dd
    INNER JOIN dbo.REQUEST AS r ON r.ID_REQUEST = dd.ID_REQUEST
    LEFT JOIN dbo.DELIVERYNOTE AS dn ON dn.ID_DELIVERYNOTE = dd.ID_DELIVERYNOTE
    LEFT JOIN dbo.REQUESTDEST  AS rd ON rd.ID_REQUESTDEST = r.ID_REQUESTDEST
    LEFT JOIN dbo.UNIT         AS u  ON u.ID_UNIT = dd.ID_UNIT
    LEFT JOIN dbo.COMPONENT    AS c  ON c.ID_COMPONENT = COALESCE(dd.ID_COMPONENT, u.ID_COMPONENT)
    LEFT JOIN dbo.COMPONENTTYPE AS ct ON ct.ID_COMPONENTTYPE = c.ID_COMPONENTTYPE
    WHERE COALESCE(dd.DAT_DELIVERYDETAIL, dn.DAT_DELIVERYNOTE, r.DAT_DELIVERY) >= @DateFrom
      AND COALESCE(dd.DAT_DELIVERYDETAIL, dn.DAT_DELIVERYNOTE, r.DAT_DELIVERY) <  @DateTo
    ORDER BY [Date], [Time], dn.COD_DELIVERYNOTE, u.COD_UNIT;
  `,

  wasted: `
    SELECT
        COALESCE(dbu.DAT_DESTROYBOXUNIT, db.DAT_DESTROYBOX)         AS [Date],
        COALESCE(dbu.TIM_DESTROYBOXUNIT, db.TIM_DESTROYBOX)         AS [Time],
        c.DES_COMPONENT                                            AS [Component],
        CONCAT(u.COD_UNIT, CASE WHEN NULLIF(u.COD_DIVISION, '') IS NULL THEN '' ELSE CONCAT('-', u.COD_DIVISION) END) AS [Unit],
        NULLIF(CONCAT(NULLIF(u.COD_GROUP, ''), NULLIF(u.COD_RH, '')), '') AS [Group],
        u.COD_REJECTREASON                                         AS [Reason],
        CAST(NULL AS nvarchar(50))                                 AS [Delivery Note],
        db.COD_DESTROYBOX                                          AS [Box]
    FROM dbo.DESTROYBOXUNIT AS dbu
    INNER JOIN dbo.DESTROYBOX AS db ON db.ID_DESTROYBOX = dbu.ID_DESTROYBOX
    INNER JOIN dbo.UNIT       AS u  ON u.ID_UNIT = dbu.ID_UNIT
    LEFT JOIN dbo.COMPONENT   AS c  ON c.ID_COMPONENT = u.ID_COMPONENT
    WHERE COALESCE(dbu.DAT_DESTROYBOXUNIT, db.DAT_DESTROYBOX) >= @DateFrom
      AND COALESCE(dbu.DAT_DESTROYBOXUNIT, db.DAT_DESTROYBOX) <  @DateTo
    ORDER BY [Date], [Time], db.COD_DESTROYBOX, u.COD_UNIT;
  `,
};

// Patient-request workflow: e-Delphyn installs use either ORDERFORM or the
// REQUEST/REQUESTPATIENT/REQUESTDETAIL family, never both. Resolved once per
// process by probing which one actually has rows.
const REQUESTS_ORDERFORM = `
  SELECT
      ofm.DAT_ORDERFORM                                          AS [Date],
      ofm.TIM_ORDERFORM                                          AS [Time],
      ofm.COD_ORDERFORM                                          AS [Order form],
      LTRIM(RTRIM(CONCAT(p.DES_NAME, ' ', p.DES_MIDDLENAME, ' ', p.DES_SURNAME))) AS [Patient],
      NULLIF(CONCAT(NULLIF(p.COD_GROUP, ''), NULLIF(p.COD_RH, '')), '') AS [Group],
      p.COD_IAT                                                  AS [IAT],
      COALESCE(dep.DES_DEPARTMENT, ofm.DES_WARD, w.DES_WARD)      AS [Department],
      COALESCE(ct.DES_COMPONENTTYPE, c.DES_COMPONENT, ot.DES_ORDERTYPE) AS [Request type],
      o.DES_ORIGIN                                               AS [Origin]
  FROM dbo.ORDERFORM AS ofm
  INNER JOIN dbo.PERSON AS p ON p.ID_PERSON = ofm.ID_PERSON
  LEFT JOIN dbo.DEPARTMENT    AS dep ON dep.ID_DEPARTMENT = ofm.ID_DEPARTMENT
  LEFT JOIN dbo.WARD          AS w   ON w.ID_WARD = ofm.ID_WARD
  LEFT JOIN dbo.COMPONENTTYPE AS ct  ON ct.ID_COMPONENTTYPE = ofm.ID_COMPONENTTYPE
  LEFT JOIN dbo.COMPONENT     AS c   ON c.ID_COMPONENT = ofm.ID_COMPONENT
  LEFT JOIN dbo.ORDERTYPE     AS ot  ON ot.ID_ORDERTYPE = ofm.ID_ORDERTYPE
  LEFT JOIN dbo.ORIGIN        AS o   ON o.ID_ORIGIN = ofm.ID_ORIGIN
  WHERE ofm.DAT_ORDERFORM >= @DateFrom
    AND ofm.DAT_ORDERFORM <  @DateTo
    AND ISNULL(ofm.LOG_CANCELLED, 0) = 0
  ORDER BY ofm.DAT_ORDERFORM, ofm.TIM_ORDERFORM, ofm.COD_ORDERFORM;
`;

const REQUESTS_ALT = `
  SELECT
      r.DAT_REQUEST                                              AS [Date],
      r.TIM_REQUEST                                              AS [Time],
      r.COD_REQUEST                                              AS [Order form],
      LTRIM(RTRIM(CONCAT(rp.DES_NAME, ' ', rp.DES_MIDDLENAME, ' ', rp.DES_SURNAME))) AS [Patient],
      rp.COD_BLOODTYPE                                           AS [Group],
      CAST(NULL AS nvarchar(20))                                 AS [IAT],
      rp.DES_DEPARTMENT                                          AS [Department],
      COALESCE(c.DES_COMPONENT, ct.DES_COMPONENTTYPE)             AS [Request type],
      ro.DES_REQUESTORIG                                         AS [Origin]
  FROM dbo.REQUEST AS r
  LEFT JOIN dbo.REQUESTPATIENT AS rp ON rp.ID_REQUEST = r.ID_REQUEST
  LEFT JOIN dbo.REQUESTDETAIL  AS rd ON rd.ID_REQUEST = r.ID_REQUEST
  LEFT JOIN dbo.COMPONENTTYPE  AS ct ON ct.ID_COMPONENTTYPE = rd.ID_COMPONENTTYPE
  LEFT JOIN dbo.COMPONENT      AS c  ON c.ID_COMPONENT = rd.ID_COMPONENT
  LEFT JOIN dbo.REQUESTORIG    AS ro ON ro.ID_REQUESTORIG = r.ID_REQUESTORIG
  WHERE r.DAT_REQUEST >= @DateFrom
    AND r.DAT_REQUEST <  @DateTo
  ORDER BY r.DAT_REQUEST, r.TIM_REQUEST, r.COD_REQUEST;
`;

const CATEGORIES = ['external_units', 'donors', 'requests', 'transfusion', 'sent_to_centres', 'wasted'];

let requestSourceResolved = null; // 'orderform' | 'request', cached for process lifetime

async function resolveRequestSource(pool) {
  if (requestSourceResolved) return requestSourceResolved;
  try {
    const r = await pool.request().query('SELECT COUNT(*) AS cnt FROM dbo.ORDERFORM');
    requestSourceResolved = (r.recordset[0].cnt > 0) ? 'orderform' : 'request';
  } catch (err) {
    console.warn('⚠️  ORDERFORM probe failed, falling back to REQUEST workflow:', err.message);
    requestSourceResolved = 'request';
  }
  console.log(`ℹ️  e-Delphyn request workflow detected: ${requestSourceResolved.toUpperCase()}`);
  return requestSourceResolved;
}

const TIME_TYPES = new Set([sql.Time]);
const DATE_TYPES = new Set([sql.Date, sql.DateTime, sql.DateTime2, sql.SmallDateTime, sql.DateTimeOffset]);

// mssql returns DATE/TIME/DATETIME columns as JS Date objects built from the
// column's UTC value. Using UTC getters (not local getters) avoids the classic
// off-by-one-day bug when the server's local timezone isn't UTC.
function normalizeSqlValue(val, type) {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) {
    if (TIME_TYPES.has(type)) {
      const h = String(val.getUTCHours()).padStart(2, '0');
      const m = String(val.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }
    if (DATE_TYPES.has(type)) {
      const y  = val.getUTCFullYear();
      const mo = String(val.getUTCMonth() + 1).padStart(2, '0');
      const d  = String(val.getUTCDate()).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    }
  }
  return val;
}

// dateFrom/dateTo: 'YYYY-MM-DD' strings — @DateFrom inclusive, @DateTo exclusive.
// Returns { columns, rows } in the same shape the old Excel-cache code produced,
// so excelSummary/excelCountBy/peakHours in server.js work unchanged.
async function runCategoryQuery(pool, category, dateFrom, dateTo) {
  let queryText;
  if (category === 'requests') {
    const source = await resolveRequestSource(pool);
    queryText = source === 'orderform' ? REQUESTS_ORDERFORM : REQUESTS_ALT;
  } else {
    queryText = QUERIES[category];
  }
  if (!queryText) throw new Error(`Unknown eDelphyn category: ${category}`);

  const request = pool.request();
  request.input('DateFrom', sql.Date, new Date(`${dateFrom}T00:00:00Z`));
  request.input('DateTo',   sql.Date, new Date(`${dateTo}T00:00:00Z`));
  const result = await request.query(queryText);

  const meta    = result.recordset.columns || {};
  const columns = Object.keys(meta);
  const rows    = result.recordset.map(row => {
    const out = {};
    for (const col of columns) out[col] = normalizeSqlValue(row[col], meta[col] && meta[col].type);
    return out;
  });
  return { columns, rows };
}

module.exports = { runCategoryQuery, CATEGORIES };
