// Navigation — showPage() page switcher
// Sidebar/drawer behaviour lives in core/shell.js.
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// PAGE NAV — FORMS / DASHBOARD
// ═══════════════════════════════════════════════════════
function showPage(page) {
  const adminOnly = ['dashboard','admin','settings','extdel','donor','excel','handover','consumption','monthly','ai','analytics','stock'];
  if (adminOnly.includes(page) && currentUser?.role !== 'admin') page = 'forms';
  const isForm        = page === 'forms';
  const isDash        = page === 'dashboard';
  const isAdmin       = page === 'admin';
  const isSettings    = page === 'settings';
  const isExtDel      = page === 'extdel';
  const isDonor       = page === 'donor';
  const isExcel       = page === 'excel';
  const isConsumption = page === 'consumption';
  const isHandover    = page === 'handover';
  const isMonthly     = page === 'monthly';
  const isChat        = page === 'chat';
  const isAI          = page === 'ai';
  const isAnalytics   = page === 'analytics';
  const isStock       = page === 'stock';
  document.getElementById('tabForms').classList.toggle('active', isForm);
  document.getElementById('tabDashboard').classList.toggle('active', isDash);
  document.getElementById('tabAdmin').classList.toggle('active', isAdmin);
  document.getElementById('tabSettings').classList.toggle('active', isSettings);
  document.getElementById('tabExtDel').classList.toggle('active', isExtDel);
  document.getElementById('tabDonor').classList.toggle('active', isDonor);
  document.getElementById('tabExcel').classList.toggle('active', isExcel);
  document.getElementById('tabConsumption').classList.toggle('active', isConsumption);
  document.getElementById('tabHandover').classList.toggle('active', isHandover);
  document.getElementById('tabMonthly').classList.toggle('active', isMonthly);
  document.getElementById('tabChat').classList.toggle('active', isChat);
  document.getElementById('tabAI').classList.toggle('active', isAI);
  document.getElementById('tabAnalytics').classList.toggle('active', isAnalytics);
  document.getElementById('tabStock').classList.toggle('active', isStock);
  document.querySelector('.forms-row').style.display    = isForm  ? '' : 'none';
  document.querySelector('.history-wrap').style.display = isForm  ? '' : 'none';
  document.querySelector('.voice-bar').style.display    = (isForm || isExtDel) ? '' : 'none';
  document.getElementById('dashSection').classList.toggle('show', isDash);
  document.getElementById('adminSection').style.display = isAdmin ? '' : 'none';
  document.getElementById('settingsSection').style.display = isSettings ? '' : 'none';
  document.getElementById('extDelSection').classList.toggle('show', isExtDel);
  document.getElementById('donorSection').classList.toggle('show', isDonor);
  document.getElementById('excelSection').classList.toggle('show', isExcel);
  document.getElementById('consumptionSection').classList.toggle('show', isConsumption);
  document.getElementById('handoverSection').classList.toggle('show', isHandover);
  document.getElementById('monthlySection').classList.toggle('show', isMonthly);
  document.getElementById('chatSection').classList.toggle('show', isChat);
  document.getElementById('aiSection').classList.toggle('show', isAI);
  document.getElementById('analyticsSection').classList.toggle('show', isAnalytics);
  document.getElementById('stockSection').classList.toggle('show', isStock);
  if (!isChat) _chatActiveDept = null;  // leaving chat → re-enable notifications
  if (isMonthly) initMonthlyReport();
  if (isChat)    initChat();
  if (isAI)      initAI();
  // Toggle voice bar seg-tabs: normal forms vs ext delivery
  ['tabBoth','tabTransfusion','tabDelivery'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isExtDel ? 'none' : '';
  });
  const extDelTab = document.getElementById('tabExtDelivery');
  if (extDelTab) extDelTab.style.display = isExtDel ? '' : 'none';
  document.getElementById('btnMulti').style.display = isExtDel ? 'none' : '';
  if (isExtDel) {
    // Batch mode doesn't apply to ext delivery — reset it so recording goes to the right endpoint
    if (batchMode) {
      batchMode = false;
      document.getElementById('btnMulti').classList.remove('active');
      document.getElementById('batchBanner').style.display = 'none';
    }
    setForm('ext_delivery');
  } else if (!isForm && activeForm === 'ext_delivery') setForm('both');
  if (isDash)        loadDashboard();
  if (isAdmin)       loadUsers();
  if (isSettings)    { loadDbSettings(); loadDepartments(); }
  if (isExtDel)      { renderExtCompTable(); loadExtHistory(); }
  if (isDonor)       initDonorCard();
  if (isExcel)       loadExcelFiles();
  if (isConsumption) loadConsumption();
  if (isHandover)    initHandover();
  if (isAnalytics)   loadAnalytics();
  if (isStock)       loadStock();
  onPageShown(page);   // core/shell.js — heading, drawer, body[data-page]
}
