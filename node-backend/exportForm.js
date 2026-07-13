// node-backend/exportForm.js  — Hospital form layout export (PDF + DOCX)

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign, ImageRun
} = require('docx');
const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, 'logo.png');
let   LOGO_BUF  = null;
try { LOGO_BUF = fs.readFileSync(LOGO_PATH); } catch(e) { /* logo not found — skip */ }

// ════════════════════════════════════════════════════════════════
// PDF EXPORT — draws forms matching BB-19F-04 and BB-19F-23
// ════════════════════════════════════════════════════════════════
function generatePdf(formType, fields) {
  if (formType === 'external_delivery') return generateExtDeliveryPdf(fields);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const K  = '#000000';
    const DK = '#1A2A3A';   // dark navy — section bars
    const GY = '#EBEBEB';   // light grey — shaded header cells
    const ML = 28;          // left margin
    const W  = doc.page.width - ML * 2;  // 539
    const isT = formType === 'transfusion';

    let y = 26;

    // ── Primitive helpers ─────────────────────────────────────────

    function ln(x1, y1, x2, y2) {
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(K).lineWidth(0.4).stroke();
    }

    // Draw a box; optionally fill it
    function bx(x, bY, w, h, fill) {
      if (fill) { doc.rect(x, bY, w, h).fillColor(fill).fill(); }
      doc.rect(x, bY, w, h).strokeColor(K).lineWidth(0.4).stroke();
    }

    // Dark bar with white bold text
    function sBar(text, bY, h = 13) {
      doc.rect(ML, bY, W, h).fillColor(DK).fill();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
         .text(text, ML + 4, bY + 2.5, { width: W - 8, lineBreak: false });
      return bY + h;
    }

    // Place text at absolute (x, y) — never advances doc.y
    function t(text, x, tY, opts = {}) {
      const { b = false, sz = 8.5, c = K, w = 200, al = 'left' } = opts;
      doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz).fillColor(c)
         .text(String(text == null ? '' : text), x, tY, { width: w, lineBreak: false, align: al });
    }

    // A labelled cell: box → bold label on left, value on right
    function cell(label, value, x, cY, totalW, labelW, h = 16) {
      bx(x, cY, totalW, h);
      t(label + ':', x + 3, cY + (h - 8) / 2, { b: true, sz: 7.5, w: labelW - 5 });
      t(value,       x + labelW + 2, cY + (h - 9) / 2, { sz: 8.5, w: totalW - labelW - 5 });
    }

    // Blank cell with bold label (no value, signature lines etc.)
    function labelOnly(label, x, cY, totalW, h = 16) {
      bx(x, cY, totalW, h);
      t(label + ':', x + 3, cY + (h - 8) / 2, { b: true, sz: 7.5, w: totalW - 6 });
    }

    // Draw a checkbox square with optional tick — avoids Unicode font issues
    function checkbox(checked, x, cY, size = 8) {
      doc.rect(x, cY, size, size).strokeColor(K).lineWidth(0.6).stroke();
      if (checked) {
        doc.moveTo(x + 1.5, cY + 4).lineTo(x + 3.5, cY + 6.5).lineTo(x + size - 1, cY + 1.5)
           .strokeColor(K).lineWidth(1.2).stroke();
      }
    }

    // ──────────────────────────────────────────────────────────────
    if (isT) {
      // ══════════════════════════════════════════════════════════
      // TRANSFUSION BLOOD REQUEST  BB-19F-04
      // ══════════════════════════════════════════════════════════

      // Title bar with logo
      const hdrH = 54;
      doc.rect(ML, y, W, hdrH).fillColor(DK).fill();
      if (LOGO_BUF) { try { doc.image(LOGO_BUF, ML + 5, y + 5, { height: 44, width: 44 }); } catch(e){} }
      const txX = ML + (LOGO_BUF ? 56 : 6);
      t('Transfusion Blood Request', txX, y + 10, { b: true, sz: 14, c: '#FFFFFF', w: W - (LOGO_BUF ? 62 : 12) });
      t('Al Rassoul Al-Aazam Hospital — Blood Bank Department', txX, y + 28, { sz: 8, c: '#8AABBB', w: W - (LOGO_BUF ? 62 : 12) });
      t('BB-19F-04', ML + W - 55, y + 42, { sz: 7, c: '#607080', w: 50, al: 'right' });
      y += hdrH + 6;

      // Date / Time
      const half = W / 2;
      cell('Date', fields.request_date, ML,        y, half, 38, 17);
      cell('Time', fields.request_time, ML + half, y, half, 38, 17);
      y += 17;

      // Blood Group / RH / Diagnosis
      const third = W / 3;
      cell("Pt's Blood Group", fields.blood_group, ML,            y, third, 90, 17);
      cell('RH',               fields.rh_factor,   ML + third,    y, third, 30, 17);
      cell('Diagnosis',        fields.diagnosis,   ML + third*2,  y, third, 60, 17);
      y += 17;

      // Patient Name / File Number
      cell("Pt's Name",       fields.patient_name, ML,        y, half, 60, 17);
      cell('File Number', fields.file_number, ML + half, y, half, 90, 17);
      y += 17;

      // Room
      cell('Room / Ward', fields.room, ML, y, W, 70, 17);
      y += 22;

      // ── Components Table ──────────────────────────────────────
      const cComp  = W * 0.35;
      const cUnits = W * 0.13;
      const cPreOp = W * 0.20;
      const cRout  = W * 0.16;
      const cStat  = W - cComp - cUnits - cPreOp - cRout;

      // Header row
      bx(ML, y, W, 14, GY);
      t('Component',           ML + 3,                            y + 3, { b: true, sz: 7.5, w: cComp - 5 });
      ln(ML + cComp,                    y, ML + cComp,                    y + 14);
      t('Nº Units',            ML + cComp + 3,                    y + 3, { b: true, sz: 7.5, w: cUnits - 5, al: 'center' });
      ln(ML + cComp + cUnits,           y, ML + cComp + cUnits,           y + 14);
      t('Pre-Operative 24 hrs',ML + cComp + cUnits + 3,           y + 3, { b: true, sz: 7.5, w: cPreOp - 5, al: 'center' });
      ln(ML + cComp + cUnits + cPreOp,  y, ML + cComp + cUnits + cPreOp,  y + 14);
      t('Routine',             ML + cComp + cUnits + cPreOp + 3,  y + 3, { b: true, sz: 7.5, w: cRout - 5, al: 'center' });
      ln(ML + cComp + cUnits + cPreOp + cRout, y, ML + cComp + cUnits + cPreOp + cRout, y + 14);
      t('Stat (45 min)',        ML + cComp + cUnits + cPreOp + cRout + 3, y + 3, { b: true, sz: 7.5, w: cStat - 5, al: 'center' });
      y += 14;

      const comps = [
        { name: 'Filtered Packed Cells', units: fields.fpc_units, type: fields.fpc_type },
        { name: 'F.F.P',                 units: fields.ffp_units, type: fields.ffp_type },
        { name: 'Platelets',             units: fields.plt_units, type: fields.plt_type },
        { name: fields.others || 'Others', units: fields.others_units, type: fields.others_type },
      ];
      for (const c of comps) {
        bx(ML, y, W, 15);
        t(c.name, ML + 3, y + 3.5, { sz: 8.5, w: cComp - 5 });
        ln(ML + cComp, y, ML + cComp, y + 15);
        t(c.units != null ? String(c.units) : '', ML + cComp + 3, y + 3.5, { sz: 8.5, w: cUnits - 5, al: 'center' });
        ln(ML + cComp + cUnits, y, ML + cComp + cUnits, y + 15);
        // tick in the right column
        const xPreOp  = ML + cComp + cUnits + cPreOp / 2 - 3;
        const xRout   = ML + cComp + cUnits + cPreOp + cRout / 2 - 3;
        const xStat   = ML + cComp + cUnits + cPreOp + cRout + cStat / 2 - 3;
        if (c.type === 'Pre-Op 24hrs') t('✓', xPreOp, y + 3, { b: true, sz: 9, w: 10 });
        if (c.type === 'Routine')      t('✓', xRout,  y + 3, { b: true, sz: 9, w: 10 });
        if (c.type === 'Stat')         t('✓', xStat,  y + 3, { b: true, sz: 9, w: 10 });
        ln(ML + cComp + cUnits + cPreOp, y, ML + cComp + cUnits + cPreOp, y + 15);
        ln(ML + cComp + cUnits + cPreOp + cRout, y, ML + cComp + cUnits + cPreOp + cRout, y + 15);
        y += 15;
      }
      y += 5;

      // ── Blood Bank ────────────────────────────────────────────
      y = sBar('Only for Blood Bank', y);
      y += 3;
      t('Compatible Blood Units', ML, y, { b: true, sz: 8.5, w: W });
      y += 11;

      const uPairW  = W / 2;
      const uNumW   = 18;
      const uValW   = uPairW - uNumW;
      for (let row = 0; row < 4; row++) {
        const a = row + 1, b = row + 5;
        bx(ML,               y, uNumW,  16, GY); t(String(a), ML + 5,               y + 4, { b: true, sz: 8, w: 10 });
        bx(ML + uNumW,       y, uValW,  16);      t(fields[`blood_unit_${a}`], ML + uNumW + 3, y + 3.5, { sz: 8.5, w: uValW - 5 });
        bx(ML + uPairW,      y, uNumW,  16, GY); t(String(b), ML + uPairW + 5,      y + 4, { b: true, sz: 8, w: 10 });
        bx(ML + uPairW+uNumW,y, uValW,  16);      t(fields[`blood_unit_${b}`], ML + uPairW + uNumW + 3, y + 3.5, { sz: 8.5, w: uValW - 5 });
        y += 16;
      }
      y += 5;

      // ── Physicians ────────────────────────────────────────────
      y = sBar('Only For Physicians                                                              Patient History', y);
      y += 3;

      // Previous Transfusion row
      bx(ML, y, W, 16);
      t('Previous Transfusion:', ML + 3, y + 4, { b: true, sz: 7.5, w: 105 });
      const noChk  = !fields.previous_transfusion || fields.previous_transfusion === 'No';
      const yesChk = fields.previous_transfusion === 'Yes' || fields.previous_transfusion === true;
      checkbox(noChk,  ML + 110, y + 5); t(' No',  ML + 120, y + 4, { sz: 8.5, w: 25 });
      checkbox(yesChk, ML + 148, y + 5); t(' Yes', ML + 158, y + 4, { sz: 8.5, w: 25 });
      t('Date:', ML + 205, y + 4, { b: true, sz: 7.5, w: 30 });
      t('Place:', ML + W - 90, y + 4, { b: true, sz: 7.5, w: 35 });
      y += 16;

      // Previous Reaction
      cell('Previous Transfusion Reaction', fields.prev_transfusion_reaction, ML, y, W, 170, 16);
      y += 16;

      // Physician + Signature
      cell('Physician', fields.physician, ML,        y, half, 60, 16);
      labelOnly('Signature', ML + half, y, half, 16);
      y += 20;

      // ── Nurse / Phlebotomist ──────────────────────────────────
      y = sBar('Only For Nurse Sign / Phlebotomist', y);
      y += 3;

      cell('Blood Extracted By', fields.phlebotomist, ML, y, W, 100, 16);
      y += 16;

      const nq = W / 4;
      labelOnly('Name',      ML,       y, nq, 16);
      labelOnly('Date',      ML + nq,  y, nq, 16);
      labelOnly('Time',      ML + nq*2,y, nq, 16);
      labelOnly('Signature', ML + nq*3,y, nq, 16);
      y += 20;

      // ── Life Saving ───────────────────────────────────────────
      y = sBar('Life Saving Cases', y);
      y += 4;
      t('For delivery of blood units without cross-matching, please sign below:', ML + 3, y, { sz: 7.5, c: '#333333', w: W - 6 });
      y += 12;

      const lq = W / 4;
      cell("Physician's Name", fields.ls_physician_t, ML,       y, lq,     80, 16);
      labelOnly('Date',                                ML + lq,  y, lq,     16);
      cell('Time', fields.ls_time_t,                  ML + lq*2,y, lq,     38, 16);
      labelOnly('Signature',                           ML + lq*3,y, lq,     16);
      y += 20;

      // Footer warning bar
      doc.rect(ML, y, W, 14).fillColor('#DDDDDD').fill();
      doc.rect(ML, y, W, 14).strokeColor(K).lineWidth(0.4).stroke();
      t('Incomplete requests or bad filling are not accepted', ML, y + 3, { b: true, sz: 8, c: K, w: W, al: 'center' });
      y += 18;

      // Form number
      t('BB-19F-04 (4)   Apd.: 23/09/2019', ML, y, { sz: 7, c: '#777777', w: W / 2 });
      t('922', ML + W - 20, y, { b: true, sz: 10, c: '#333333', w: 20 });

    } else {
      // ══════════════════════════════════════════════════════════
      // DELIVERY OF BLOOD COMPONENTS  BB-19F-23
      // ══════════════════════════════════════════════════════════

      // ── Logo header bar ──────────────────────────────────────
      const hdrH = 54;
      doc.rect(ML, y, W, hdrH).fillColor(DK).fill();
      if (LOGO_BUF) { try { doc.image(LOGO_BUF, ML + 5, y + 5, { height: 44, width: 44 }); } catch(e){} }
      const dTxX = ML + (LOGO_BUF ? 56 : 6);
      t('Delivery of Blood Components', dTxX, y + 10, { b: true, sz: 14, c: '#FFFFFF', w: W - (LOGO_BUF ? 62 : 12) });
      t('Al Rassoul Al-Aazam Hospital — Blood Bank Department', dTxX, y + 28, { sz: 8, c: '#8AABBB', w: W - (LOGO_BUF ? 62 : 12) });
      t('BB-19F-23', ML + W - 55, y + 42, { sz: 7, c: '#607080', w: 50, al: 'right' });
      y += hdrH + 6;

      // ── Top 3-column header area ──────────────────────────────
      const lW  = W * 0.28;
      const cW  = W * 0.33;
      const rW  = W - lW - cW;
      const tH  = 78;

      // Left: Allergies
      bx(ML, y, lW, tH);
      t('KNOWN ALLERGIES OR SENSITIVITIES', ML + 3, y + 3, { b: true, sz: 7, w: lW - 6 });
      const hasAllergy = !!(fields.allergy_details && fields.allergy_details !== 'None');
      checkbox(hasAllergy,  ML + 3,  y + 16); t(' YES', ML + 13,  y + 15, { sz: 8, w: 28 });
      checkbox(!hasAllergy, ML + 45, y + 16); t(' NO',  ML + 55,  y + 15, { sz: 8, w: 20 });
      t('Include drug or Latex', ML + 3, y + 28, { sz: 7, w: lW - 6 });
      t('Specify: ' + (fields.allergy_details || ''), ML + 3, y + 38, { sz: 7.5, w: lW - 6 });

      // Center: Title
      bx(ML + lW, y, cW, tH);
      t('Delivery of Blood', ML + lW + 3, y + 12, { b: true, sz: 13, w: cW - 6, al: 'center' });
      t('Components',        ML + lW + 3, y + 28, { b: true, sz: 13, w: cW - 6, al: 'center' });
      t('Al Rassoul Al-Aazam Hospital', ML + lW + 3, y + 58, { sz: 7, c: '#555555', w: cW - 6, al: 'center' });

      // Right: Alert labels
      bx(ML + lW + cW, y, rW, tH);
      const alertLabels = [
        { text: 'Similar Names Alert Label', val: fields.similar_names },
        { text: 'Identification Label',       val: false },
        { text: 'Isolation Label',            val: fields.isolation },
        { text: 'Risk To Fall Label',         val: fields.risk_fall },
        { text: 'Allergy Label',              val: fields.allergy_label },
      ];
      let lbY = y + 4;
      for (const lb of alertLabels) {
        checkbox(!!lb.val, ML + lW + cW + 4, lbY + 1);
        t(' ' + lb.text, ML + lW + cW + 14, lbY, { sz: 7.5, w: rW - 18 });
        lbY += 13;
      }
      y += tH + 4;

      // Patient ID row
      cell("Pt's Name",       fields.d_patient_name, ML,        y, W / 2, 60, 16);
      cell('File Number', fields.d_file_number, ML + W/2,  y, W / 2, 90, 16);
      y += 16;

      // Patient Blood Group line
      bx(ML, y, W, 16);
      t('Patient Blood Group:', ML + 3, y + 4, { b: true, sz: 7.5, w: 105 });
      const bgFull = (fields.d_blood_group && fields.d_rh) ? `${fields.d_blood_group}  ${fields.d_rh === 'Pos' ? 'Pos.' : 'Neg.'}` : '';
      t(bgFull, ML + 108, y + 4, { sz: 8.5, w: 80 });
      t('( Please write Pos. for Positive and Neg. for Negative )', ML + W - 280, y + 4.5, { sz: 7, c: '#555555', w: 278 });
      y += 16;

      // Type of Blood Requested
      cell('Type of Blood Requested', fields.blood_type_requested, ML, y, W, 135, 16);
      y += 16;

      // Nurse's Name + Signature
      cell("Nurse's Name", fields.nurse, ML,        y, W / 2, 70, 16);
      labelOnly('Signature',             ML + W/2,  y, W / 2, 16);
      y += 20;

      // ── For Blood Bank Use Only ───────────────────────────────
      y = sBar('For Blood Bank Use Only', y);
      y += 3;

      // Blood Unit N° / Type of Blood
      cell('Blood Unit N°',  fields.blood_unit_numbers, ML,       y, W/2, 75, 16);
      cell('Type of Blood',  fields.type_of_blood,      ML + W/2, y, W/2, 75, 16);
      y += 16;

      // Blood Unit Group (Done Before Delivery)
      cell('Blood Unit group (Done Before Delivery)', fields.blood_unit_group, ML, y, W, 205, 16);
      y += 16;

      // Patient Blood Group (Done Before Delivery)
      cell('Patient Blood Group (Done Before Delivery)', fields.patient_bg_delivery, ML, y, W, 220, 16);
      y += 16;

      // Technician + Signature | Integrity box
      const techW  = W * 0.78;
      const integW = W - techW;
      cell('Technician Name', fields.technician, ML,             y, techW * 0.55, 90, 16);
      labelOnly('Signature',                     ML + techW*0.55,y, techW * 0.45, 16);

      // Integrity box spanning 2 rows
      bx(ML + techW, y, integW, 35);
      t('Integrity',                ML + techW + 3, y + 3,  { b: true, sz: 8, w: integW - 6, al: 'center' });
      const intOk = fields.d_integ === 'yes';
      const intCX = ML + techW + (integW / 2) - 22;
      checkbox(intOk,  intCX,      y + 15); t(' Yes', intCX + 10,  y + 14, { sz: 8, w: 22 });
      checkbox(!intOk, intCX + 36, y + 15); t(' No',  intCX + 46,  y + 14, { sz: 8, w: 18 });
      t('(Temp, Leakage, Volume,\nExpiry Date, Gases)', ML + techW + 3, y + 24, { sz: 6.5, c: '#333333', w: integW - 6, al: 'center' });
      y += 16;

      // Received By + Signature (shares right side with integrity box already drawn)
      cell('Received By', fields.received_by, ML,             y, techW * 0.55, 70, 16);
      labelOnly('Signature',                  ML + techW*0.55,y, techW * 0.45, 16);
      // Close right of integrity box bottom border — already drawn above
      bx(ML + techW, y, integW, 3); // just the bottom line overlap
      y += 16;

      // Date / Time
      cell('Date', fields.delivery_date, ML,       y, W / 2, 38, 16);
      cell('Time', fields.delivery_time, ML + W/2, y, W / 2, 38, 16);
      y += 20;

      // ── For Nurse Unit Use Only ───────────────────────────────
      y = sBar('For Nurse Unit Use Only', y);
      y += 3;

      const nLW = W * 0.52;   // left column width
      const nRW = W - nLW;    // right column (integrity details)

      // Row 1: Received by (nurse) | Leakage
      cell('Received by', fields.nurse_received_by, ML,       y, nLW, 65, 16);
      cell('Leakage',     fields.leakage,           ML + nLW, y, nRW, 50, 16);
      y += 16;

      // Row 2: Nurse Name | Gases
      cell('Nurse Name', fields.nurse_name || fields.nurse, ML,       y, nLW, 65, 16);
      cell('Gases',      fields.gases,                      ML + nLW, y, nRW, 50, 16);
      y += 16;

      // Row 3: Date / Time | Volume
      cell('Date', fields.nurse_date, ML,           y, nLW / 2, 38, 16);
      cell('Time', fields.nurse_time, ML + nLW / 2, y, nLW / 2, 38, 16);
      cell('Volume', fields.volume,   ML + nLW,     y, nRW,     50, 16);
      y += 16;

      // Row 4: Pre-transfusion Safety Card | Exp. Date
      bx(ML, y, nLW, 16);
      t('Pre-transfusion (Safety Card):', ML + 3, y + 4, { b: true, sz: 7.5, w: 145 });
      const sfOk = fields.d_safety === 'yes';
      checkbox(sfOk,  ML + 148, y + 5); t(' Yes', ML + 158, y + 4, { sz: 8, w: 22 });
      checkbox(!sfOk, ML + 184, y + 5); t(' No',  ML + 194, y + 4, { sz: 8, w: 18 });
      cell('Exp. Date', fields.expiry_date, ML + nLW, y, nRW, 55, 16);
      y += 16;

      // Row 5: (blank left) | Temperature
      bx(ML, y, nLW, 16);
      cell('Temperature', fields.temperature ? fields.temperature + ' °C' : '', ML + nLW, y, nRW, 65, 16);
      y += 16;

      // Nurse Name + Signature
      cell('Nurse Name', fields.nurse_name || fields.nurse, ML,       y, W / 2, 70, 16);
      labelOnly('Signature',                                ML + W/2, y, W / 2, 16);
      y += 20;

      // ── Life Saving ───────────────────────────────────────────
      y = sBar('Life Saving Cases', y);
      y += 4;
      t('For delivery of blood units without cross-matching, please sign below:', ML + 3, y, { sz: 7.5, c: '#333333', w: W - 6 });
      y += 12;

      const lq = W / 4;
      cell("Physician's Name", fields.ls_physician_d, ML,        y, lq,     80, 16);
      labelOnly('Date',                               ML + lq,   y, lq,     16);
      cell('Time', fields.ls_time_d,                  ML + lq*2, y, lq,     38, 16);
      labelOnly('Signature',                          ML + lq*3, y, lq,     16);
      y += 20;

      // Form number
      t('BB-19F-23 (4)   Apd:', ML, y, { sz: 7, c: '#777777', w: W / 2 });
      t('935', ML + W - 20, y, { b: true, sz: 10, c: '#333333', w: 20 });
    }

    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════
