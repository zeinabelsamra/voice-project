const sql = require("mssql");

// Advanced read-only analytics against the hospital's e-Delphyn schema —
// KPI summary, trends, donor behaviour, fulfilment/turnaround, expiry risk,
// demand heatmap, and anomaly detection. Separate from edelphynQueries.js
// (which powers the raw category tables) so the two can evolve independently.

function dateInput(request, name, value) {
  request.input(name, sql.Date, new Date(`${value}T00:00:00Z`));
}

// ── 1. Executive KPI summary ────────────────────────────────────────
async function kpiSummary(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    SELECT
        (SELECT COUNT(*) FROM dbo.DONATION D
          WHERE D.DAT_DONATION >= @DateFrom AND D.DAT_DONATION < @DateTo) AS TotalDonations,
        (SELECT COUNT(DISTINCT D.ID_PERSON) FROM dbo.DONATION D
          WHERE D.DAT_DONATION >= @DateFrom AND D.DAT_DONATION < @DateTo) AS UniqueDonors,
        (SELECT COUNT(*) FROM dbo.ORDERFORM O
          WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
            AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
            ) AS PatientRequests,
        (SELECT COALESCE(SUM(O.NUM_QUANTITY), 0) FROM dbo.ORDERFORM O
          WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
            AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
           ) AS UnitsRequested,
        (SELECT COUNT(*) FROM dbo.TRANSFUSION T
          WHERE T.DAT_TRANSFUSION >= @DateFrom AND T.DAT_TRANSFUSION < @DateTo) AS UnitsIssued,
        (SELECT COUNT(*) FROM dbo.TRANSFUSION T
          WHERE T.DAT_RETURN >= @DateFrom AND T.DAT_RETURN < @DateTo) AS UnitsReturned,
        (SELECT COUNT(*) FROM dbo.DESTROYBOXUNIT DBU
          INNER JOIN dbo.DESTROYBOX DB ON DB.ID_DESTROYBOX = DBU.ID_DESTROYBOX
          WHERE COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) >= @DateFrom
            AND COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) < @DateTo) AS WastedUnits,
        (SELECT COUNT(*) FROM dbo.DELIVERYDETAIL DD
          WHERE DD.DAT_DELIVERYDETAIL >= @DateFrom AND DD.DAT_DELIVERYDETAIL < @DateTo) AS UnitsSentExternally;
  `);
  return result.recordset[0];
}

// ── 2. Monthly supply-versus-demand trend ───────────────────────────
async function monthlyTrend(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH Months AS (
      SELECT DATEFROMPARTS(YEAR(DAT_DONATION), MONTH(DAT_DONATION), 1) AS MonthStart
      FROM dbo.DONATION WHERE DAT_DONATION >= @DateFrom AND DAT_DONATION < @DateTo
      UNION
      SELECT DATEFROMPARTS(YEAR(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), MONTH(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), 1)
      FROM dbo.ORDERFORM WHERE COALESCE(DAT_REQUEST, DAT_ORDERFORM) >= @DateFrom AND COALESCE(DAT_REQUEST, DAT_ORDERFORM) < @DateTo
      UNION
      SELECT DATEFROMPARTS(YEAR(DAT_TRANSFUSION), MONTH(DAT_TRANSFUSION), 1)
      FROM dbo.TRANSFUSION WHERE DAT_TRANSFUSION >= @DateFrom AND DAT_TRANSFUSION < @DateTo
    ),
    Donations AS (
      SELECT DATEFROMPARTS(YEAR(DAT_DONATION), MONTH(DAT_DONATION), 1) AS MonthStart, COUNT(*) AS DonationCount
      FROM dbo.DONATION WHERE DAT_DONATION >= @DateFrom AND DAT_DONATION < @DateTo
      GROUP BY DATEFROMPARTS(YEAR(DAT_DONATION), MONTH(DAT_DONATION), 1)
    ),
    Requests AS (
      SELECT DATEFROMPARTS(YEAR(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), MONTH(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), 1) AS MonthStart,
             SUM(COALESCE(NUM_QUANTITY, 0)) AS RequestedUnits
      FROM dbo.ORDERFORM
      WHERE COALESCE(DAT_REQUEST, DAT_ORDERFORM) >= @DateFrom AND COALESCE(DAT_REQUEST, DAT_ORDERFORM) < @DateTo
        
      GROUP BY DATEFROMPARTS(YEAR(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), MONTH(COALESCE(DAT_REQUEST, DAT_ORDERFORM)), 1)
    ),
    Issued AS (
      SELECT DATEFROMPARTS(YEAR(DAT_TRANSFUSION), MONTH(DAT_TRANSFUSION), 1) AS MonthStart, COUNT(*) AS IssuedUnits
      FROM dbo.TRANSFUSION WHERE DAT_TRANSFUSION >= @DateFrom AND DAT_TRANSFUSION < @DateTo
      GROUP BY DATEFROMPARTS(YEAR(DAT_TRANSFUSION), MONTH(DAT_TRANSFUSION), 1)
    ),
    Wastage AS (
      SELECT DATEFROMPARTS(YEAR(COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX)), MONTH(COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX)), 1) AS MonthStart,
             COUNT(*) AS WastedUnits
      FROM dbo.DESTROYBOXUNIT DBU
      INNER JOIN dbo.DESTROYBOX DB ON DB.ID_DESTROYBOX = DBU.ID_DESTROYBOX
      WHERE COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) >= @DateFrom
        AND COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX) < @DateTo
      GROUP BY DATEFROMPARTS(YEAR(COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX)), MONTH(COALESCE(DBU.DAT_DESTROYBOXUNIT, DB.DAT_DESTROYBOX)), 1)
    )
    SELECT
        M.MonthStart,
        COALESCE(D.DonationCount, 0) AS Donations,
        COALESCE(R.RequestedUnits, 0) AS RequestedUnits,
        COALESCE(I.IssuedUnits, 0) AS IssuedUnits,
        COALESCE(W.WastedUnits, 0) AS WastedUnits
    FROM Months M
    LEFT JOIN Donations D ON D.MonthStart = M.MonthStart
    LEFT JOIN Requests R ON R.MonthStart = M.MonthStart
    LEFT JOIN Issued I ON I.MonthStart = M.MonthStart
    LEFT JOIN Wastage W ON W.MonthStart = M.MonthStart
    ORDER BY M.MonthStart;
  `);
  return result.recordset;
}

