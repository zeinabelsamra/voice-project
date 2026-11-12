// Forms — filling fields from voice extraction
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// FILL FIELDS
// ═══════════════════════════════════════════════════════
// Fields where Whisper is known to mangle the transcription (digit chunking /
// hyphenation of file numbers and blood unit numbers — see voiceParser.js).
// Voice-filling one of these adds a persistent "needs verification" highlight
// instead of the normal brief flash, until a human reviews/edits it.
const HIGH_RISK_VOICE_LABELS = {
  t_file_number: 'File Number',
  t_room: 'Room / Ward',
  d_file_number: 'File Number',
  d_blood_unit_numbers: 'Blood Unit N°',
  d_room: 'Room / Ward',
};

function updateVerifyCount(prefix) {
  const card = document.getElementById(prefix === 't' ? 'cardTransfusion' : 'cardDelivery');
  const countEl = document.getElementById(prefix + '_verifyCount');
  if (!card || !countEl) return;
  const n = card.querySelectorAll('.needs-verify').length;
  if (n > 0) {
    countEl.textContent = `⚠ ${n} voice field${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} verification`;
    countEl.classList.add('show');
  } else {
    countEl.textContent = '';
    countEl.classList.remove('show');
  }
}

function fillFields(fields, targetForm) {
  for (const [key, value] of Object.entries(fields)) {
    const map = FIELD_MAP[key];
    if (!map) continue;
    if (targetForm !== 'both' && map.form !== targetForm) continue;
    const el = document.getElementById(map.id);
    if (!el) continue;

    const label = key.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());

    if (map.type === 'checkbox') {
      el.checked = (value === true || value === 'true' || value === 'yes');
    } else if (map.type === 'radio') {
      const isTrue = (value === true || value === 'true' || value === 'yes');
      const radio = document.querySelector(`input[name="${el.name}"][value="${isTrue ? 'Yes' : 'No'}"]`);
      if (radio) radio.checked = true;
    } else {
      el.value = String(value);
      el.classList.remove('voice-hit');
      void el.offsetWidth;
      el.classList.add('voice-hit');
      setTimeout(() => el.classList.remove('voice-hit'), 1200);
      if (HIGH_RISK_VOICE_LABELS[map.id]) {
        el.classList.add('needs-verify');
        updateVerifyCount(map.form === 'transfusion' ? 't' : 'd');
      }
    }

    if (map.form === 'transfusion') { tCount++; document.getElementById('t_count').textContent = tCount; }
    else                            { dCount++; document.getElementById('d_count').textContent = dCount; }

    showToast(label, String(value));
  }
}

// ═══════════════════════════════════════════════════════
// FILL EXT DELIVERY FIELDS FROM VOICE
// ═══════════════════════════════════════════════════════
function fillExtFields(fields) {
  let count = 0;
  const hit = (el) => {
    el.classList.remove('voice-hit');
    void el.offsetWidth;
    el.classList.add('voice-hit');
    setTimeout(() => el.classList.remove('voice-hit'), 1200);
  };
  const set = (id, val) => {
    if (val === undefined || val === null || val === '') return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(val);
    hit(el);
    count++;
    showToast(id.replace(/^ex_/, '').replace(/_/g, ' '), String(val));
  };

  set('ex_patient_name',    fields.ext_patient_name);
  set('ex_destination',     fields.ext_destination);
  set('ex_delivery_date',   fields.ext_delivery_date);
  set('ex_delivery_hour',   fields.ext_delivery_hour);
  set('ex_technician_name', fields.ext_technician_name);

  if (fields.ext_integrity) {
    const radio = document.querySelector(`input[name="ex_integrity"][value="${fields.ext_integrity}"]`);
    if (radio) { radio.checked = true; count++; showToast('Integrity', fields.ext_integrity); }
  }

  const TEST_IDS = {
    ext_test_hiv:     'ex_test_hiv',
    ext_test_hbsag:   'ex_test_hbsag',
    ext_test_hcv:     'ex_test_hcv',
    ext_test_hb_core: 'ex_test_hb_core',
    ext_test_sts:     'ex_test_sts',
    ext_test_iat:     'ex_test_iat',
    ext_test_kell:    'ex_test_kell',
  };
  Object.entries(TEST_IDS).forEach(([fkey, elId]) => {
    if (fields[fkey]) {
      const el = document.getElementById(elId);
      if (el) { el.checked = true; count++; }
    }
  });
  const checkedTests = Object.keys(TEST_IDS).filter(k => fields[k]).length;
  if (checkedTests > 0) showToast('Tests', checkedTests + ' confirmed');

  if (fields.ext_components && fields.ext_components.length > 0) {
    const usedIdx = new Set(); // track rows already claimed in this pass
    fields.ext_components.forEach(extracted => {
      // __bare__ means no component keyword was said — put into first empty row
      let idx = extracted.key === '__bare__'
        ? extComponents.findIndex((c, i) => !usedIdx.has(i) && !c.unit_no)
        : extComponents.findIndex((c, i) => !usedIdx.has(i) && c.key === extracted.key && !c.unit_no);
      // No available row of this type — auto-add one
      if (idx === -1 && extracted.key !== '__bare__') {
        addExtCompRow(extracted.key);
        idx = extComponents.findIndex((c, i) => !usedIdx.has(i) && c.key === extracted.key && !c.unit_no);
      }
      if (idx !== -1) {
        usedIdx.add(idx);
        if (extracted.unit_no)     extComponents[idx].unit_no     = extracted.unit_no;
        if (extracted.blood_group) extComponents[idx].blood_group = extracted.blood_group;
        if (extracted.expiry_date) extComponents[idx].expiry_date = extracted.expiry_date;
        if (extracted.notes)       extComponents[idx].notes       = extracted.notes;
        count++;
      }
    });
    renderExtCompTable();
    showToast('Components', fields.ext_components.length + ' row(s) detected');
  }
}