// External Delivery PDF  BB-19F-06
// ════════════════════════════════════════════════════════════════
function generateExtDeliveryPdf(fields) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const K  = '#000000';
    const DK = '#1A2A3A';
    const GY = '#EBEBEB';
    const ML = 28;
    const W  = doc.page.width - ML * 2;
    let y = 26;

    function ln(x1, y1, x2, y2) { doc.moveTo(x1,y1).lineTo(x2,y2).strokeColor(K).lineWidth(0.4).stroke(); }
    function bx(x, bY, w, h, fill) { if(fill){doc.rect(x,bY,w,h).fillColor(fill).fill();} doc.rect(x,bY,w,h).strokeColor(K).lineWidth(0.4).stroke(); }
    function sBar(text, bY, h=13) { doc.rect(ML,bY,W,h).fillColor(DK).fill(); doc.font('Helvetica-Bold').fontSize(8).fillColor('white').text(text,ML+4,bY+2.5,{width:W-8,lineBreak:false}); return bY+h; }
    function t(text,x,tY,opts={}) { const{b=false,sz=8.5,c=K,w=200,al='left'}=opts; doc.font(b?'Helvetica-Bold':'Helvetica').fontSize(sz).fillColor(c).text(String(text==null?'':text),x,tY,{width:w,lineBreak:false,align:al}); }
    function cell(label,value,x,cY,totalW,labelW,h=16) { bx(x,cY,totalW,h); t(label+':',x+3,cY+(h-8)/2,{b:true,sz:7.5,w:labelW-5}); t(value,x+labelW+2,cY+(h-9)/2,{sz:8.5,w:totalW-labelW-5}); }
    function labelOnly(label,x,cY,totalW,h=16) { bx(x,cY,totalW,h); t(label+':',x+3,cY+(h-8)/2,{b:true,sz:7.5,w:totalW-6}); }
    function checkbox(checked, x, cY, size=8) {
      doc.rect(x, cY, size, size).strokeColor(K).lineWidth(0.6).stroke();
      if (checked) {
        doc.moveTo(x+1.5, cY+4).lineTo(x+3.5, cY+6.5).lineTo(x+size-1, cY+1.5).strokeColor(K).lineWidth(1.2).stroke();
      }
    }

    // ── Logo header bar ──────────────────────────────────────────
    const hdrH = 54;
    doc.rect(ML, y, W, hdrH).fillColor(DK).fill();
    if (LOGO_BUF) { try { doc.image(LOGO_BUF, ML + 5, y + 5, { height: 44, width: 44 }); } catch(e){} }
    const eTxX = ML + (LOGO_BUF ? 56 : 6);
    t('BB External Delivery', eTxX, y + 10, { b:true, sz:14, c:'#FFFFFF', w:W - (LOGO_BUF ? 62 : 12) });
    t('Al Rassoul Al-Aazam Hospital — Blood Bank Department', eTxX, y + 28, { sz:8, c:'#8AABBB', w:W - (LOGO_BUF ? 62 : 12) });
    t('BB-19F-06', ML + W - 55, y + 42, { sz:7, c:'#607080', w:50, al:'right' });
    y += hdrH + 8;

    // Patient Name + Destination
    const half = W / 2;
    cell('Patient Name', fields.patient_name, ML,        y, half, 72, 17);
    cell('Destination',  fields.destination,  ML + half, y, half, 72, 17);
    y += 22;

    // ── Components Table ─────────────────────────────────────────
    const cComp   = W * 0.24;
    const cUnit   = W * 0.22;
    const cBG     = W * 0.16;
    const cExpiry = W * 0.18;
    const cNotes  = W - cComp - cUnit - cBG - cExpiry;

    bx(ML, y, W, 14, GY);
    t('Type of Component', ML+3, y+3, {b:true, sz:7.5, w:cComp-5});
    ln(ML+cComp,                   y, ML+cComp,                   y+14);
    t('Unit No.',   ML+cComp+3,    y+3, {b:true, sz:7.5, w:cUnit-5,   al:'center'});
    ln(ML+cComp+cUnit,             y, ML+cComp+cUnit,             y+14);
    t('Blood Group',ML+cComp+cUnit+3, y+3, {b:true, sz:7.5, w:cBG-5, al:'center'});
    ln(ML+cComp+cUnit+cBG,         y, ML+cComp+cUnit+cBG,         y+14);
    t('Expiry Date',ML+cComp+cUnit+cBG+3, y+3, {b:true, sz:7.5, w:cExpiry-5, al:'center'});
    ln(ML+cComp+cUnit+cBG+cExpiry, y, ML+cComp+cUnit+cBG+cExpiry, y+14);
    t('Notes',      ML+cComp+cUnit+cBG+cExpiry+3, y+3, {b:true, sz:7.5, w:cNotes-5, al:'center'});
    y += 14;

    const compRows = (fields.components && fields.components.length)
      ? fields.components.map(c => ({ name:c.label||'', un:c.unit_no||'', bg:c.blood_group||'', exp:c.expiry_date||'', n:c.notes||'' }))
      : [
          { name:'Filtered RBC', un:fields.frbc_unit_no||'', bg:fields.frbc_blood_group||'', exp:fields.frbc_expiry_date||'', n:fields.frbc_notes||'' },
          { name:'FFP',          un:fields.ffp_unit_no||'',  bg:fields.ffp_blood_group||'',  exp:fields.ffp_expiry_date||'',  n:fields.ffp_notes||''  },
          { name:'Platelets',    un:fields.plt_unit_no||'',  bg:fields.plt_blood_group||'',  exp:fields.plt_expiry_date||'',  n:fields.plt_notes||''  },
          { name:fields.other1_component||'', un:fields.other1_unit_no||'', bg:fields.other1_blood_group||'', exp:fields.other1_expiry_date||'', n:fields.other1_notes||'' },
          { name:fields.other2_component||'', un:fields.other2_unit_no||'', bg:fields.other2_blood_group||'', exp:fields.other2_expiry_date||'', n:fields.other2_notes||'' },
        ];
    for (const r of compRows) {
      bx(ML, y, W, 15);
      t(r.name||'', ML+3, y+3.5, {sz:8.5, w:cComp-5});
      ln(ML+cComp, y, ML+cComp, y+15);
      t(r.un||'', ML+cComp+3, y+3.5, {sz:8.5, w:cUnit-5, al:'center'});
      ln(ML+cComp+cUnit, y, ML+cComp+cUnit, y+15);
      t(r.bg||'', ML+cComp+cUnit+3, y+3.5, {sz:8.5, w:cBG-5, al:'center'});
      ln(ML+cComp+cUnit+cBG, y, ML+cComp+cUnit+cBG, y+15);
      t(r.exp||'', ML+cComp+cUnit+cBG+3, y+3.5, {sz:8.5, w:cExpiry-5, al:'center'});
      ln(ML+cComp+cUnit+cBG+cExpiry, y, ML+cComp+cUnit+cBG+cExpiry, y+15);
      t(r.n||'',  ML+cComp+cUnit+cBG+cExpiry+3, y+3.5, {sz:8.5, w:cNotes-5});
      y += 15;
    }
    y += 8;

    // ── Tests Table ──────────────────────────────────────────────
    y = sBar('Are tested in our blood bank and the result are:', y);
    y += 4;
    const tW = W / 2;
    const tests = [
      { label:'HIV Ab-ELISA',                    key:'test_hiv'     },
      { label:'HBSAg-ELISA',                     key:'test_hbsag'   },
      { label:'HCV Ab-ELISA',                    key:'test_hcv'     },
      { label:'Hb Core IgG',                     key:'test_hb_core' },
      { label:'STS (Screening for Syphilis)',     key:'test_sts'     },
      { label:'IAT (Indirect Anti-globulin test)',key:'test_iat'     },
      { label:'Kell',                            key:'test_kell'    },
    ];
    const labelW = tW * 0.55, resW = tW * 0.25, chkW = tW - labelW - resW;
    // header
    bx(ML, y, tW, 13, GY);
    t('Tests',    ML+3,          y+2.5, {b:true, sz:7.5, w:labelW-5});
    ln(ML+labelW, y, ML+labelW,  y+13);
    t('Results',  ML+labelW+3,   y+2.5, {b:true, sz:7.5, w:resW-5});
    ln(ML+labelW+resW, y, ML+labelW+resW, y+13);
    t('Negative', ML+labelW+resW+3, y+2.5, {b:true, sz:7.5, w:chkW-5});
    y += 13;
    for (const tst of tests) {
      bx(ML, y, tW, 14);
      t(tst.label, ML+3, y+3, {sz:8, w:labelW-5});
      ln(ML+labelW, y, ML+labelW, y+14);
      t('Negative', ML+labelW+3, y+3, {sz:8, w:resW-5});
      ln(ML+labelW+resW, y, ML+labelW+resW, y+14);
      checkbox(!!fields[tst.key], ML+labelW+resW+6, y+3);
      y += 14;
    }
    y += 8;

    // ── Integrity + Delivery Details ─────────────────────────────
    y = sBar('Integrity & Delivery Details', y);
    y += 4;

    bx(ML, y, W, 16);
    t('Integrity (Temp, Leakage, Gases, Volume, Expiry Date):', ML+3, y+4, {b:true, sz:7.5, w:260});
    const intOk = fields.integrity === 'yes';
    checkbox(intOk,  ML+265, y+4);
    t(' Yes', ML+275, y+4, {sz:8.5, w:28});
    checkbox(!intOk, ML+306, y+4);
    t(' No',  ML+316, y+4, {sz:8.5, w:20});
    y += 16;

    const q = W / 4;
    cell('Date',             fields.delivery_date,   ML,       y, q*2, 38, 16);
    cell('Hour',             fields.delivery_hour,   ML + q*2, y, q,   38, 16);
    labelOnly('Destination', ML + q*3, y, q, 16);
    y += 20;

    cell('Technician Name', fields.technician_name, ML,       y, half, 90, 16);
    labelOnly('Signature',                          ML + half, y, half, 16);
    y += 20;

    // ── Footer ───────────────────────────────────────────────────
    doc.rect(ML, y, W, 20).fillColor('#F5F5F5').fill();
    doc.rect(ML, y, W, 20).strokeColor(K).lineWidth(0.4).stroke();
    t('Note: For inquiry or complaints please call: 01-456456  Ext-6120 - 6121', ML+4, y+3, {sz:7, c:'#333333', w:W-8});
    t('Blood bank is not responsible for any damaged blood components due to improper transfer conditions.', ML+4, y+11, {sz:6.5, c:'#555555', w:W-8});
    y += 24;

    t('BB-19F-06 (7)   Apd: 13/10/2023', ML, y, {sz:7, c:'#777777', w:W/2});
    t('953', ML+W-20, y, {b:true, sz:10, c:'#333333', w:20});

    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════