// ── 3. Donation distribution by type ────────────────────────────────
async function donationTypes(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    SELECT
        DT.ID_DONATIONTYPE,
        COALESCE(DT.DES_DONATIONTYPE, DT.SRT_DONATIONTYPE, 'Unknown') AS DonationType,
        COUNT(*) AS DonationCount,
        COUNT(DISTINCT D.ID_PERSON) AS UniqueDonors,
        AVG(CAST(D.NUM_VOLUME AS decimal(18,2))) AS AverageVolume,
        AVG(CAST(D.NUM_PHLEBTIME AS decimal(18,2))) AS AverageCollectionTime
    FROM dbo.DONATION D
    LEFT JOIN dbo.DONATIONTYPE DT ON DT.ID_DONATIONTYPE = D.ID_DONATIONTYPE
    WHERE D.DAT_DONATION >= @DateFrom AND D.DAT_DONATION < @DateTo
    GROUP BY DT.ID_DONATIONTYPE, DT.DES_DONATIONTYPE, DT.SRT_DONATIONTYPE
    ORDER BY DonationCount DESC;
  `);
  return result.recordset;
}

// ── 5. New-versus-returning donors ──────────────────────────────────
async function donorRetention(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH DonorHistory AS (
      SELECT D.ID_DONATION, D.ID_PERSON, D.DAT_DONATION,
             MIN(D.DAT_DONATION) OVER (PARTITION BY D.ID_PERSON) AS FirstDonationDate
      FROM dbo.DONATION D
    )
    SELECT
        DATEFROMPARTS(YEAR(DAT_DONATION), MONTH(DAT_DONATION), 1) AS MonthStart,
        SUM(CASE WHEN DAT_DONATION = FirstDonationDate THEN 1 ELSE 0 END) AS NewDonors,
        SUM(CASE WHEN DAT_DONATION > FirstDonationDate THEN 1 ELSE 0 END) AS ReturningDonations,
        COUNT(DISTINCT ID_PERSON) AS ActiveDonors
    FROM DonorHistory
    WHERE DAT_DONATION >= @DateFrom AND DAT_DONATION < @DateTo
    GROUP BY DATEFROMPARTS(YEAR(DAT_DONATION), MONTH(DAT_DONATION), 1)
    ORDER BY MonthStart;
  `);
  return result.recordset;
}

