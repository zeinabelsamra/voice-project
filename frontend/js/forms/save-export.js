// Forms — save and PDF/DOCX export
// 
// Loaded as a classic script (shared global scope) — see index.html for load order.

// ═══════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════
async function saveForm(formType) {
  if (!validateForm(formType)) return;

  // Block silent saves of voice-filled fields Whisper is known to mangle
  // (file numbers, blood unit numbers) until a human has actually looked.
  const prefix = formType === 'transfusion' ? 't' : 'd';
  const card = document.getElementById(prefix === 't' ? 'cardTransfusion' : 'cardDelivery');
  const unverified = card ? [...card.querySelectorAll('.needs-verify')] : [];
  if (unverified.length > 0) {
    const names = unverified.map(el => HIGH_RISK_VOICE_LABELS[el.id] || el.id).join(', ');
    const proceed = confirm(`⚠ ${unverified.length} voice-filled field(s) haven't been manually reviewed: ${names}.\n\nWhisper is known to mis-transcribe numbers here — please double-check them.\n\nSave anyway?`);
    if (!proceed) return;
  }

  const data = { form_type: formType };
  Object.entries(FIELD_MAP).forEach(([key, map]) => {
    if (map.form !== formType) return;
    const el = document.getElementById(map.id);
    if (!el) return;
    if (map.type === 'checkbox') data[key] = el.checked;
    else data[key] = el.value;
  });
  if (formType === 'transfusion') {
    const extraComponents = collectExtraTComponents();
    data.components_json = extraComponents.length ? JSON.stringify(extraComponents) : null;
    const unitEntries = collectTUnitCompEntries();
    data.blood_unit_entries_json = unitEntries.length ? JSON.stringify(unitEntries) : null;
  }
  if (formType === 'delivery') {
    const extraComponents = collectExtraDComponents();
    data.d_components_json = extraComponents.length ? JSON.stringify(extraComponents) : null;
  }

  // Expiry date check for delivery forms
  if (formType === 'delivery' && data.expiry_date) {
    const expiry   = new Date(data.expiry_date + 'T00:00:00');
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const diffDays = Math.round((expiry - today) / 86400000);

    if (expiry < today) {
      const el = document.getElementById('d_expiry_date');
      if (el) { el.classList.add('expiry-expired'); el.scrollIntoView({ behavior:'smooth', block:'center' }); }
      setStatus('', `❌ Blood unit expired ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} ago — delivery blocked`);
      return;
    }
    if (diffDays <= 1) {
      const msg = diffDays === 0
        ? 'This blood unit expires TODAY. Confirm delivery?'
        : 'This blood unit expires TOMORROW. Confirm delivery?';
      if (!confirm('⚠ ' + msg)) return;
    }
  }

  // Blood compatibility check for delivery forms
  if (formType === 'delivery') {
    const bg        = data.d_blood_group;
    const rh        = data.d_rh === 'Pos' ? '+' : data.d_rh === 'Neg' ? '-' : '';
    const patientGr = bg && rh ? bg + rh : null;
    const unitGr    = data.blood_unit_group || null;
    if (patientGr && unitGr && !isCompatible(patientGr, unitGr)) {
      const proceed = await showCompatWarning(patientGr, unitGr);
      if (!proceed) return;
    }
  }

  const isUpdate = currentEditRecord && currentEditRecord.form_type === formType;

  // File number uniqueness check — only for new records
  if (!isUpdate) {
    const prefix      = formType === 'transfusion' ? 't' : 'd';
    const fileNum     = formType === 'transfusion' ? data.file_number : data.d_file_number;
    const patientName = (formType === 'transfusion' ? data.patient_name : data.d_patient_name) || '';

    if (fileNum) {
      try {
        const _lr  = await apiFetch(`${API}/patient/lookup?file_number=${encodeURIComponent(fileNum)}`);
        const lookup = _lr ? await _lr.json() : { found: false };
        if (lookup.found &&
            lookup.patient_name &&
            lookup.patient_name.toLowerCase().trim() !== patientName.toLowerCase().trim()) {
          const fnEl = document.getElementById(prefix + '_file_number');
          const hint = document.getElementById(prefix + '_fnHint');
          if (fnEl) { fnEl.classList.add('field-error'); fnEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          if (hint) { hint.textContent = `⚠ File number already belongs to "${lookup.patient_name}" — cannot save`; hint.className = 'fn-hint show error'; }
          setStatus('', `❌ File number already assigned to "${lookup.patient_name}"`);
          return;
        }
      } catch { /* network error — allow save to proceed */ }
    }

    // Duplicate same-day record warning
    if (fileNum) {
      try {
        const _dr = await apiFetch(`${API}/check-duplicate?file_number=${encodeURIComponent(fileNum)}&form_type=${encodeURIComponent(formType)}`);
        const dup = _dr ? await _dr.json() : { duplicate: false };
        if (dup.duplicate) {
          const timeStr = dup.saved_at ? dup.saved_at.replace('T', ' ') : 'earlier today';
          const proceed = confirm(`⚠ A ${formType} record for "${dup.patient_name}" already exists today (saved at ${timeStr}).\n\nSave anyway?`);
          if (!proceed) return;
        }
      } catch { /* network error — allow save to proceed */ }
    }
  }

  const url    = isUpdate
    ? `${API}/forms/update/${currentEditRecord.id}`
    : `${API}/forms/save`;
  const method = isUpdate ? 'PUT' : 'POST';

  try {
    const res    = await apiFetch(url, { method, body: data });
    const result = await res.json();
    if (result.success) {
      const prefix = formType === 'transfusion' ? 't' : 'd';
      clearDraft(formType);
      if (isUpdate) {
        exitViewMode(prefix);
      } else {
        clearForm(prefix); // clear fields so auto-save doesn't re-draft them
      }
      setStatus('done', isUpdate ? '✅ Record updated!' : '✅ Saved to database!');
      loadHistory();
    } else {
      setStatus('', '❌ ' + (isUpdate ? 'Update' : 'Save') + ' failed: ' + (result.error || 'unknown'));
    }
  } catch (err) {
    setStatus('', '❌ Cannot reach server');
  }
}

// ═══════════════════════════════════════════════════════
// EXPORT — PDF / DOCX
// ═══════════════════════════════════════════════════════
async function exportForm(formType, fileType) {
  const data = { form_type: formType };
  Object.entries(FIELD_MAP).forEach(([key, map]) => {
    if (map.form !== formType) return;
    const el = document.getElementById(map.id);
    if (!el) return;
    if (map.type === 'checkbox') data[key] = el.checked;
    else data[key] = el.value;
  });
  if (formType === 'transfusion') {
    const extraComponents = collectExtraTComponents();
    if (extraComponents.length) data.components_json = JSON.stringify(extraComponents);
    const unitEntries = collectTUnitCompEntries();
    if (unitEntries.length) data.blood_unit_entries_json = JSON.stringify(unitEntries);
  }
  if (formType === 'delivery') {
    const extraComponents = collectExtraDComponents();
    if (extraComponents.length) data.d_components_json = JSON.stringify(extraComponents);
  }

  setStatus('processing', '⏳ Generating ' + fileType.toUpperCase() + '…');

  try {
    const res = await apiFetch(`${API}/export/` + fileType, { method: 'POST', body: data });

    if (!res.ok) {
      const errText = await res.text();
      setStatus('', '❌ Export failed: ' + errText);
      return;
    }

    const blob = await res.blob();
    if (blob.size === 0) { setStatus('', '❌ Export returned empty file'); return; }

    const patName = (
      document.getElementById(formType === 'transfusion' ? 't_patient_name' : 'd_patient_name')?.value || 'form'
    ).replace(/\s+/g, '_');

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = patName + '_' + formType + '.' + fileType;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus('done', '✅ ' + fileType.toUpperCase() + ' downloaded!');
  } catch (err) {
    setStatus('', '❌ Export error: ' + err.message);
  }
}
