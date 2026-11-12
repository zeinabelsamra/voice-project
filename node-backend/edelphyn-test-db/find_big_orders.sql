/* ════════════════════════════════════════════════════════════════════
   FIND ORDER FORMS WITH AN UNREALISTIC QUANTITY
   ────────────────────────────────────────────────────────────────────
   READ-ONLY. Lists order forms whose requested quantity is above 50
   units (the app's limit — EDELPHYN_MAX_UNITS_PER_ORDER). These are
   almost always typing mistakes (e.g. 30000 instead of 3) and cause
   the spike in "Monthly Supply vs Demand Trend". Give the order
   numbers to the blood bank so they can correct them in e-Delphyn.
   No patient names — order number, date, department, quantity only.
   ════════════════════════════════════════════════════════════════════ */
SELECT TOP (50)
       O.COD_ORDERFORM                          AS order_number,
       COALESCE(O.DAT_REQUEST, O.DAT_ORDERFORM) AS request_date,
       D.DES_DEPARTMENT                         AS department,
       O.NUM_QUANTITY                           AS quantity_typed
FROM dbo.ORDERFORM O
LEFT JOIN dbo.DEPARTMENT D ON D.ID_DEPARTMENT = O.ID_DEPARTMENT
WHERE O.NUM_QUANTITY > 50
ORDER BY O.NUM_QUANTITY DESC;