// ── 6. Donor inactivity and recall opportunities ────────────────────
async function donorRecall(pool, inactiveDays) {
  const request = pool.request();
  request.input("InactiveDays", sql.Int, inactiveDays);
  const result = await request.query(`
    WITH LastDonation AS (
      SELECT D.ID_PERSON, MAX(D.DAT_DONATION) AS LastDonationDate, COUNT(*) AS LifetimeDonations
      FROM dbo.DONATION D
      GROUP BY D.ID_PERSON
    )
    SELECT TOP 200
        P.ID_PERSON,
        P.COD_DONOR AS DonorNumber,
        CONCAT_WS(' ', P.DES_NAME, P.DES_MIDDLENAME, P.DES_SURNAME) AS DonorName,
        CONCAT(LTRIM(RTRIM(COALESCE(P.COD_GROUP, ''))), LTRIM(RTRIM(COALESCE(P.COD_RH, '')))) AS BloodGroup,
        LD.LastDonationDate,
        DATEDIFF(DAY, LD.LastDonationDate, GETDATE()) AS DaysSinceDonation,
        LD.LifetimeDonations,
        P.DES_MOBILEPHONE,
        P.DES_EMAIL,
        P.COD_ACCEPTED,
        P.DAT_DEFERRED,
        P.DAT_INACTIVATION
    FROM LastDonation LD
    INNER JOIN dbo.PERSON P ON P.ID_PERSON = LD.ID_PERSON
    WHERE DATEDIFF(DAY, LD.LastDonationDate, GETDATE()) >= @InactiveDays
      AND P.DAT_INACTIVATION IS NULL
    ORDER BY DaysSinceDonation DESC, LD.LifetimeDonations DESC;
  `);
  return result.recordset;
}

