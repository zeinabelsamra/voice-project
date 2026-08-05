/*
  Extends the synthetic eDelphyn_test database (created by
  setup_test_edelphyn.sql) with the columns and extra volume the new
  /api/analytics/* queries (edelphynAnalyticsQueries.js) need:
    - ORDERFORM.DAT_REQUEST / TIM_REQUEST / NUM_QUANTITY / LOG_EMERGENCY
    - DONATION.NUM_VOLUME / NUM_PHLEBTIME
    - DONATIONTYPE.SRT_DONATIONTYPE
    - PERSON.COD_DONOR / DES_MOBILEPHONE / DES_EMAIL / LOG_DONOR /
      DAT_DEFERRED / DAT_INACTIVATION / COD_ACCEPTED
    - UNIT.NUM_VOLUME

  It also correlates transfusion timing to its order form (so turnaround
  times are always positive) and adds ~500 extra order/transfusion pairs
  weighted toward weekday business hours (for a readable demand heatmap)
  plus 3 explicit demand spikes (for the anomaly-detection chart).

  Safe to re-run: column adds are guarded, extra-data inserts are
  skipped if already present.

  HOW TO RUN
    sqlcmd -S ELSAMRA-103080 -E -C -d eDelphyn_test -i extend_test_edelphyn_analytics.sql
  (or open in SSMS / Azure Data Studio against eDelphyn_test and execute)
*/

USE eDelphyn_test;
GO

-- ════════════════════════════════════════════════════════════════
-- 1. SCHEMA — add missing columns (idempotent)
-- ════════════════════════════════════════════════════════════════
IF COL_LENGTH('dbo.ORDERFORM', 'DAT_REQUEST') IS NULL
    ALTER TABLE dbo.ORDERFORM ADD DAT_REQUEST DATE NULL;
IF COL_LENGTH('dbo.ORDERFORM', 'TIM_REQUEST') IS NULL
    ALTER TABLE dbo.ORDERFORM ADD TIM_REQUEST TIME NULL;
IF COL_LENGTH('dbo.ORDERFORM', 'NUM_QUANTITY') IS NULL
    ALTER TABLE dbo.ORDERFORM ADD NUM_QUANTITY INT NULL;
IF COL_LENGTH('dbo.ORDERFORM', 'LOG_EMERGENCY') IS NULL
    ALTER TABLE dbo.ORDERFORM ADD LOG_EMERGENCY BIT NOT NULL DEFAULT 0;
GO

IF COL_LENGTH('dbo.DONATION', 'NUM_VOLUME') IS NULL
    ALTER TABLE dbo.DONATION ADD NUM_VOLUME DECIMAL(6,1) NULL;
IF COL_LENGTH('dbo.DONATION', 'NUM_PHLEBTIME') IS NULL
    ALTER TABLE dbo.DONATION ADD NUM_PHLEBTIME DECIMAL(6,1) NULL;
GO

IF COL_LENGTH('dbo.DONATIONTYPE', 'SRT_DONATIONTYPE') IS NULL
    ALTER TABLE dbo.DONATIONTYPE ADD SRT_DONATIONTYPE VARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.PERSON', 'COD_DONOR') IS NULL
    ALTER TABLE dbo.PERSON ADD COD_DONOR VARCHAR(20) NULL;
IF COL_LENGTH('dbo.PERSON', 'DES_MOBILEPHONE') IS NULL
    ALTER TABLE dbo.PERSON ADD DES_MOBILEPHONE VARCHAR(30) NULL;
IF COL_LENGTH('dbo.PERSON', 'DES_EMAIL') IS NULL
    ALTER TABLE dbo.PERSON ADD DES_EMAIL VARCHAR(120) NULL;
IF COL_LENGTH('dbo.PERSON', 'LOG_DONOR') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_DONOR BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'DAT_DEFERRED') IS NULL
    ALTER TABLE dbo.PERSON ADD DAT_DEFERRED DATE NULL;
IF COL_LENGTH('dbo.PERSON', 'DAT_INACTIVATION') IS NULL
    ALTER TABLE dbo.PERSON ADD DAT_INACTIVATION DATE NULL;
IF COL_LENGTH('dbo.PERSON', 'COD_ACCEPTED') IS NULL
    ALTER TABLE dbo.PERSON ADD COD_ACCEPTED VARCHAR(5) NULL;
