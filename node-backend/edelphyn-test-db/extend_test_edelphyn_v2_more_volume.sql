/*
  Second volume pass for eDelphyn_test, on top of
  extend_test_edelphyn_analytics.sql. Addresses what was visibly thin
  when actually looking at the Analytics tab:
    - Donations line was flat near zero (only 90 donations existed)
    - Donations-by-type chart lost whole types in a 30-day window
    - Wasted-units line was invisible (only 50 destroyed units, all
      dated within the last ~60 days)
    - Units Issued never tracked Units Requested, because every order
      got exactly ONE transfusion row no matter its NUM_QUANTITY

  This adds:
    1. 150 more PERSON rows (bigger donor pool)
    2. 500 more DONATION rows, evenly rotated across all 4 donation
       types, spread across the same ~420-day window
    3. 250 more UNIT + DESTROYBOXUNIT/DESTROYBOX rows, spread across
       the full ~420-day window (not just near "today")
    4. Top-up TRANSFUSION rows for existing multi-unit orders so
       "fully fulfilled" orders actually have IssuedUnits == NUM_QUANTITY,
       and "partially fulfilled" ones land partway there -- instead of
       every matched order capping out at 1 issued unit

  Safe to re-run: each block is guarded and skips if already applied.

  HOW TO RUN
    sqlcmd -S ELSAMRA-103080 -E -C -d eDelphyn_test -i extend_test_edelphyn_v2_more_volume.sql
*/

USE eDelphyn_test;
GO