// DOCX EXPORT — table-based layout matching the same sections
// ════════════════════════════════════════════════════════════════
async function generateDocx(formType, fields) {
  if (formType === 'external_delivery') return generateExtDeliveryDocx(fields);
  const isT   = formType === 'transfusion';
  const K     = '000000';
  const NAVY  = '1A2A3A';
  const WHITE = 'FFFFFF';
  const LGREY = 'EBEBEB';
  const bdr   = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const bdrAll = { top: bdr, bottom: bdr, left: bdr, right: bdr };
  const noBdr = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBdrAll = { top: noBdr, bottom: noBdr, left: noBdr, right: noBdr };

  function navyCell(text, w, span = 1) {
    return new TableCell({
      columnSpan: span,
      borders: bdrAll,
      shading: { fill: NAVY, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        children: [new TextRun({ text: text || '', bold: true, color: WHITE, size: 18, font: 'Arial' })]
      })]
    });
  }

  function greyCell(text, w, span = 1) {
    return new TableCell({
      columnSpan: span,
      borders: bdrAll,
      shading: { fill: LGREY, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        children: [new TextRun({ text: text || '', bold: true, color: K, size: 18, font: 'Arial' })]
      })]
    });
  }

  function valCell(text, w, span = 1, shade) {
    return new TableCell({
      columnSpan: span,
      borders: bdrAll,
      shading: { fill: shade || WHITE, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        children: [new TextRun({ text: String(text == null ? '' : text), size: 18, font: 'Arial' })]
      })]
    });
  }

  // Label + value in a single cell (bold label, normal value)
  function lvCell(label, value, span = 1, shade) {
    return new TableCell({
      columnSpan: span,
      borders: bdrAll,
      shading: { fill: shade || WHITE, type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        children: [
          new TextRun({ text: label + ': ', bold: true, size: 18, font: 'Arial' }),
          new TextRun({ text: String(value == null ? '' : value), size: 18, font: 'Arial' }),
        ]
      })]
    });
  }

  // Section header spanning full width
  function secRow(text, cols = 4) {
    return new TableRow({
      children: [navyCell(text, 9360, cols)]
    });
  }

  // Two-cell label-value row
  function lv2(label, value, lW = 3500, vW = 5860) {
    return new TableRow({
      children: [greyCell(label, lW), valCell(value, vW)]
    });
  }

  function tbl(rows, colWidths) {
    return new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: colWidths,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      rows
    });
  }

  const children = [];

  // Logo + Title header row
  const logoImgRuns = LOGO_BUF ? [new ImageRun({ data: LOGO_BUF, transformation: { width: 55, height: 55 }, type: 'png' })] : [];
  children.push(new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [900, 8460],
    rows: [new TableRow({ children: [
      new TableCell({
        borders: { top:{style:BorderStyle.NONE,size:0}, bottom:{style:BorderStyle.NONE,size:0}, left:{style:BorderStyle.NONE,size:0}, right:{style:BorderStyle.NONE,size:0} },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 80, right: 60 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: logoImgRuns })]
      }),
      new TableCell({
        borders: { top:{style:BorderStyle.NONE,size:0}, bottom:{style:BorderStyle.NONE,size:0}, left:{style:BorderStyle.NONE,size:0}, right:{style:BorderStyle.NONE,size:0} },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 40, left: 120, right: 80 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({ children: [new TextRun({ text: isT ? 'Transfusion Blood Request — BB-19F-04' : 'Delivery of Blood Components — BB-19F-23', bold: true, size: 28, font: 'Arial', color: WHITE })] }),
          new Paragraph({ spacing: { before: 40 }, children: [new TextRun({ text: 'Al Rassoul Al-Aazam Hospital — Blood Bank Department', size: 18, font: 'Arial', color: '8AABBB' })] }),
        ]
      }),
    ]})]
  }));
  children.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));

  if (isT) {
    // Date / Time / Room
    children.push(tbl([
      new TableRow({ children: [greyCell('Date', 1560), valCell(fields.request_date, 3120), greyCell('Time', 1560), valCell(fields.request_time, 3120)] }),
    ], [1560, 3120, 1560, 3120]));

    // Patient
    children.push(tbl([
      new TableRow({ children: [greyCell("Pt's Name", 2340), valCell(fields.patient_name, 3480), greyCell('file number', 1560), valCell(fields.file_number, 1980)] }),
      new TableRow({ children: [greyCell("Pt's Blood Group", 2340), valCell(fields.blood_group, 1560), greyCell('RH', 780), valCell(fields.rh_factor, 1560), greyCell('Diagnosis', 1560), valCell(fields.diagnosis, 1560)] }),
      new TableRow({ children: [greyCell('Room / Ward', 2340), valCell(fields.room, 7020, 3)] }),
    ], [2340, 1560, 780, 1560, 1560, 1560]));

    // Components table
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Blood Components Requested', bold: true, size: 20, font: 'Arial' })] }));
    children.push(tbl([
      new TableRow({ children: [navyCell('Component', 3240), navyCell('Nº Units', 1560), navyCell('Pre-Op 24hrs', 1680), navyCell('Routine', 1440), navyCell('Stat (45 min)', 1440)] }),
      new TableRow({ children: [valCell('Filtered Packed Cells', 3240), valCell(fields.fpc_units, 1560), valCell(fields.fpc_type === 'Pre-Op 24hrs' ? '✓' : '', 1680), valCell(fields.fpc_type === 'Routine' ? '✓' : '', 1440), valCell(fields.fpc_type === 'Stat' ? '✓' : '', 1440)] }),
      new TableRow({ children: [valCell('F.F.P', 3240),                  valCell(fields.ffp_units, 1560), valCell(fields.ffp_type === 'Pre-Op 24hrs' ? '✓' : '', 1680), valCell(fields.ffp_type === 'Routine' ? '✓' : '', 1440), valCell(fields.ffp_type === 'Stat' ? '✓' : '', 1440)] }),
      new TableRow({ children: [valCell('Platelets', 3240),              valCell(fields.plt_units, 1560), valCell(fields.plt_type === 'Pre-Op 24hrs' ? '✓' : '', 1680), valCell(fields.plt_type === 'Routine' ? '✓' : '', 1440), valCell(fields.plt_type === 'Stat' ? '✓' : '', 1440)] }),
      new TableRow({ children: [valCell(fields.others || 'Others', 3240),valCell(fields.others_units, 1560), valCell('', 1680), valCell('', 1440), valCell('', 1440)] }),
    ], [3240, 1560, 1680, 1440, 1440]));

    // Blood Bank — Compatible units
    const unitRows = [];
    for (let i = 0; i < 4; i++) {
      unitRows.push(new TableRow({ children: [
        greyCell(String(i+1), 780), valCell(fields[`blood_unit_${i+1}`], 3900),
        greyCell(String(i+5), 780), valCell(fields[`blood_unit_${i+5}`], 3900),
      ]}));
    }
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Only for Blood Bank — Compatible Blood Units', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    children.push(tbl(unitRows, [780, 3900, 780, 3900]));

    // Physicians — Patient History
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Only For Physicians — Patient History', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    const prevTx = !fields.previous_transfusion || fields.previous_transfusion === 'No' ? 'No' : 'Yes';
    children.push(tbl([
      new TableRow({ children: [greyCell('Previous Transfusion', 3500), valCell(prevTx, 1860), greyCell('Date / Place', 1500), valCell(fields.prev_transfusion_place, 2500)] }),
      lv2('Previous Transfusion Reaction', fields.prev_transfusion_reaction),
      new TableRow({ children: [greyCell('Physician', 3500), valCell(fields.physician, 2930), greyCell('Signature', 1430), valCell('', 1500)] }),
    ], [3500, 1860, 1500, 2500]));

    // Nurse / Phlebotomist
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Only For Nurse Sign / Phlebotomist', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    children.push(tbl([
      lv2('Blood Extracted By (Name)', fields.phlebotomist),
      new TableRow({ children: [greyCell('Name', 2340), valCell('', 2340), greyCell('Date', 1560), greyCell('Time', 1560), greyCell('Signature', 1560)] }),
    ], [2340, 2340, 1560, 1560, 1560]));

    // Life Saving
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Life Saving Cases', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    children.push(new Paragraph({ spacing: { before: 0, after: 60 }, children: [new TextRun({ text: 'For delivery of blood units without cross-matching, please sign below:', size: 16, font: 'Arial', italics: true })] }));
    children.push(tbl([
      new TableRow({ children: [greyCell("Physician's Name", 2340), valCell(fields.ls_physician_t, 2340), greyCell('Date', 1560), greyCell('Time', 1560), valCell(fields.ls_time_t, 1560)] }),
    ], [2340, 2340, 1560, 1560, 1560]));

    // Footer
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [new TextRun({ text: 'Incomplete requests or bad filling are not accepted', bold: true, size: 18, font: 'Arial' })]
    }));

  } else {
    // DELIVERY FORM

    // Alert labels
    const alertText = [
      fields.similar_names ? '☑' : '☐', ' Similar Names Alert Label    ',
      fields.isolation     ? '☑' : '☐', ' Isolation Label    ',
      fields.risk_fall     ? '☑' : '☐', ' Risk To Fall Label    ',
      fields.allergy_label ? '☑' : '☐', ' Allergy Label',
    ].join('');
    children.push(new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: alertText, size: 18, font: 'Arial' })]
    }));

    // Allergy + Patient ID
    children.push(tbl([
      new TableRow({ children: [greyCell('Known Allergies / Sensitivities', 3500), valCell(fields.allergy_details, 5860)] }),
      new TableRow({ children: [greyCell("Pt's Name", 3500), valCell(fields.d_patient_name, 2930), greyCell('file number', 1430), valCell(fields.d_file_number, 1500)] }),
      new TableRow({ children: [greyCell("Patient Blood Group", 3500), valCell((fields.d_blood_group || '') + ' ' + (fields.d_rh === 'Pos' ? 'Pos.' : fields.d_rh === 'Neg' ? 'Neg.' : ''), 1500), greyCell('Room / Ward', 1930), valCell(fields.d_room, 2430)] }),
    ], [3500, 2930, 1430, 1500]));

    children.push(tbl([
      lv2('Type of Blood Requested', fields.blood_type_requested),
      new TableRow({ children: [greyCell("Nurse's Name", 3500), valCell(fields.nurse, 2930), greyCell('Signature', 1430), valCell('', 1500)] }),
    ], [3500, 2930, 1430, 1500]));

    // Blood Bank
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'For Blood Bank Use Only', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    children.push(tbl([
      new TableRow({ children: [greyCell('Blood Unit N°', 3500), valCell(fields.blood_unit_numbers, 2430), greyCell('Type of Blood', 1430), valCell(fields.type_of_blood, 2000)] }),
      lv2('Blood Unit group (Done Before Delivery)', fields.blood_unit_group),
      lv2('Patient Blood Group (Done Before Delivery)', fields.patient_bg_delivery),
      new TableRow({ children: [greyCell('Technician Name', 3500), valCell(fields.technician, 2930), greyCell('Signature', 1430), valCell('', 1500)] }),
      new TableRow({ children: [greyCell('Received By', 3500), valCell(fields.received_by, 2930), greyCell('Signature', 1430), valCell('', 1500)] }),
      new TableRow({ children: [greyCell('Date', 1750), valCell(fields.delivery_date, 3000), greyCell('Time', 1250), valCell(fields.delivery_time, 3360)] }),
    ], [3500, 2930, 1430, 1500]));

    // Nurse Unit
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'For Nurse Unit Use Only', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    const sfOk = fields.d_safety === 'yes';
    children.push(tbl([
      new TableRow({ children: [greyCell('Received By (Nurse)', 3500), valCell(fields.nurse_received_by, 2430), greyCell('Leakage', 1430), valCell(fields.leakage, 1500)] }),
      new TableRow({ children: [greyCell('Nurse Name (Unit)',   3500), valCell(fields.nurse_name,         2430), greyCell('Gases',   1430), valCell(fields.gases,   1500)] }),
      new TableRow({ children: [greyCell('Date', 1750), valCell(fields.nurse_date, 2250), greyCell('Time', 1750), valCell(fields.nurse_time, 3610)] }),
      new TableRow({ children: [greyCell('Volume',      1750), valCell(fields.volume,      2250), greyCell('Exp. Date',   1750), valCell(fields.expiry_date, 3610)] }),
      new TableRow({ children: [greyCell('Temperature', 1750), valCell(fields.temperature ? fields.temperature + ' °C' : '', 2250), greyCell('Pre-transfusion Safety Card', 1750), valCell(sfOk ? 'Yes ☑' : 'No ☑', 3610)] }),
      new TableRow({ children: [greyCell('Nurse Name', 3500), valCell(fields.nurse_name || fields.nurse, 2930), greyCell('Signature', 1430), valCell('', 1500)] }),
    ], [1750, 2250, 1750, 3610]));

    // Life Saving
    children.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: 'Life Saving Cases', bold: true, size: 20, font: 'Arial', color: NAVY })] }));
    children.push(new Paragraph({ spacing: { before: 0, after: 60 }, children: [new TextRun({ text: 'For delivery of blood units without cross-matching, please sign below:', size: 16, font: 'Arial', italics: true })] }));
    children.push(tbl([
      new TableRow({ children: [greyCell("Physician's Name", 2340), valCell(fields.ls_physician_d, 2340), greyCell('Date', 1560), greyCell('Time', 1560), valCell(fields.ls_time_d, 1560)] }),
    ], [2340, 2340, 1560, 1560, 1560]));
  }

  // Form number at bottom
  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 200, after: 0 },
    children: [new TextRun({ text: isT ? 'BB-19F-04 (4)' : 'BB-19F-23 (4)', bold: true, size: 16, font: 'Arial', color: '999999' })]
  }));

  // Generated timestamp
  children.push(new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 60 },
    children: [new TextRun({ text: `Generated: ${new Date().toLocaleString('en-GB')}`, size: 14, font: 'Arial', color: '999999' })]
  }));

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      children
    }]
  });

  return await Packer.toBuffer(doc);
}