// ── 9. Request fulfilment rate ──────────────────────────────────────
async function fulfilmentRate(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH IssuedPerOrder AS (
      SELECT T.ID_ORDERFORM,
             COUNT(*) AS IssuedUnits,
             SUM(CASE WHEN T.DAT_RETURN IS NOT NULL THEN 1 ELSE 0 END) AS ReturnedUnits
      FROM dbo.TRANSFUSION T
      GROUP BY T.ID_ORDERFORM
    )
    SELECT
        O.ID_ORDERFORM,
        O.COD_ORDERFORM,
        COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) AS RequestDate,
        O.NUM_QUANTITY AS RequestedUnits,
        COALESCE(I.IssuedUnits, 0) AS IssuedUnits,
        COALESCE(I.ReturnedUnits, 0) AS ReturnedUnits,
        CASE WHEN COALESCE(O.NUM_QUANTITY, 0) = 0 THEN NULL
             ELSE 100.0 * COALESCE(I.IssuedUnits, 0) / O.NUM_QUANTITY END AS FulfilmentPercentage,
        CASE WHEN COALESCE(I.IssuedUnits, 0) = 0 THEN 'Not fulfilled'
             WHEN COALESCE(I.IssuedUnits, 0) < O.NUM_QUANTITY THEN 'Partially fulfilled'
             WHEN COALESCE(I.IssuedUnits, 0) = O.NUM_QUANTITY THEN 'Fully fulfilled'
             ELSE 'Issued above request' END AS FulfilmentStatus
    FROM dbo.ORDERFORM O
    LEFT JOIN IssuedPerOrder I ON I.ID_ORDERFORM = O.ID_ORDERFORM
    WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
      AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
      
    ORDER BY RequestDate DESC;
  `);
  return result.recordset;
}

// ── 10. Request turnaround time ─────────────────────────────────────
async function turnaroundTime(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH IssueTimes AS (
      SELECT O.ID_ORDERFORM, O.ID_DEPARTMENT, O.ID_COMPONENTTYPE, O.LOG_EMERGENCY,
             DATEADD(SECOND, DATEDIFF(SECOND, CAST('00:00:00' AS time), COALESCE(O.TIM_REQUEST, O.TIM_ORDERFORM)),
                     CAST(COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) AS datetime2)) AS RequestDateTime,
             DATEADD(SECOND, DATEDIFF(SECOND, CAST('00:00:00' AS time), T.TIM_TRANSFUSION),
                     CAST(T.DAT_TRANSFUSION AS datetime2)) AS IssueDateTime
      FROM dbo.ORDERFORM O
      INNER JOIN dbo.TRANSFUSION T ON T.ID_ORDERFORM = O.ID_ORDERFORM
      WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
        AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
        AND T.DAT_TRANSFUSION IS NOT NULL
    )
    SELECT
        DPT.DES_DEPARTMENT AS Department,
        CT.DES_COMPONENTTYPE AS ComponentType,
        LOG_EMERGENCY AS IsEmergency,
        COUNT(*) AS IssuedUnits,
        AVG(CAST(DATEDIFF(MINUTE, RequestDateTime, IssueDateTime) AS decimal(18,2))) AS AverageTurnaroundMinutes,
        MIN(DATEDIFF(MINUTE, RequestDateTime, IssueDateTime)) AS MinimumTurnaroundMinutes,
        MAX(DATEDIFF(MINUTE, RequestDateTime, IssueDateTime)) AS MaximumTurnaroundMinutes
    FROM IssueTimes I
    LEFT JOIN dbo.DEPARTMENT DPT ON DPT.ID_DEPARTMENT = I.ID_DEPARTMENT
    LEFT JOIN dbo.COMPONENTTYPE CT ON CT.ID_COMPONENTTYPE = I.ID_COMPONENTTYPE
    WHERE IssueDateTime >= RequestDateTime
    GROUP BY DPT.DES_DEPARTMENT, CT.DES_COMPONENTTYPE, LOG_EMERGENCY
    ORDER BY AverageTurnaroundMinutes DESC;
  `);
  return result.recordset;
}