-- ════════════════════════════════════════════════════════════════
-- 1. MORE DONORS — 150 more people (donor pool: 50 -> 200)
-- ════════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM dbo.PERSON WHERE DES_SURNAME LIKE 'FamilyEx%')
BEGIN
    ;WITH Numbers AS (
        SELECT TOP (150) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT INTO dbo.PERSON (DES_NAME, DES_MIDDLENAME, DES_SURNAME, ID_NATIONALITY, ID_TOWN, ID_STATE, COD_GROUP, COD_RH, COD_GENDER, DAT_BIRTH, COD_IAT)
    SELECT
        'Person' + CAST(n + 50 AS VARCHAR(10)),
        NULL,
        'FamilyEx' + CAST((n % 13) AS VARCHAR(10)),
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        (ABS(CHECKSUM(NEWID())) % 7) + 1,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        CASE (ABS(CHECKSUM(NEWID())) % 4) WHEN 0 THEN 'A' WHEN 1 THEN 'B' WHEN 2 THEN 'AB' ELSE 'O' END,
        CASE (ABS(CHECKSUM(NEWID())) % 5) WHEN 0 THEN '-' ELSE '+' END,
        CASE (ABS(CHECKSUM(NEWID())) % 2) WHEN 0 THEN 'M' ELSE 'F' END,
        DATEADD(YEAR, -(18 + ABS(CHECKSUM(NEWID())) % 50), CAST(GETDATE() AS DATE)),
        CASE (ABS(CHECKSUM(NEWID())) % 20) WHEN 0 THEN 'Positive' ELSE 'Negative' END
    FROM Numbers;

    PRINT 'Inserted 150 more donors (FamilyEx%).';
END
ELSE PRINT 'Extra donors (FamilyEx%) already present -- skipped.';
GO

-- ════════════════════════════════════════════════════════════════
-- 2. MORE DONATIONS — 500 more, evenly rotated across all 4 donation
-- types so a 30-day window reliably shows every type.
-- ════════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM dbo.DONATION WHERE COD_DONATION LIKE 'DNX%')
BEGIN
    ;WITH Numbers AS (
        SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT INTO dbo.DONATION (COD_DONATION, DAT_DONATION, TIM_START, TIM_DONATION, ID_DONATIONTYPE, ID_PERSON, ID_BAGTYPE, ID_BAGORIGIN, LOG_ENTRY, DAT_EXTERNALENTRY, TIM_EXTERNALENTRY, DES_BAGSERIAL, ID_CELLSEPARATOR, NUM_VOLUME, NUM_PHLEBTIME)
    SELECT
        'DNX' + RIGHT('00000' + CAST(n AS VARCHAR(10)), 5),
        d, CAST(t AS TIME), CAST(t AS TIME),
        ((n - 1) % 4) + 1,                              -- round-robin across all 4 types
        (ABS(CHECKSUM(NEWID())) % 200) + 1,              -- draw from the full 200-person pool
        (ABS(CHECKSUM(NEWID())) % 4) + 1,
        NULL,
        is_ext,
        CASE WHEN is_ext = 1 THEN d ELSE NULL END,
        CASE WHEN is_ext = 1 THEN CAST(t AS TIME) ELSE NULL END,
        'BAGX' + CAST(200000 + n AS VARCHAR(10)),
        (ABS(CHECKSUM(NEWID())) % 3) + 1,
        350 + ABS(CHECKSUM(NEWID())) % 150,
        5 + ABS(CHECKSUM(NEWID())) % 11
    FROM (
        SELECT n,
            DATEADD(DAY, -ABS(CHECKSUM(NEWID())) % 420, CAST(GETDATE() AS DATE)) AS d,
            DATEADD(MINUTE, ABS(CHECKSUM(NEWID())) % 1440, '00:00') AS t,
            CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 15 THEN 1 ELSE 0 END AS is_ext
        FROM Numbers
    ) x;

    PRINT 'Inserted 500 more donations (DNX%), even across all 4 types.';
END
ELSE PRINT 'Extra donations (DNX%) already present -- skipped.';
GO

-- ════════════════════════════════════════════════════════════════
-- 3. MORE WASTAGE — 250 more units dedicated to destruction, spread
-- across the full ~420-day window (not clustered near "today").
-- ════════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM dbo.UNIT WHERE COD_UNIT LIKE 'WU%')
BEGIN
    ;WITH Numbers AS (
        SELECT TOP (250) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT INTO dbo.UNIT (COD_UNIT, COD_DIVISION, COD_GROUP, COD_RH, ID_COMPONENT, COD_CMV, COD_REJECTREASON, DAT_EXPIRY, NUM_VOLUME)
    SELECT
        'WU' + RIGHT('000000' + CAST(n AS VARCHAR(10)), 6),
        '',
        CASE (ABS(CHECKSUM(NEWID())) % 4) WHEN 0 THEN 'A' WHEN 1 THEN 'B' WHEN 2 THEN 'AB' ELSE 'O' END,
        CASE (ABS(CHECKSUM(NEWID())) % 5) WHEN 0 THEN '-' ELSE '+' END,
        (ABS(CHECKSUM(NEWID())) % 5) + 1,
        CASE (ABS(CHECKSUM(NEWID())) % 4) WHEN 0 THEN 'Negative' ELSE 'Positive' END,
        CASE (ABS(CHECKSUM(NEWID())) % 5)
            WHEN 0 THEN 'Expired' WHEN 1 THEN 'Hemolysis' WHEN 2 THEN 'Broken Bag'
            WHEN 3 THEN 'Positive Serology' ELSE 'Clotted' END,
        DATEADD(DAY, -ABS(CHECKSUM(NEWID())) % 420, CAST(GETDATE() AS DATE)),
        250 + ABS(CHECKSUM(NEWID())) % 220
    FROM Numbers;

    ;WITH Numbers AS (
        SELECT TOP (250) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT INTO dbo.DESTROYBOX (COD_DESTROYBOX, DAT_DESTROYBOX, TIM_DESTROYBOX)
    SELECT 'DBX' + RIGHT('00000' + CAST(n AS VARCHAR(10)), 5),
        DATEADD(DAY, -ABS(CHECKSUM(NEWID())) % 420, CAST(GETDATE() AS DATE)),
        DATEADD(MINUTE, ABS(CHECKSUM(NEWID())) % 1440, '00:00')
    FROM Numbers;

    ;WITH NewBoxes AS (
        SELECT ID_DESTROYBOX, DAT_DESTROYBOX, TIM_DESTROYBOX,
               ROW_NUMBER() OVER (ORDER BY ID_DESTROYBOX) AS rn
        FROM dbo.DESTROYBOX WHERE COD_DESTROYBOX LIKE 'DBX%'
    ),
    NewUnits AS (
        SELECT ID_UNIT, ROW_NUMBER() OVER (ORDER BY ID_UNIT) AS rn
        FROM dbo.UNIT WHERE COD_UNIT LIKE 'WU%'
    )
    INSERT INTO dbo.DESTROYBOXUNIT (ID_DESTROYBOX, ID_UNIT, DAT_DESTROYBOXUNIT, TIM_DESTROYBOXUNIT)
    SELECT b.ID_DESTROYBOX, u.ID_UNIT, b.DAT_DESTROYBOX, b.TIM_DESTROYBOX
    FROM NewBoxes b
    INNER JOIN NewUnits u ON u.rn = b.rn;

    PRINT 'Inserted 250 more wasted units (WU% / DBX%), spread across the full window.';
END
ELSE PRINT 'Extra wastage (WU%) already present -- skipped.';
GO

-- ════════════════════════════════════════════════════════════════
-- 4. TOP UP TRANSFUSIONS — bring IssuedUnits closer to NUM_QUANTITY
-- for orders that already got one matching transfusion: 60% become
-- fully fulfilled (issued == requested), the rest partially fulfilled
-- (issued somewhere between 1 and requested-1). Orders with no
-- matching transfusion stay "not fulfilled" untouched.
-- ════════════════════════════════════════════════════════════════
;WITH BaseFulfilled AS (
    SELECT O.ID_ORDERFORM, O.ID_PERSON, O.DAT_REQUEST, O.TIM_REQUEST, O.ID_DESTINATION, O.ID_WARD, O.NUM_QUANTITY
    FROM dbo.ORDERFORM O
    WHERE O.NUM_QUANTITY > 1
      AND (SELECT COUNT(*) FROM dbo.TRANSFUSION T2 WHERE T2.ID_ORDERFORM = O.ID_ORDERFORM) = 1
),
Target AS (
    SELECT *,
        CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 60
             THEN NUM_QUANTITY                                          -- fully fulfilled
             ELSE 1 + ABS(CHECKSUM(NEWID())) % (NUM_QUANTITY - 1)       -- partially fulfilled
        END AS TargetIssued
    FROM BaseFulfilled
),
Numbers3 AS (
    SELECT TOP (3) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects
)
INSERT INTO dbo.TRANSFUSION (DAT_TRANSFUSION, TIM_TRANSFUSION, ID_ORDERFORM, ID_PERSON, ID_UNIT, DES_TAKENBY, ID_DESTINATION, ID_WARD, DAT_RETURN, COD_RETURN)
SELECT
    Tg.DAT_REQUEST,
    CAST(DATEADD(MINUTE, 5 * N.n, CAST(Tg.TIM_REQUEST AS DATETIME)) AS TIME),
    Tg.ID_ORDERFORM, Tg.ID_PERSON,
    (ABS(CHECKSUM(NEWID())) % 60) + 1,
    'Nurse ' + CAST((ABS(CHECKSUM(NEWID())) % 12) + 1 AS VARCHAR(10)),
    Tg.ID_DESTINATION, Tg.ID_WARD,
    NULL, '0'
FROM Target Tg
CROSS JOIN Numbers3 N
WHERE N.n <= (Tg.TargetIssued - 1);
GO

PRINT 'eDelphyn_test volume pass 2 -- done.';
GO