GO

IF COL_LENGTH('dbo.UNIT', 'NUM_VOLUME') IS NULL
    ALTER TABLE dbo.UNIT ADD NUM_VOLUME DECIMAL(6,1) NULL;
GO

-- ════════════════════════════════════════════════════════════════
-- 2. BACKFILL existing rows
-- ════════════════════════════════════════════════════════════════

-- ORDERFORM: request = order event itself; ~2-4 units; ~18% emergency
UPDATE dbo.ORDERFORM
SET DAT_REQUEST   = DAT_ORDERFORM,
    TIM_REQUEST   = TIM_ORDERFORM,
    NUM_QUANTITY  = 1 + ABS(CHECKSUM(NEWID())) % 4,
    LOG_EMERGENCY = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 18 THEN 1 ELSE 0 END
WHERE DAT_REQUEST IS NULL;
GO

-- TRANSFUSION: re-anchor issue time to its order's request time + a
-- 15-240 minute delay, so turnaround is always positive and realistic.
UPDATE T
SET
    T.DAT_TRANSFUSION = CASE WHEN x.mins_from_midnight + x.delay >= 1440
                              THEN DATEADD(DAY, 1, O.DAT_REQUEST) ELSE O.DAT_REQUEST END,
    T.TIM_TRANSFUSION = CAST(DATEADD(MINUTE, x.delay, CAST(O.TIM_REQUEST AS DATETIME)) AS TIME)
FROM dbo.TRANSFUSION T
INNER JOIN dbo.ORDERFORM O ON O.ID_ORDERFORM = T.ID_ORDERFORM
CROSS APPLY (
    SELECT DATEDIFF(MINUTE, CAST('00:00' AS TIME), O.TIM_REQUEST) AS mins_from_midnight,
           15 + ABS(CHECKSUM(NEWID())) % 225 AS delay
) x
WHERE O.DAT_REQUEST IS NOT NULL AND O.TIM_REQUEST IS NOT NULL;
GO

-- DONATION: realistic volume (350-500ml) and phlebotomy time (5-15 min)
UPDATE dbo.DONATION
SET NUM_VOLUME    = 350 + ABS(CHECKSUM(NEWID())) % 150,
    NUM_PHLEBTIME = 5 + ABS(CHECKSUM(NEWID())) % 11
WHERE NUM_VOLUME IS NULL;
GO

-- DONATIONTYPE: short codes
UPDATE dbo.DONATIONTYPE
SET SRT_DONATIONTYPE = CASE DES_DONATIONTYPE
    WHEN 'Whole Blood'         THEN 'WHO'
    WHEN 'Apheresis Platelets' THEN 'APH'
    WHEN 'Apheresis Plasma'    THEN 'APL'
    WHEN 'Double Red Cells'    THEN 'DRC'
    ELSE UPPER(LEFT(DES_DONATIONTYPE, 3)) END
WHERE SRT_DONATIONTYPE IS NULL;
GO

-- PERSON: donor contact/status fields; LOG_DONOR=1 for anyone who has
-- actually donated (so the recall query has candidates)
UPDATE dbo.PERSON
SET COD_DONOR       = 'DNR' + RIGHT('00000' + CAST(ID_PERSON AS VARCHAR(10)), 5),
    DES_MOBILEPHONE = '+9613' + RIGHT('000000' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS VARCHAR(10)), 6),
    DES_EMAIL       = LOWER(DES_NAME) + '.' + LOWER(DES_SURNAME) + CAST(ID_PERSON AS VARCHAR(10)) + '@example.com',
    COD_ACCEPTED    = CASE WHEN ABS(CHECKSUM(NEWID())) % 10 = 0 THEN 'N' ELSE 'Y' END
WHERE COD_DONOR IS NULL;
GO

UPDATE P
SET LOG_DONOR = 1
FROM dbo.PERSON P
WHERE EXISTS (SELECT 1 FROM dbo.DONATION D WHERE D.ID_PERSON = P.ID_PERSON)
  AND P.LOG_DONOR = 0;
GO

-- UNIT: realistic bag volume
UPDATE dbo.UNIT
SET NUM_VOLUME = 250 + ABS(CHECKSUM(NEWID())) % 220
WHERE NUM_VOLUME IS NULL;
GO