// ── 11. Unit return rate ────────────────────────────────────────────
async function returnRate(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    SELECT
        CT.DES_COMPONENTTYPE AS ComponentType,
        COUNT(*) AS UnitsIssued,
        SUM(CASE WHEN T.DAT_RETURN IS NOT NULL OR T.COD_RETURN NOT IN ('', '0') THEN 1 ELSE 0 END) AS UnitsReturned,
        CAST(100.0 * SUM(CASE WHEN T.DAT_RETURN IS NOT NULL OR T.COD_RETURN NOT IN ('', '0') THEN 1 ELSE 0 END)
             / NULLIF(COUNT(*), 0) AS decimal(10,2)) AS ReturnRate
    FROM dbo.TRANSFUSION T
    INNER JOIN dbo.UNIT U ON U.ID_UNIT = T.ID_UNIT
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = U.ID_COMPONENT
    LEFT JOIN dbo.COMPONENTTYPE CT ON CT.ID_COMPONENTTYPE = C.ID_COMPONENTTYPE
    WHERE T.DAT_TRANSFUSION >= @DateFrom AND T.DAT_TRANSFUSION < @DateTo
    GROUP BY CT.DES_COMPONENTTYPE
    ORDER BY ReturnRate DESC;
  `);
  return result.recordset;
}

// ── 15. Expiry-risk query ───────────────────────────────────────────
async function expiryRisk(pool, expiryDays) {
  const request = pool.request();
  request.input("ExpiryDays", sql.Int, expiryDays);
  const result = await request.query(`
    SELECT
        U.ID_UNIT,
        U.COD_UNIT AS UnitNumber,
        U.COD_DIVISION AS Division,
        CT.DES_COMPONENTTYPE AS ComponentType,
        C.DES_COMPONENT AS Component,
        CONCAT(LTRIM(RTRIM(COALESCE(U.COD_GROUP, ''))), LTRIM(RTRIM(COALESCE(U.COD_RH, '')))) AS BloodGroup,
        U.DAT_EXPIRY AS ExpiryDate,
        DATEDIFF(DAY, CAST(GETDATE() AS date), U.DAT_EXPIRY) AS DaysToExpiry,
        U.NUM_VOLUME AS Volume,
        CASE
            WHEN U.DAT_EXPIRY < CAST(GETDATE() AS date) THEN 'Expired'
            WHEN U.DAT_EXPIRY <= DATEADD(DAY, 3, CAST(GETDATE() AS date)) THEN 'Critical'
            WHEN U.DAT_EXPIRY <= DATEADD(DAY, 7, CAST(GETDATE() AS date)) THEN 'High risk'
            ELSE 'Expiring soon'
        END AS ExpiryRisk
    FROM dbo.UNIT U
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = U.ID_COMPONENT
    LEFT JOIN dbo.COMPONENTTYPE CT ON CT.ID_COMPONENTTYPE = C.ID_COMPONENTTYPE
    WHERE U.DAT_EXPIRY <= DATEADD(DAY, @ExpiryDays, CAST(GETDATE() AS date))
      AND NOT EXISTS (SELECT 1 FROM dbo.TRANSFUSION T WHERE T.ID_UNIT = U.ID_UNIT AND T.DAT_RETURN IS NULL)
      AND NOT EXISTS (SELECT 1 FROM dbo.DELIVERYDETAIL DD WHERE DD.ID_UNIT = U.ID_UNIT AND DD.DAT_RETURN IS NULL)
      AND NOT EXISTS (SELECT 1 FROM dbo.DESTROYBOXUNIT DBU WHERE DBU.ID_UNIT = U.ID_UNIT)
    ORDER BY U.DAT_EXPIRY, ComponentType, BloodGroup;
  `);
  return result.recordset;
}

// ── 15b. Expiry-risk for one calendar month ─────────────────────────
// Backs the Expiry Calendar's month-grid view. Same exclusions as
// expiryRisk() above (still-open transfusion / still-open external delivery
// / already destroyed), but scoped to [monthStart, nextMonthStart) instead of
// a forward-looking "next N days" horizon — so browsing to any month, past or
// future, only ever pulls that month's rows instead of the whole backlog
// (which at a real hospital's volume can be tens of thousands of units).
async function expiryRiskForMonth(pool, year, month) {
  const request = pool.request();
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd   = new Date(Date.UTC(year, month, 1));
  request.input("MonthStart", sql.Date, monthStart);
  request.input("MonthEnd", sql.Date, monthEnd);
  const result = await request.query(`
    SELECT
        U.ID_UNIT,
        U.COD_UNIT AS UnitNumber,
        U.COD_DIVISION AS Division,
        CT.DES_COMPONENTTYPE AS ComponentType,
        C.DES_COMPONENT AS Component,
        CONCAT(LTRIM(RTRIM(COALESCE(U.COD_GROUP, ''))), LTRIM(RTRIM(COALESCE(U.COD_RH, '')))) AS BloodGroup,
        U.DAT_EXPIRY AS ExpiryDate,
        DATEDIFF(DAY, CAST(GETDATE() AS date), U.DAT_EXPIRY) AS DaysToExpiry,
        U.NUM_VOLUME AS Volume,
        CASE
            WHEN U.DAT_EXPIRY < CAST(GETDATE() AS date) THEN 'Expired'
            WHEN U.DAT_EXPIRY <= DATEADD(DAY, 3, CAST(GETDATE() AS date)) THEN 'Critical'
            WHEN U.DAT_EXPIRY <= DATEADD(DAY, 7, CAST(GETDATE() AS date)) THEN 'High risk'
            ELSE 'Expiring soon'
        END AS ExpiryRisk
    FROM dbo.UNIT U
    LEFT JOIN dbo.COMPONENT C ON C.ID_COMPONENT = U.ID_COMPONENT
    LEFT JOIN dbo.COMPONENTTYPE CT ON CT.ID_COMPONENTTYPE = C.ID_COMPONENTTYPE
    WHERE U.DAT_EXPIRY >= @MonthStart AND U.DAT_EXPIRY < @MonthEnd
      AND NOT EXISTS (SELECT 1 FROM dbo.TRANSFUSION T WHERE T.ID_UNIT = U.ID_UNIT AND T.DAT_RETURN IS NULL)
      AND NOT EXISTS (SELECT 1 FROM dbo.DELIVERYDETAIL DD WHERE DD.ID_UNIT = U.ID_UNIT AND DD.DAT_RETURN IS NULL)
      AND NOT EXISTS (SELECT 1 FROM dbo.DESTROYBOXUNIT DBU WHERE DBU.ID_UNIT = U.ID_UNIT)
    ORDER BY U.DAT_EXPIRY, ComponentType, BloodGroup;
  `);
  return result.recordset;
}

// ── 16. Demand heatmap by weekday and hour ──────────────────────────
async function demandHeatmap(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    SELECT
        DATENAME(WEEKDAY, COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM)) AS WeekdayName,
        DATEPART(WEEKDAY, COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM)) AS WeekdayNumber,
        DATEPART(HOUR, COALESCE(O.TIM_REQUEST, O.TIM_ORDERFORM)) AS RequestHour,
        COUNT(*) AS RequestCount,
        SUM(COALESCE(O.NUM_QUANTITY, 0)) AS UnitsRequested,
        SUM(CASE WHEN O.LOG_EMERGENCY = N'1' THEN 1 ELSE 0 END) AS EmergencyRequests
    FROM dbo.ORDERFORM O
    WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
      AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
      
    GROUP BY
        DATENAME(WEEKDAY, COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM)),
        DATEPART(WEEKDAY, COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM)),
        DATEPART(HOUR, COALESCE(O.TIM_REQUEST, O.TIM_ORDERFORM))
    ORDER BY WeekdayNumber, RequestHour;
  `);
  return result.recordset;
}

