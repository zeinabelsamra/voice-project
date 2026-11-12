/* ════════════════════════════════════════════════════════════════════
   HOSPITAL CHECK — where is the real "sent to" hospital stored?
   ────────────────────────────────────────────────────────────────────
   • READ-ONLY (only SELECT). No patient data.
   • Safe on ANY e-Delphyn version: every optional table/column is
     checked first, so this script never stops with a red error.
   • Uses the same tables the app already reads successfully.

   HOW TO RUN: open in SSMS → pick the REAL e-Delphyn database in the
   dropdown → press F5 (nothing selected). You get 3 result grids.
   Photograph all 3.
   ════════════════════════════════════════════════════════════════════ */
SET NOCOUNT ON;

DECLARE @days int = 365;   -- look at deliveries from the last 365 days

/* Build the list of possible "hospital" columns that exist here */
DECLARE @cols  nvarchar(max) = N'';
DECLARE @joins nvarchar(max) = N'';
DECLARE @grp   nvarchar(max) = N'';

-- request destination (what the app uses now → shows ANTELIAS)
SET @cols  += N', rd.DES_REQUESTDEST AS [1_REQ_DEST]';
SET @joins += N' LEFT JOIN dbo.REQUESTDEST rd ON rd.ID_REQUESTDEST = r.ID_REQUESTDEST';
SET @grp   += N', rd.DES_REQUESTDEST';

-- request origin
IF COL_LENGTH('dbo.REQUEST','ID_REQUESTORIG') IS NOT NULL AND OBJECT_ID('dbo.REQUESTORIG') IS NOT NULL
BEGIN
  SET @cols  += N', ro.DES_REQUESTORIG AS [2_REQ_ORIG]';
  SET @joins += N' LEFT JOIN dbo.REQUESTORIG ro ON ro.ID_REQUESTORIG = r.ID_REQUESTORIG';
  SET @grp   += N', ro.DES_REQUESTORIG';
END

-- RDU delivery note (origin + destination)
IF COL_LENGTH('dbo.DELIVERYDETAIL','ID_RDUDELIVERYNOTE') IS NOT NULL AND OBJECT_ID('dbo.RDUDELIVERYNOTE') IS NOT NULL
BEGIN
  SET @joins += N' LEFT JOIN dbo.RDUDELIVERYNOTE rn ON rn.ID_RDUDELIVERYNOTE = dd.ID_RDUDELIVERYNOTE';
  IF COL_LENGTH('dbo.RDUDELIVERYNOTE','ID_REQUESTDEST') IS NOT NULL
  BEGIN
    SET @cols  += N', rnd.DES_REQUESTDEST AS [3_RDU_DEST]';
    SET @joins += N' LEFT JOIN dbo.REQUESTDEST rnd ON rnd.ID_REQUESTDEST = rn.ID_REQUESTDEST';
    SET @grp   += N', rnd.DES_REQUESTDEST';
  END
  IF COL_LENGTH('dbo.RDUDELIVERYNOTE','ID_REQUESTORIG') IS NOT NULL AND OBJECT_ID('dbo.REQUESTORIG') IS NOT NULL
  BEGIN
    SET @cols  += N', rno.DES_REQUESTORIG AS [4_RDU_ORIG]';
    SET @joins += N' LEFT JOIN dbo.REQUESTORIG rno ON rno.ID_REQUESTORIG = rn.ID_REQUESTORIG';
    SET @grp   += N', rno.DES_REQUESTORIG';
  END
END

-- free-text fields on the request
IF COL_LENGTH('dbo.REQUEST','DES_REQRESPONSIBLEDEST') IS NOT NULL
BEGIN
  SET @cols += N', r.DES_REQRESPONSIBLEDEST AS [5_RESPONSIBLE_DEST]';
  SET @grp  += N', r.DES_REQRESPONSIBLEDEST';
END

DECLARE @from  nvarchar(max) = N'
FROM dbo.DELIVERYDETAIL dd
JOIN dbo.REQUEST r            ON r.ID_REQUEST = dd.ID_REQUEST
LEFT JOIN dbo.DELIVERYNOTE dn ON dn.ID_DELIVERYNOTE = dd.ID_DELIVERYNOTE' + @joins + N'
WHERE COALESCE(dd.DAT_DELIVERYDETAIL, dn.DAT_DELIVERYNOTE, r.DAT_DELIVERY) >= DATEADD(day, -@days, CAST(GETDATE() AS date))';

/* ── RESULT 1: which candidate columns exist on this database ── */
SELECT 'R1_COLUMNS_FOUND' AS result, STUFF(REPLACE(@grp, ', ', CHAR(10) + ', '), 1, 2, '') AS columns_checked;

/* ── RESULT 2 ★: units per combination of all candidate columns.
      The column whose values look like AAZOUNIEH, ABLAHH, CMC,
      GHANDOUR, UNIVERSAL… is the real hospital column. ── */
DECLARE @q2 nvarchar(max) =
  N'SELECT TOP (60) ''R2_BY_HOSPITAL'' AS result' + @cols + N', COUNT(*) AS units' + @from +
  N' GROUP BY ' + STUFF(@grp, 1, 2, '') + N' ORDER BY units DESC;';
EXEC sp_executesql @q2, N'@days int', @days = @days;

/* ── RESULT 3: 25 recent sample rows (note number + unit number) so
      you can open the same note in e-Delphyn's screen and compare. ── */
DECLARE @q3 nvarchar(max) =
  N'SELECT TOP (25) ''R3_SAMPLES'' AS result,
          dn.COD_DELIVERYNOTE AS note_number,
          u.COD_UNIT          AS unit_number,
          COALESCE(dd.DAT_DELIVERYDETAIL, dn.DAT_DELIVERYNOTE, r.DAT_DELIVERY) AS sent_date' + @cols +
  REPLACE(@from, N'WHERE', N'LEFT JOIN dbo.UNIT u ON u.ID_UNIT = dd.ID_UNIT WHERE') +
  N' ORDER BY sent_date DESC;';
EXEC sp_executesql @q3, N'@days int', @days = @days;