-- ════════════════════════════════════════════════════════════════
-- 3. EXTRA DEMAND DATA — ~500 more order/transfusion pairs spread over
-- the last 365 days, weighted toward weekday business hours, so the
-- monthly trend, demand heatmap, fulfilment, and turnaround charts
-- have enough volume to be readable (skipped if already inserted).
-- ════════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM dbo.ORDERFORM WHERE COD_ORDERFORM LIKE 'OFX%')
BEGIN
    DECLARE @ExtraCount INT = 500;

    ;WITH Numbers AS (
        SELECT TOP (@ExtraCount) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT INTO dbo.ORDERFORM
        (DAT_ORDERFORM, TIM_ORDERFORM, DAT_REQUEST, TIM_REQUEST, COD_ORDERFORM,
         ID_PERSON, ID_DEPARTMENT, ID_WARD, ID_COMPONENTTYPE, ID_COMPONENT,
         ID_ORDERTYPE, ID_ORIGIN, LOG_CANCELLED, LOG_EMERGENCY, ID_DESTINATION,
         ID_CENTRE, ID_CUSTOMER, ID_PRIORITY, NUM_QUANTITY)
    SELECT
        d, t, d, t,
        'OFX' + RIGHT('00000' + CAST(n AS VARCHAR(10)), 5),
        (ABS(CHECKSUM(NEWID())) % 50) + 1,
        (ABS(CHECKSUM(NEWID())) % 6) + 1,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 6 THEN 1 ELSE 0 END,  -- ~6% cancelled
        is_emerg,
        (ABS(CHECKSUM(NEWID())) % 6) + 1,
        1,
        (ABS(CHECKSUM(NEWID())) % 2) + 1,
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        1 + ABS(CHECKSUM(NEWID())) % 4
    FROM (
        SELECT n,
            DATEADD(DAY, -ABS(CHECKSUM(NEWID())) % 365, CAST(GETDATE() AS DATE)) AS d,
            -- 80% land in the 08:00-18:00 business window, 20% any hour
            CAST(DATEADD(MINUTE,
                CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 80
                     THEN 480 + ABS(CHECKSUM(NEWID())) % 600
                     ELSE ABS(CHECKSUM(NEWID())) % 1440 END,
                '00:00') AS TIME) AS t,
            CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 15 THEN 1 ELSE 0 END AS is_emerg
        FROM Numbers
    ) x;

    -- Matching transfusions for ~85% of the new orders (rest stay
    -- unfulfilled/partially so the fulfilment chart has all 3 buckets)
    INSERT INTO dbo.TRANSFUSION
        (DAT_TRANSFUSION, TIM_TRANSFUSION, ID_ORDERFORM, ID_PERSON, ID_UNIT,
         DES_TAKENBY, ID_DESTINATION, ID_WARD, DAT_RETURN, COD_RETURN)
    SELECT
        CASE WHEN x.mins_from_midnight + x.delay >= 1440 THEN DATEADD(DAY, 1, O.DAT_REQUEST) ELSE O.DAT_REQUEST END,
        CAST(DATEADD(MINUTE, x.delay, CAST(O.TIM_REQUEST AS DATETIME)) AS TIME),
        O.ID_ORDERFORM,
        O.ID_PERSON,
        (ABS(CHECKSUM(NEWID())) % 60) + 1,
        'Nurse ' + CAST((ABS(CHECKSUM(NEWID())) % 12) + 1 AS VARCHAR(10)),
        O.ID_DESTINATION,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        CASE WHEN x.returned = 1 THEN DATEADD(DAY, 1, O.DAT_REQUEST) ELSE NULL END,
        CASE WHEN x.returned = 1 THEN '1' ELSE '0' END
    FROM dbo.ORDERFORM O
    CROSS APPLY (
        SELECT
            DATEDIFF(MINUTE, CAST('00:00' AS TIME), O.TIM_REQUEST) AS mins_from_midnight,
            15 + ABS(CHECKSUM(NEWID())) % 225 AS delay,
            CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 12 THEN 1 ELSE 0 END AS returned,
            ABS(CHECKSUM(NEWID())) % 100 AS pick
    ) x
    WHERE O.COD_ORDERFORM LIKE 'OFX%'
      AND O.LOG_CANCELLED = 0
      AND x.pick < 85;

    PRINT 'Inserted 500 extra order/transfusion pairs (OFX%).';
END
ELSE PRINT 'Extra demand data (OFX%) already present -- skipped.';
GO

-- ════════════════════════════════════════════════════════════════
-- 4. DEMAND SPIKES — 3 explicit high-volume days for the
-- anomaly-detection chart to actually flag something.
-- ════════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM dbo.ORDERFORM WHERE COD_ORDERFORM LIKE 'SPK%')
BEGIN
    DECLARE @Spike1 DATE = DATEADD(DAY, -45,  CAST(GETDATE() AS DATE));
    DECLARE @Spike2 DATE = DATEADD(DAY, -90,  CAST(GETDATE() AS DATE));
    DECLARE @Spike3 DATE = DATEADD(DAY, -150, CAST(GETDATE() AS DATE));

    ;WITH Numbers AS (
        SELECT TOP (60) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects
    )
    INSERT INTO dbo.ORDERFORM
        (DAT_ORDERFORM, TIM_ORDERFORM, DAT_REQUEST, TIM_REQUEST, COD_ORDERFORM,
         ID_PERSON, ID_DEPARTMENT, ID_WARD, ID_COMPONENTTYPE, ID_COMPONENT,
         ID_ORDERTYPE, ID_ORIGIN, LOG_CANCELLED, LOG_EMERGENCY, ID_DESTINATION,
         ID_CENTRE, ID_CUSTOMER, ID_PRIORITY, NUM_QUANTITY)
    SELECT
        d, t, d, t,
        'SPK' + RIGHT('00000' + CAST(n AS VARCHAR(10)), 5),
        (ABS(CHECKSUM(NEWID())) % 50) + 1,
        (ABS(CHECKSUM(NEWID())) % 6) + 1,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        2,  -- Emergency order type
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        0, 1,
        (ABS(CHECKSUM(NEWID())) % 6) + 1,
        1,
        (ABS(CHECKSUM(NEWID())) % 2) + 1,
        3,  -- STAT priority
        2 + ABS(CHECKSUM(NEWID())) % 3
    FROM (
        SELECT n,
            CASE n % 3 WHEN 0 THEN @Spike1 WHEN 1 THEN @Spike2 ELSE @Spike3 END AS d,
            CAST(DATEADD(MINUTE, 480 + ABS(CHECKSUM(NEWID())) % 480, '00:00') AS TIME) AS t
        FROM Numbers
    ) x;

    INSERT INTO dbo.TRANSFUSION
        (DAT_TRANSFUSION, TIM_TRANSFUSION, ID_ORDERFORM, ID_PERSON, ID_UNIT,
         DES_TAKENBY, ID_DESTINATION, ID_WARD, DAT_RETURN, COD_RETURN)
    SELECT
        O.DAT_REQUEST,
        CAST(DATEADD(MINUTE, 10 + ABS(CHECKSUM(NEWID())) % 40, CAST(O.TIM_REQUEST AS DATETIME)) AS TIME),
        O.ID_ORDERFORM, O.ID_PERSON,
        (ABS(CHECKSUM(NEWID())) % 60) + 1,
        'Nurse ' + CAST((ABS(CHECKSUM(NEWID())) % 12) + 1 AS VARCHAR(10)),
        O.ID_DESTINATION,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        NULL, '0'
    FROM dbo.ORDERFORM O
    WHERE O.COD_ORDERFORM LIKE 'SPK%';

    PRINT 'Inserted 3 demand-spike days (SPK%).';
END
ELSE PRINT 'Demand spikes (SPK%) already present -- skipped.';
GO

-- ════════════════════════════════════════════════════════════════
-- 5. Re-freshen UNIT expiry dates around "today" so the expiry-risk
-- query always has something within its default 14-day window,
-- regardless of how long ago the base script was run.
-- ════════════════════════════════════════════════════════════════
UPDATE dbo.UNIT
SET DAT_EXPIRY = DATEADD(DAY, (ABS(CHECKSUM(NEWID())) % 60) - 30, CAST(GETDATE() AS DATE))
WHERE ID_UNIT <= 100;  -- leave the 101-150 "destroyed" range alone
GO

PRINT 'eDelphyn_test extended for /api/analytics — done.';
GO