async function generateExtDeliveryDocx(fields) {
  const K     = '000000';
  const NAVY  = '1A2A3A';
  const WHITE = 'FFFFFF';
  const LGREY = 'EBEBEB';
  const bdr   = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const bdrAll = { top: bdr, bottom: bdr, left: bdr, right: bdr };

  function navyCell(text, span=1) {
    return new TableCell({ columnSpan:span, borders:bdrAll, shading:{fill:NAVY,type:ShadingType.CLEAR}, margins:{top:60,bottom:60,left:80,right:80},
      children:[new Paragraph({ children:[new TextRun({text:text||'',bold:true,color:WHITE,size:18,font:'Arial'})] })] });
  }
  function greyCell(text, span=1) {
    return new TableCell({ columnSpan:span, borders:bdrAll, shading:{fill:LGREY,type:ShadingType.CLEAR}, margins:{top:60,bottom:60,left:80,right:80},
      children:[new Paragraph({ children:[new TextRun({text:text||'',bold:true,color:K,size:18,font:'Arial'})] })] });
  }
  function valCell(text, span=1) {
    return new TableCell({ columnSpan:span, borders:bdrAll, shading:{fill:WHITE,type:ShadingType.CLEAR}, margins:{top:60,bottom:60,left:80,right:80},
      children:[new Paragraph({ children:[new TextRun({text:String(text==null?'':text),size:18,font:'Arial'})] })] });
  }
  function tbl(rows, colWidths) {
    return new Table({ width:{size:9360,type:WidthType.DXA}, columnWidths:colWidths, margins:{top:0,bottom:0,left:0,right:0}, rows });
  }

  const children = [];

  const eLogoRuns = LOGO_BUF ? [new ImageRun({ data: LOGO_BUF, transformation: { width: 55, height: 55 }, type: 'png' })] : [];
  children.push(new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [900, 8460],
    rows: [new TableRow({ children: [
      new TableCell({
        borders: { top:{style:BorderStyle.NONE,size:0}, bottom:{style:BorderStyle.NONE,size:0}, left:{style:BorderStyle.NONE,size:0}, right:{style:BorderStyle.NONE,size:0} },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 80, right: 60 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: eLogoRuns })]
      }),
      new TableCell({
        borders: { top:{style:BorderStyle.NONE,size:0}, bottom:{style:BorderStyle.NONE,size:0}, left:{style:BorderStyle.NONE,size:0}, right:{style:BorderStyle.NONE,size:0} },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 40, left: 120, right: 80 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({ children: [new TextRun({ text: 'BB External Delivery — BB-19F-06 (7)', bold: true, size: 28, font: 'Arial', color: 'FFFFFF' })] }),
          new Paragraph({ spacing: { before: 40 }, children: [new TextRun({ text: 'Al Rassoul Al-Aazam Hospital — Blood Bank Department', size: 18, font: 'Arial', color: '8AABBB' })] }),
        ]
      }),
    ]})]
  }));
  children.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));

  children.push(tbl([
    new TableRow({ children:[greyCell('Patient Name'), valCell(fields.patient_name), greyCell('Destination'), valCell(fields.destination)] }),
  ], [2340, 2340, 2340, 2340]));

  const extDocxRows = (fields.components && fields.components.length)
    ? fields.components.map(c => new TableRow({ children:[greyCell(c.label||''), valCell(c.unit_no||''), valCell(c.blood_group||''), valCell(c.expiry_date||''), valCell(c.notes||'')] }))
    : [
        new TableRow({ children:[greyCell('Filtered RBC'), valCell(fields.frbc_unit_no||''), valCell(fields.frbc_blood_group||''), valCell(fields.frbc_expiry_date||''), valCell(fields.frbc_notes||'')] }),
        new TableRow({ children:[greyCell('FFP'),          valCell(fields.ffp_unit_no||''),  valCell(fields.ffp_blood_group||''),  valCell(fields.ffp_expiry_date||''),  valCell(fields.ffp_notes||'')]  }),
        new TableRow({ children:[greyCell('Platelets'),    valCell(fields.plt_unit_no||''),  valCell(fields.plt_blood_group||''),  valCell(fields.plt_expiry_date||''),  valCell(fields.plt_notes||'')]  }),
        new TableRow({ children:[valCell(fields.other1_component||''), valCell(fields.other1_unit_no||''), valCell(fields.other1_blood_group||''), valCell(fields.other1_expiry_date||''), valCell(fields.other1_notes||'')] }),
        new TableRow({ children:[valCell(fields.other2_component||''), valCell(fields.other2_unit_no||''), valCell(fields.other2_blood_group||''), valCell(fields.other2_expiry_date||''), valCell(fields.other2_notes||'')] }),
      ];
  children.push(new Paragraph({spacing:{before:120,after:40}, children:[new TextRun({text:'Blood Components',bold:true,size:20,font:'Arial',color:NAVY})]}));
  children.push(tbl([
    new TableRow({ children:[navyCell('Type of Component',1), navyCell('Unit No.',1), navyCell('Blood Group',1), navyCell('Expiry Date',1), navyCell('Notes',1)] }),
    ...extDocxRows,
  ], [1872, 1872, 1872, 1872, 1872]));

  children.push(new Paragraph({spacing:{before:120,after:40}, children:[new TextRun({text:'Test Results — Are tested in our blood bank and the result are:',bold:true,size:20,font:'Arial',color:NAVY})]}));
  const testDefs = [
    ['HIV Ab-ELISA', fields.test_hiv],['HBSAg-ELISA', fields.test_hbsag],['HCV Ab-ELISA', fields.test_hcv],
    ['Hb Core IgG', fields.test_hb_core],['STS (Screening for Syphilis)', fields.test_sts],
    ['IAT (Indirect Anti-globulin test)', fields.test_iat],['Kell', fields.test_kell],
  ];
  children.push(tbl([
    new TableRow({ children:[navyCell('Tests',2), navyCell('Results',1), navyCell('Negative ☑',1)] }),
    ...testDefs.map(([name, val]) => new TableRow({ children:[
      greyCell(name, 2), valCell('Negative', 1), valCell(val ? '☑' : '☐', 1)
    ]})),
  ], [3744, 1872, 1872, 1872]));

  children.push(new Paragraph({spacing:{before:120,after:40}, children:[new TextRun({text:'Integrity & Delivery Details',bold:true,size:20,font:'Arial',color:NAVY})]}));
  const intOk = fields.integrity === 'yes';
  children.push(tbl([
    new TableRow({ children:[greyCell('Integrity (Temp, Leakage, Gases, Volume, Expiry Date)',2), valCell((intOk?'☑':'☐')+' Yes   '+(intOk?'☐':'☑')+' No',2)] }),
    new TableRow({ children:[greyCell('Date',1), valCell(fields.delivery_date,1), greyCell('Hour',1), valCell(fields.delivery_hour,1)] }),
    new TableRow({ children:[greyCell('Destination',1), valCell(fields.destination,3)] }),
    new TableRow({ children:[greyCell('Technician Name',1), valCell(fields.technician_name,1), greyCell('Signature',1), valCell('',1)] }),
  ], [2340, 2340, 2340, 2340]));

  children.push(new Paragraph({spacing:{before:160,after:0}, children:[new TextRun({text:'Note: For inquiry or complaints please call: 01-456456  Ext-6120 - 6121',size:16,font:'Arial',color:'555555'})]}));
  children.push(new Paragraph({spacing:{before:40,after:0}, children:[new TextRun({text:'Blood bank is not responsible for any damaged blood components due to improper transfer conditions.',size:14,font:'Arial',color:'777777'})]}));
  children.push(new Paragraph({spacing:{before:80,after:0}, children:[new TextRun({text:'BB-19F-06 (7)   Apd: 13/10/2023',bold:true,size:16,font:'Arial',color:'999999'})]}));
  children.push(new Paragraph({alignment:AlignmentType.RIGHT,spacing:{before:40},
    children:[new TextRun({text:`Generated: ${new Date().toLocaleString('en-GB')}`,size:14,font:'Arial',color:'999999'})]}));

  const doc = new Document({ sections:[{ properties:{page:{size:{width:11906,height:16838},margin:{top:720,right:720,bottom:720,left:720}}}, children }] });
  return await Packer.toBuffer(doc);
}

