/* ════════════════════════════════════════════════════════════════════
   eDelphyn_test — v5: match how the REAL e-Delphyn stores shipments
   ────────────────────────────────────────────────────────────────────
   Verified at the hospital (hospital_sent_check.sql, 2026-11):
     REQUEST.ID_REQUESTORIG → the hospital that received the blood
                              (AAZOUNIEH, ABLAHH, CMC, …)
     REQUEST.ID_REQUESTDEST → our own blood bank, same for every row
                              ("ANTELIAS" at the hospital)
   The original test data had these the other way round, which hid the
   bug. This script moves the hospital names to REQUESTORIG and points
   every request's destination at a single "own blood bank" row.

   Run once on eDelphyn_test (safe to re-run). NEVER run on the real DB.
   ════════════════════════════════════════════════════════════════════ */
IF DB_NAME() <> 'eDelphyn_test'
BEGIN
  RAISERROR('This script is for eDelphyn_test only.', 16, 1);
  SET NOEXEC ON;
END
GO

SET NOCOUNT ON;

-- 1. Receiving hospitals become request ORIGINS
INSERT INTO dbo.REQUESTORIG (DES_REQUESTORIG)
SELECT d.DES_REQUESTDEST
FROM dbo.REQUESTDEST d
WHERE d.DES_REQUESTDEST <> 'MAIN BLOOD BANK'
  AND NOT EXISTS (SELECT 1 FROM dbo.REQUESTORIG o WHERE o.DES_REQUESTORIG = d.DES_REQUESTDEST);

-- 2. Our own blood bank as the single request DESTINATION
IF NOT EXISTS (SELECT 1 FROM dbo.REQUESTDEST WHERE DES_REQUESTDEST = 'MAIN BLOOD BANK')
  INSERT INTO dbo.REQUESTDEST (DES_REQUESTDEST) VALUES ('MAIN BLOOD BANK');

DECLARE @ownBank int = (SELECT ID_REQUESTDEST FROM dbo.REQUESTDEST WHERE DES_REQUESTDEST = 'MAIN BLOOD BANK');

-- 3. Re-point existing requests: origin = hospital they were sent to,
--    destination = our blood bank
UPDATE r
SET r.ID_REQUESTORIG = o.ID_REQUESTORIG,
    r.ID_REQUESTDEST = @ownBank
FROM dbo.REQUEST r
JOIN dbo.REQUESTDEST d ON d.ID_REQUESTDEST = r.ID_REQUESTDEST
JOIN dbo.REQUESTORIG o ON o.DES_REQUESTORIG = d.DES_REQUESTDEST
WHERE r.ID_REQUESTDEST <> @ownBank;

SELECT o.DES_REQUESTORIG AS hospital, d.DES_REQUESTDEST AS dest, COUNT(*) AS requests
FROM dbo.REQUEST r
LEFT JOIN dbo.REQUESTORIG o ON o.ID_REQUESTORIG = r.ID_REQUESTORIG
LEFT JOIN dbo.REQUESTDEST d ON d.ID_REQUESTDEST = r.ID_REQUESTDEST
GROUP BY o.DES_REQUESTORIG, d.DES_REQUESTDEST
ORDER BY requests DESC;
GO
SET NOEXEC OFF;
GO