// ── 17. Intelligent anomaly-detection dataset ───────────────────────
async function anomalyDetection(pool, dateFrom, dateTo) {
  const request = pool.request();
  dateInput(request, "DateFrom", dateFrom);
  dateInput(request, "DateTo", dateTo);
  const result = await request.query(`
    WITH DailyDemand AS (
      SELECT COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) AS DemandDate,
             SUM(COALESCE(O.NUM_QUANTITY, 0)) AS UnitsRequested
      FROM dbo.ORDERFORM O
      WHERE COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) >= @DateFrom
        AND COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) < @DateTo
      
      GROUP BY COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM)
    ),
    MovingStatistics AS (
      SELECT DemandDate, UnitsRequested,
             AVG(CAST(UnitsRequested AS decimal(18,4))) OVER (ORDER BY DemandDate ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS Previous30DayAverage,
             STDEV(CAST(UnitsRequested AS decimal(18,4))) OVER (ORDER BY DemandDate ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS Previous30DayStdDev
      FROM DailyDemand
    )
    SELECT
        DemandDate, UnitsRequested, Previous30DayAverage, Previous30DayStdDev,
        CASE WHEN Previous30DayStdDev IS NULL OR Previous30DayStdDev = 0 THEN NULL
             ELSE (UnitsRequested - Previous30DayAverage) / Previous30DayStdDev END AS DemandZScore,
        CASE WHEN UnitsRequested > Previous30DayAverage + (2 * Previous30DayStdDev) THEN 'Unusually high demand'
             WHEN UnitsRequested < Previous30DayAverage - (2 * Previous30DayStdDev) THEN 'Unusually low demand'
             ELSE 'Normal' END AS DemandStatus
    FROM MovingStatistics
    ORDER BY DemandDate;
  `);
  return result.recordset;
}

module.exports = {
  kpiSummary,
  monthlyTrend,
  donationTypes,
  donorRetention,
  donorRecall,
  fulfilmentRate,
  turnaroundTime,
  returnRate,
  expiryRisk,
  expiryRiskForMonth,
  demandHeatmap,
  anomalyDetection,
};
