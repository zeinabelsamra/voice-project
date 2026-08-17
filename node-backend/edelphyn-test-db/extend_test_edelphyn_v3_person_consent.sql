/*
  Third pass for eDelphyn_test, on top of extend_test_edelphyn_analytics.sql
  and extend_test_edelphyn_v2_more_volume.sql.

  Adds the PERSON columns the real hospital schema (schema.sql) has but this
  synthetic test DB was never given -- specifically the ones the Donor
  Inactivity & Recall table needs: SMS/email contact consent, "known bad
  contact info" flags, and a donor-level donation-frequency value. Column
  names/types match schema.sql's real PERSON table exactly so queries
  written against this test DB will also run unmodified against the real
  hospital database.

  NOTE on LOG_BYSMS/LOG_BYEMAIL vs LOG_INFORMSMS/LOG_INFORMEMAIL: the real
  schema has both pairs and neither is documented anywhere in this repo.
  donorRecall() treats LOG_BYSMS/LOG_BYEMAIL as the consent-to-contact
  flags (the naming reads most directly as "contact this donor BY SMS/
  email"); LOG_INFORMSMS/LOG_INFORMEMAIL are added here too, for schema
  parity, but currently unused by the query. Swap which pair drives the UI
  if the hospital's e-Delphyn documentation says otherwise.

  NOTE on NUM_FREQUENCY: inferred to be the donor's recommended interval
  between donations, in days (real-world whole-blood donation intervals are
  commonly ~56-365 days) -- not confirmed against hospital documentation.

  Safe to re-run: every block is guarded and skips if already applied.

  HOW TO RUN
    sqlcmd -S ELSAMRA-103080 -E -C -d eDelphyn_test -i extend_test_edelphyn_v3_person_consent.sql
*/

USE eDelphyn_test;
GO

-- ════════════════════════════════════════════════════════════════
-- 1. ADD COLUMNS
-- ════════════════════════════════════════════════════════════════
IF COL_LENGTH('dbo.PERSON', 'LOG_BYSMS') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_BYSMS BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_BYEMAIL') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_BYEMAIL BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_INFORMSMS') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_INFORMSMS BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_INFORMEMAIL') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_INFORMEMAIL BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_WRONGPHONE') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_WRONGPHONE BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_WRONGMOBILE') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_WRONGMOBILE BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'LOG_WRONGEMAIL') IS NULL
    ALTER TABLE dbo.PERSON ADD LOG_WRONGEMAIL BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dbo.PERSON', 'NUM_FREQUENCY') IS NULL
    ALTER TABLE dbo.PERSON ADD NUM_FREQUENCY INT NULL;
GO

-- ════════════════════════════════════════════════════════════════
-- 2. BACKFILL existing rows with plausible values
-- ════════════════════════════════════════════════════════════════

-- Consent: most donors who left contact info consented to be reached that
-- way (~80% SMS, ~65% email -- SMS is the more commonly accepted channel
-- for this kind of recall in practice). Mirror LOG_BY* onto LOG_INFORM* so
-- the two pairs agree in this synthetic data (real data may not).
UPDATE dbo.PERSON
SET LOG_BYSMS        = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 80 THEN 1 ELSE 0 END,
    LOG_BYEMAIL       = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 65 THEN 1 ELSE 0 END
WHERE COD_DONOR IS NOT NULL; -- only donors backfilled by the analytics pass have contact info at all
GO
UPDATE dbo.PERSON
SET LOG_INFORMSMS   = LOG_BYSMS,
    LOG_INFORMEMAIL = LOG_BYEMAIL
WHERE COD_DONOR IS NOT NULL;
GO

-- "Known bad" contact flags: small minority, so most donors still read as
-- contactable even when the wrong-flag columns are checked.
UPDATE dbo.PERSON
SET LOG_WRONGPHONE  = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 6 THEN 1 ELSE 0 END,
    LOG_WRONGMOBILE = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 6 THEN 1 ELSE 0 END,
    LOG_WRONGEMAIL  = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 8 THEN 1 ELSE 0 END
WHERE COD_DONOR IS NOT NULL;
GO

-- Recommended donation interval: 56 days (minimum whole-blood interval in
-- many countries) up to 365 (once-a-year donors). ~15% left NULL (never set).
UPDATE dbo.PERSON
SET NUM_FREQUENCY = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 15 THEN NULL
                          ELSE 56 + ABS(CHECKSUM(NEWID())) % 310 END
WHERE COD_DONOR IS NOT NULL AND NUM_FREQUENCY IS NULL;
GO

PRINT 'PERSON consent/frequency columns added and backfilled.';