// ════════════════════════════════════════════════════════════════
// SHIFT HANDOVER REPORT PDF
// ════════════════════════════════════════════════════════════════
function generateHandoverPdf(data) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const K   = '#000000';
    const DK  = '#0D1B2A';
    const RED = '#C0392B';
    const ML  = 36;
    const W   = doc.page.width - ML * 2;   // 523
    const PH  = doc.page.height;

    let y = 0;

    const SHIFT_TIMES = { morning: '07:00 – 15:00', afternoon: '15:00 – 23:00', night: '23:00 – 07:00' };
    const SHIFT_NAME  = { morning: 'Morning',        afternoon: 'Afternoon',     night: 'Night' };

    function ln(x1, y1, x2, y2, color, lw) {
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(color || K).lineWidth(lw || 0.4).stroke();
    }
    function t(text, x, tY, opts) {
      const { b, sz, c, w, al } = opts || {};
      doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz || 8).fillColor(c || K)
         .text(String(text ?? '—'), x, tY, { width: w || 200, lineBreak: false, align: al || 'left' });
    }
    function sBar(text, bY, bg) {
      doc.rect(ML, bY, W, 13).fillColor(bg || DK).fill();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('white')
         .text(text, ML + 5, bY + 3, { width: W - 10, lineBreak: false });
      return bY + 13;
    }
    function checkPage(need) {
      if (y + need > PH - 50) { doc.addPage(); y = 36; }
    }
    function rhStr(rh) {
      if (!rh) return '';
      return rh.toLowerCase().startsWith('pos') ? '+' : rh.toLowerCase().startsWith('neg') ? '-' : '';
    }

    // ── HEADER ───────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 68).fillColor(DK).fill();
    if (LOGO_BUF) doc.image(LOGO_BUF, ML, 10, { width: 46, height: 46 });
    const lx = LOGO_BUF ? ML + 54 : ML;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('white').text('Al Rassoul Al-Aazam Hospital', lx, 12, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#5A9FC8').text('Blood Bank  ·  Shift Handover Report', lx, 29, { lineBreak: false });

    const shiftLabel = SHIFT_NAME[data.shift]  || data.shift || 'Shift';
    const shiftTime  = SHIFT_TIMES[data.shift] || '';
    const dateStr    = data.date
      ? new Date(data.date + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    doc.font('Helvetica-Bold').fontSize(11).fillColor('white')
       .text(`${shiftLabel} Shift`, doc.page.width - 176, 12, { width: 140, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#5A9FC8')
       .text(dateStr, doc.page.width - 176, 28, { width: 140, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#5A9FC8')
       .text(shiftTime, doc.page.width - 176, 43, { width: 140, align: 'right', lineBreak: false });
    y = 80;

    // ── SUMMARY CARDS ────────────────────────────────────────────
    const s    = data.summary || {};
    const cW   = W / 4;
    const cH   = 44;
    const CARDS = [
      { label: 'Transfusions', val: s.transfusions ?? 0, color: RED },
      { label: 'Deliveries',   val: s.deliveries   ?? 0, color: '#1A5276' },
      { label: 'Life-Saving',  val: s.life_saving  ?? 0, color: s.life_saving > 0 ? '#D4730A' : '#777' },
      { label: 'Total Units',  val: s.total_units  ?? 0, color: '#1A7F4B' },
    ];
    CARDS.forEach((card, i) => {
      const cx = ML + i * cW;
      doc.rect(cx, y, cW, cH).fillColor(i % 2 === 0 ? '#F7F9FC' : '#FFFFFF').fill();
      doc.rect(cx, y, cW, cH).strokeColor('#D8DFE8').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(20).fillColor(card.color)
         .text(String(card.val), cx + 4, y + 6, { width: cW - 8, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#666')
         .text(card.label, cx + 4, y + 31, { width: cW - 8, align: 'center', lineBreak: false });
    });
    y += cH + 4;

    // Units issued ribbon
    doc.rect(ML, y, W, 19).fillColor('#EEF4FF').fill();
    doc.rect(ML, y, W, 19).strokeColor('#C5D8F6').lineWidth(0.4).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(DK)
       .text(`Units Requested from Forms:`, ML + 8, y + 6, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(DK)
       .text(`   Packed Cells: ${s.total_prc ?? 0}   ·   FFP: ${s.total_ffp ?? 0}   ·   Platelets: ${s.total_plt ?? 0}`, ML + 132, y + 6, { lineBreak: false });
    y += 19 + 6;

    doc.font('Helvetica').fontSize(7).fillColor('#999')
       .text(`Generated: ${new Date().toLocaleString('en-GB')}`, ML, y, { lineBreak: false });
    y += 12;

    // ── TRANSFUSION REQUESTS TABLE ───────────────────────────────
    y = sBar(`TRANSFUSION REQUESTS  (${(data.transfusions || []).length} records)`, y);
    const TW = [18, 104, 60, 40, 48, 106, 90, 57];
    const TH_LBL = ['#', 'Patient Name', 'File No.', 'Group', 'Room', 'Components', 'Physician', 'Time'];

    // header row
    doc.rect(ML, y, W, 13).fillColor('#E8EDF2').fill();
    let tx = ML;
    TH_LBL.forEach((lbl, i) => {
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444')
         .text(lbl, tx + 2, y + 3.5, { width: TW[i] - 4, lineBreak: false });
      tx += TW[i];
    });
    y += 13;

    if (!data.transfusions || data.transfusions.length === 0) {
      doc.font('Helvetica').fontSize(8).fillColor('#aaa')
         .text('No transfusion requests during this shift.', ML + 8, y + 5, { lineBreak: false });
      y += 18;
    } else {
      data.transfusions.forEach((r, idx) => {
        const isLS  = !!r.life_saving;
        const rowH  = isLS ? 20 : 13;
        checkPage(rowH + 2);

        if (isLS) {
          doc.rect(ML, y, W, rowH).fillColor('#FFF5F5').fill();
          doc.rect(ML, y, 3, rowH).fillColor(RED).fill();
        } else if (idx % 2 === 0) {
          doc.rect(ML, y, W, rowH).fillColor('#FAFBFC').fill();
        }

        const comps = [];
        if (r.fpc_units) comps.push(`${r.fpc_units} PRC${r.fpc_type ? ' ('+r.fpc_type+')' : ''}`);
        if (r.ffp_units) comps.push(`${r.ffp_units} FFP`);
        if (r.plt_units) comps.push(`${r.plt_units} PLT`);

        const cells = [
          idx + 1,
          r.patient_name || '—',
          r.file_number  || '—',
          (r.blood_group || '') + rhStr(r.rh_factor),
          r.room         || '—',
          comps.join(', ') || '—',
          r.physician    || '—',
          r.time_saved   || '—',
        ];
        tx = ML;
        cells.forEach((cell, i) => {
          doc.font('Helvetica').fontSize(7).fillColor(K)
             .text(String(cell), tx + 2, y + 3.5, { width: TW[i] - 4, lineBreak: false });
          tx += TW[i];
        });
        if (isLS) {
          doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED)
             .text('⚠ LIFE-SAVING', ML + 5, y + 12, { lineBreak: false });
        }
        ln(ML, y + rowH, ML + W, y + rowH, '#E0E4EA');
        y += rowH;
      });
    }

    y += 8;
    checkPage(80);

    // ── BLOOD DELIVERIES TABLE ───────────────────────────────────
    y = sBar(`BLOOD DELIVERIES  (${(data.deliveries || []).length} records)`, y, '#1A2A3A');
    const DW = [18, 104, 60, 40, 48, 106, 90, 57];
    const DH_LBL = ['#', 'Patient Name', 'File No.', 'Group', 'Room', 'Type Delivered', 'Technician', 'Time'];

    doc.rect(ML, y, W, 13).fillColor('#E8EDF2').fill();
    tx = ML;
    DH_LBL.forEach((lbl, i) => {
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444')
         .text(lbl, tx + 2, y + 3.5, { width: DW[i] - 4, lineBreak: false });
      tx += DW[i];
    });
    y += 13;

    if (!data.deliveries || data.deliveries.length === 0) {
      doc.font('Helvetica').fontSize(8).fillColor('#aaa')
         .text('No blood deliveries during this shift.', ML + 8, y + 5, { lineBreak: false });
      y += 18;
    } else {
      data.deliveries.forEach((r, idx) => {
        const isLS = !!r.life_saving;
        const rowH = isLS ? 20 : 13;
        checkPage(rowH + 2);

        if (isLS) {
          doc.rect(ML, y, W, rowH).fillColor('#FFF5F5').fill();
          doc.rect(ML, y, 3, rowH).fillColor(RED).fill();
        } else if (idx % 2 === 0) {
          doc.rect(ML, y, W, rowH).fillColor('#FAFBFC').fill();
        }

        const cells = [
          idx + 1,
          r.patient_name         || '—',
          r.file_number          || '—',
          (r.patient_blood_group || '') + rhStr(r.patient_rh),
          r.room                 || '—',
          r.type_of_blood        || r.type_of_blood_requested || '—',
          r.technician_name      || '—',
          r.time_saved           || '—',
        ];
        tx = ML;
        cells.forEach((cell, i) => {
          doc.font('Helvetica').fontSize(7).fillColor(K)
             .text(String(cell), tx + 2, y + 3.5, { width: DW[i] - 4, lineBreak: false });
          tx += DW[i];
        });
        if (isLS) {
          doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED)
             .text('⚠ LIFE-SAVING', ML + 5, y + 12, { lineBreak: false });
        }
        ln(ML, y + rowH, ML + W, y + rowH, '#E0E4EA');
        y += rowH;
      });
    }

    y += 14;
    checkPage(70);

    // ── SIGNATURES ───────────────────────────────────────────────
    y = sBar('HANDOVER SIGNATURES', y, '#2C3E50');
    y += 10;
    const sigW = (W - 24) / 2;
    ['Prepared by (Outgoing Staff)', 'Received by (Incoming Staff)'].forEach((lbl, i) => {
      const sx = ML + i * (sigW + 24);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333').text(lbl, sx, y, { lineBreak: false });
      let sy = y + 14;
      [['Name:', 35], ['Signature:', 50], ['Time:', 32]].forEach(([lab, offset]) => {
        doc.font('Helvetica').fontSize(7).fillColor('#555').text(lab, sx, sy, { lineBreak: false });
        ln(sx + offset, sy + 8, sx + sigW, sy + 8, '#AAAAAA', 0.5);
        sy += 18;
      });
    });

    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════
// generateMonthlyReportPdf(data)  —  A4 monthly management report
// ════════════════════════════════════════════════════════════════
function generateMonthlyReportPdf(data) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const DK  = '#0D1B2A';
    const RED = '#C0392B';
    const BLU = '#1A5276';
    const GRN = '#1A7F4B';
    const ORG = '#D35400';
    const ML  = 36;
    const W   = doc.page.width - ML * 2;   // 523
    const PH  = doc.page.height;           // 841

    let y = 0;

    function t(text, x, tY, opts) {
      const { b, sz, c, w, al } = opts || {};
      doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(sz || 8).fillColor(c || '#000')
         .text(String(text ?? '—'), x, tY, { width: w || 200, lineBreak: false, align: al || 'left' });
    }
    function ln(x1, y1, x2, y2, col, lw) {
      doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(col || '#CCC').lineWidth(lw || 0.4).stroke();
    }
    function sBar(label, bY, col) {
      doc.rect(ML, bY, W, 14).fillColor(col || DK).fill();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFF')
         .text(label, ML + 6, bY + 3.5, { width: W - 12, lineBreak: false });
      return bY + 14;
    }
    function checkPage(need) {
      if (y + need > PH - 48) { doc.addPage(); y = 36; }
    }

    // ── HEADER ──────────────────────────────────────────────────
    const hH = 70;
    doc.rect(0, 0, doc.page.width, hH).fillColor(DK).fill();
    if (LOGO_BUF) { try { doc.image(LOGO_BUF, ML, 12, { width: 44, height: 44 }); } catch(e){} }
    const lx = LOGO_BUF ? ML + 52 : ML;
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFF')
       .text('Al Rassoul Al-Aazam Hospital', lx, 13, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#5A9FC8')
       .text('Blood Bank Department  ·  Monthly Management Report', lx, 31, { lineBreak: false });

    const period = data.period || {};
    const monthLabel = period.label || period.month || '';
    const rx = doc.page.width - ML;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFF')
       .text(monthLabel, ML, 14, { width: W, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#7EB8D0')
       .text(`Generated: ${data.generated_at || ''}`, ML, 32, { width: W, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#7EB8D0')
       .text(`Period: ${period.from || ''} → ${period.to || ''}`, ML, 44, { width: W, align: 'right', lineBreak: false });
    y = hH + 10;

    // ── OVERVIEW CARDS ───────────────────────────────────────────
    const ov = data.overview || {};
    const CARDS = [
      { label: 'Transfusion\nRequests', val: ov.transfusions ?? 0, color: RED },
      { label: 'Blood\nDeliveries',     val: ov.deliveries   ?? 0, color: BLU },
      { label: 'Life-Saving\nCases',    val: ov.life_saving  ?? 0, color: ov.life_saving > 0 ? ORG : '#888' },
      { label: 'Total\nRecords',        val: (ov.transfusions || 0) + (ov.deliveries || 0), color: GRN },
    ];
    const cW = W / 4;
    const cH = 52;
    CARDS.forEach((card, i) => {
      const cx = ML + i * cW;
      doc.rect(cx, y, cW, cH).fillColor(i % 2 === 0 ? '#F7F9FC' : '#FFF').fill();
      doc.rect(cx, y, cW, cH).strokeColor('#D8DFE8').lineWidth(0.5).stroke();
      doc.rect(cx, y, 3, cH).fillColor(card.color).fill();
      doc.font('Helvetica-Bold').fontSize(24).fillColor(card.color)
         .text(String(card.val), cx + 7, y + 8, { width: cW - 14, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#666')
         .text(card.label, cx + 7, y + 37, { width: cW - 14, align: 'center', lineBreak: false });
    });
    y += cH + 10;

    // ── UNITS ISSUED (Excel) ─────────────────────────────────────
    y = sBar('UNITS ISSUED  (from Excel records)', y);
    const units = data.units || {};
    const UNITCOLS = [
      { label: 'Packed Red Cells (PRC)', val: units.prc ?? 0, color: RED },
      { label: 'Fresh Frozen Plasma (FFP)', val: units.ffp ?? 0, color: BLU },
      { label: 'Platelets (PLT)', val: units.plt ?? 0, color: ORG },
      { label: 'Total Units Issued', val: units.total ?? 0, color: GRN },
    ];
    const uW = W / 4;
    const uH = 38;
    UNITCOLS.forEach((u, i) => {
      const ux = ML + i * uW;
      doc.rect(ux, y, uW, uH).fillColor(i === 3 ? '#EFF7F0' : '#F4F6FA').fill();
      doc.rect(ux, y, uW, uH).strokeColor('#D8DFE8').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(18).fillColor(u.color)
         .text(String(u.val), ux + 4, y + 7, { width: uW - 8, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(6.5).fillColor('#666')
         .text(u.label, ux + 4, y + 28, { width: uW - 8, align: 'center', lineBreak: false });
    });
    y += uH + 10;

    // ── RESPONSE TIMES ───────────────────────────────────────────
    const rt = data.response_times || {};
    checkPage(60);
    y = sBar('RESPONSE TIMES', y);
    const lsPct    = rt.ls_count    > 0 ? Math.round((rt.ls_within    / rt.ls_count)    * 100) : null;
    const urgPct   = rt.urgent_count > 0 ? Math.round((rt.urgent_within / rt.urgent_count) * 100) : null;
    const rtCols   = [
      { label: 'Avg BB Dispatch', val: rt.avg_bb_minutes    != null ? `${rt.avg_bb_minutes} min`    : 'N/A', color: BLU },
      { label: 'Avg Nurse Receipt', val: rt.avg_nurse_minutes != null ? `${rt.avg_nurse_minutes} min` : 'N/A', color: GRN },
      { label: 'Life-Saving ≤15 min', val: lsPct   != null ? `${lsPct}%`   : 'N/A', sub: rt.ls_count    ? `${rt.ls_within}/${rt.ls_count} cases`       : '', color: lsPct   >= 80 ? GRN : RED },
      { label: 'Urgent ≤45 min',      val: urgPct  != null ? `${urgPct}%`  : 'N/A', sub: rt.urgent_count ? `${rt.urgent_within}/${rt.urgent_count} cases` : '', color: urgPct  >= 80 ? GRN : ORG },
    ];
    const rH = 36;
    rtCols.forEach((r, i) => {
      const rx2 = ML + i * (W/4);
      doc.rect(rx2, y, W/4, rH).fillColor('#F7F9FC').fill();
      doc.rect(rx2, y, W/4, rH).strokeColor('#D8DFE8').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(15).fillColor(r.color)
         .text(r.val, rx2 + 4, y + 6, { width: W/4 - 8, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(6.5).fillColor('#666')
         .text(r.label, rx2 + 4, y + 24, { width: W/4 - 8, align: 'center', lineBreak: false });
      if (r.sub) doc.font('Helvetica').fontSize(6).fillColor('#888')
         .text(r.sub, rx2 + 4, y + 32, { width: W/4 - 8, align: 'center', lineBreak: false });
    });
    y += rH + 10;

    // ── BLOOD GROUP BREAKDOWN (from Excel) ───────────────────────
    const bgs = data.blood_groups || [];
    if (bgs.length) {
      checkPage(14 + bgs.length * 13 + 10);
      y = sBar('BLOOD GROUP DISTRIBUTION  (from Excel issuance records)', y);
      const bgTotal = bgs.reduce((s, r) => s + (r.total || 0), 0);
      const BG_COLS = [100, 70, 70, 70, 70, W - 380];
      const BG_HDRS = ['Blood Group', 'PRC', 'FFP', 'PLT', 'Total', 'Share'];
      doc.rect(ML, y, W, 13).fillColor('#EDF2F7').fill();
      doc.rect(ML, y, W, 13).strokeColor('#CCC').lineWidth(0.3).stroke();
      let hx = ML;
      BG_HDRS.forEach((h, i) => { t(h, hx + 4, y + 2.5, { b: true, sz: 7, c: '#444', w: BG_COLS[i] - 8 }); hx += BG_COLS[i]; });
      y += 13;
      bgs.forEach((row, idx) => {
        checkPage(13);
        doc.rect(ML, y, W, 13).fillColor(idx % 2 === 0 ? '#FAFBFC' : '#FFF').fill();
        doc.rect(ML, y, W, 13).strokeColor('#DDD').lineWidth(0.3).stroke();
        const pct = bgTotal > 0 ? `${Math.round(((row.total || 0) / bgTotal) * 100)}%` : '—';
        let cx3 = ML;
        [row.group, row.prc ?? 0, row.ffp ?? 0, row.plt ?? 0, row.total ?? 0, pct].forEach((v, i) => {
          t(v, cx3 + 4, y + 2.5, { sz: 8, w: BG_COLS[i] - 8, b: i === 0 || i === 4 });
          cx3 += BG_COLS[i];
        });
        const barX = ML + BG_COLS[0] + BG_COLS[1] + BG_COLS[2] + BG_COLS[3] + BG_COLS[4] + 4;
        const barW = Math.max(2, Math.round(((BG_COLS[5] - 8) * (row.total || 0)) / (bgTotal || 1)));
        doc.rect(barX, y + 4, barW, 5).fillColor(RED).fill();
        y += 13;
      });
      y += 10;
    }

    // ── TOP WARDS (from Excel) ────────────────────────────────────
    const rooms = data.top_rooms || [];
    if (rooms.length) {
      checkPage(14 + rooms.length * 13 + 10);
      y = sBar('TOP WARDS / ROOMS  (from Excel issuance records)', y);
      const maxRm = rooms[0]?.cnt || 1;
      const RM_COLS = [W * 0.38, 58, 58, 58, 60, W - W * 0.38 - 234];
      doc.rect(ML, y, W, 13).fillColor('#EDF2F7').fill();
      doc.rect(ML, y, W, 13).strokeColor('#CCC').lineWidth(0.3).stroke();
      let rhx = ML;
      ['Ward / Room', 'PRC', 'FFP', 'PLT', 'Total', ''].forEach((h, i) => {
        t(h, rhx + 4, y + 2.5, { b: true, sz: 7, c: '#444', w: RM_COLS[i] - 8 });
        rhx += RM_COLS[i];
      });
      y += 13;
      rooms.forEach((r, idx) => {
        checkPage(13);
        doc.rect(ML, y, W, 13).fillColor(idx % 2 === 0 ? '#FAFBFC' : '#FFF').fill();
        doc.rect(ML, y, W, 13).strokeColor('#DDD').lineWidth(0.3).stroke();
        let rcx = ML;
        [r.room, r.prc ?? 0, r.ffp ?? 0, r.plt ?? 0, r.cnt ?? 0].forEach((v, i) => {
          t(v, rcx + 4, y + 2.5, { sz: 8, w: RM_COLS[i] - 8, b: i === 4, c: i === 4 ? BLU : '#333' });
          rcx += RM_COLS[i];
        });
        const bX = ML + RM_COLS[0] + RM_COLS[1] + RM_COLS[2] + RM_COLS[3] + RM_COLS[4] + 4;
        const bW = Math.max(2, Math.round((RM_COLS[5] - 8) * (r.cnt || 0) / maxRm));
        doc.rect(bX, y + 4, bW, 5).fillColor(BLU).fill();
        y += 13;
      });
      y += 10;
    }

    // ── STAFF ─────────────────────────────────────────────────────
    const phys = data.top_physicians  || [];
    const tech = data.top_technicians || [];
    if (phys.length || tech.length) {
      checkPage(14 + Math.max(phys.length, tech.length) * 13 + 10);
      y = sBar('STAFF ACTIVITY', y);
      const halfW = W / 2 - 4;
      // Physician sub-header
      doc.rect(ML, y, halfW, 12).fillColor('#EDF2F7').fill();
      t('Physician', ML + 4, y + 2, { b: true, sz: 7, c: '#444', w: halfW - 40 });
      t('Cases', ML + halfW - 36, y + 2, { b: true, sz: 7, c: '#444', w: 32, al: 'right' });
      // Tech sub-header
      const tx = ML + halfW + 8;
      doc.rect(tx, y, halfW, 12).fillColor('#EDF2F7').fill();
      t('Technician', tx + 4, y + 2, { b: true, sz: 7, c: '#444', w: halfW - 40 });
      t('Cases', tx + halfW - 36, y + 2, { b: true, sz: 7, c: '#444', w: 32, al: 'right' });
      y += 12;
      const maxRows = Math.max(phys.length, tech.length);
      for (let i = 0; i < maxRows; i++) {
        doc.rect(ML, y, halfW, 12).fillColor(i % 2 === 0 ? '#FAFBFC' : '#FFF').fill();
        doc.rect(ML, y, halfW, 12).strokeColor('#DDD').lineWidth(0.3).stroke();
        doc.rect(tx, y, halfW, 12).fillColor(i % 2 === 0 ? '#FAFBFC' : '#FFF').fill();
        doc.rect(tx, y, halfW, 12).strokeColor('#DDD').lineWidth(0.3).stroke();
        if (phys[i]) {
          t(phys[i].physician, ML + 4, y + 2, { sz: 8, w: halfW - 44 });
          t(phys[i].cnt, ML + halfW - 36, y + 2, { b: true, sz: 8, c: RED, w: 32, al: 'right' });
        }
        if (tech[i]) {
          t(tech[i].technician_name, tx + 4, y + 2, { sz: 8, w: halfW - 44 });
          t(tech[i].cnt, tx + halfW - 36, y + 2, { b: true, sz: 8, c: BLU, w: 32, al: 'right' });
        }
        y += 12;
      }
      y += 10;
    }

    // ── DAILY UNITS ISSUED (from Excel) ──────────────────────────
    const daily = data.daily_trend || [];
    if (daily.length) {
      // 3-column block layout: each block = Date | PRC | FFP | PLT | Total
      const perBlock = Math.ceil(daily.length / 3);
      checkPage(14 + perBlock * 12 + 10);
      y = sBar('DAILY UNITS ISSUED  (from Excel issuance records)', y);
      const dCW   = W / 3;
      const dSubs = ['Date', 'PRC', 'FFP', 'PLT', 'Total'];
      const subW  = dCW / dSubs.length;
      for (let col = 0; col < 3; col++) {
        const ox = ML + col * dCW;
        doc.rect(ox, y, dCW, 12).fillColor('#EDF2F7').fill();
        doc.rect(ox, y, dCW, 12).strokeColor('#CCC').lineWidth(0.3).stroke();
        dSubs.forEach((h, i) => t(h, ox + 3 + i * subW, y + 2, { b: true, sz: 6, c: '#444', w: subW - 4 }));
      }
      y += 12;
      for (let row = 0; row < perBlock; row++) {
        checkPage(12);
        for (let col = 0; col < 3; col++) {
          const item = daily[row + col * perBlock];
          const ox = ML + col * dCW;
          doc.rect(ox, y, dCW, 12).fillColor(row % 2 === 0 ? '#FAFBFC' : '#FFF').fill();
          doc.rect(ox, y, dCW, 12).strokeColor('#DDD').lineWidth(0.3).stroke();
          if (item) {
            const vals = [item.date ? item.date.slice(5) : '—', item.prc ?? 0, item.ffp ?? 0, item.plt ?? 0, item.total ?? 0];
            const cols = ['#333', RED, BLU, ORG, GRN];
            vals.forEach((v, i) => t(v, ox + 3 + i * subW, y + 2, { sz: 7, c: cols[i], w: subW - 4, b: i === 4 }));
          }
        }
        y += 12;
      }
      y += 10;
    }

    // ── SIGNATURE FOOTER ─────────────────────────────────────────
    checkPage(60);
    y += 6;
    ln(ML, y, ML + W, y, '#CCC', 0.5);
    y += 10;
    const sigW = W / 3 - 10;
    const sigs = ['Prepared by', 'Reviewed by', 'Approved by'];
    sigs.forEach((label, i) => {
      const sx = ML + i * (W / 3);
      t(label, sx, y, { b: true, sz: 7.5, c: '#444', w: sigW });
      t('Name: ___________________________', sx, y + 12, { sz: 7, w: sigW });
      t('Signature: ______________________', sx, y + 22, { sz: 7, w: sigW });
      t('Date: ___________________________', sx, y + 32, { sz: 7, w: sigW });
    });

    doc.end();
  });
}

module.exports = { generateDocx, generatePdf, generateHandoverPdf, generateMonthlyReportPdf };
