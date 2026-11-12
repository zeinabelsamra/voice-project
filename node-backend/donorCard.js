// node-backend/donorCard.js — Donor Card (بطاقة المتبرع)  BB-19F-01 (5)
//
// Self-contained module: the questionnaire definition (served to the
// frontend so the question list lives in one place), the DonorCards table
// migration, the CRUD routes, and the Arabic PDF/DOCX export.
//
// Storage: a handful of searchable columns plus the whole form as
// data_json, so adding a field to the form needs no schema change.

const PDFDocument = require('pdfkit');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, ImageRun,
} = require('docx');
const fs   = require('fs');
const path = require('path');

const FORM_CODE = 'BB-19F-01 (5)';

let LOGO_BUF = null;
try { LOGO_BUF = fs.readFileSync(path.join(__dirname, 'logo.png')); } catch (e) { /* no logo */ }

// ════════════════════════════════════════════════════════════════
// Questionnaire — same order and wording as the paper form.
//   flagIf : the answer that needs review by the physician/technician
//            (null = informational, never flagged)
//   only   : 'female' | 'male' | 'platelet' — question applies only then
//   detail : show a free-text box for the "if yes, what / where" part
//   sub    : indented sub-question (the AIDS-symptom list on page 2)
// ════════════════════════════════════════════════════════════════
const SECTIONS = [
  { title: null, questions: [
    { key: 'q01', flagIf: 'no',  text: 'هل تشعر أنك بحالة جيدة اليوم ؟' },
    { key: 'q02', flagIf: 'yes', text: 'هل تتناول المضادات الحيوية أو أي أدوية أخرى لمعالجة التهاب ما ؟' },
    { key: 'q03', flagIf: 'yes', detail: true, text: 'هل تتناول حالياً أو تناولت في الماضي أي أدوية لأي سبب كان؟ في حال الإيجاب ، ما هي ؟' },
    { key: 'q04', flagIf: 'no',  text: 'في الساعات الأربع الماضية ، هل تناولت الطعام ؟' },
    { key: 'q05', flagIf: 'yes', text: 'في الساعات الثماني والأربعين الماضية : هل تبرعت بالصفيحات أو البلازما أو كريات الدم البيضاء ؟' },
    { key: 'q06', flagIf: 'yes', text: 'في الأيام السبع الماضية ، هل جرى نزع أي من أسنانك ؟' },
    { key: 'q07', flagIf: 'yes', text: 'في الأيام الثماني والعشرين الماضية ، هل تعرضت لحرارة أو إسهال أو إلتهاب في المجاري البولية أو الجهاز التنفسي ؟' },
    { key: 'q08', flagIf: 'yes', text: 'في الاسابيع الثمانية الماضية ، هل تلقيت أي لقاحات أو حقنات أخرى ؟' },
    { key: 'q09', flagIf: 'yes', text: 'في الاسابيع الثمانية الماضية ، هل تبرعت بالدم الكامل ؟' },
  ]},
  { title: 'في الاشهر الاثني عشر الاخيرة:', questions: [
    { key: 'q10', flagIf: 'yes', only: 'female', text: 'للمتبرعات فقط: هل كنت حامل أو هل أنت حامل حالياً ؟' },
    { key: 'q11', flagIf: 'yes', text: 'هل خضعت لجراحة أو تنظير داخلي أو أي إجراء طبي آخر ؟' },
    { key: 'q12', flagIf: 'yes', text: 'هل خضعت لعملية نقل دم أو أي من منتجاته ؟' },
    { key: 'q13', flagIf: 'yes', text: 'هل خضعت لعملية زرع أعضاء ، أنسجة أو نقي عظم ؟' },
    { key: 'q14', flagIf: 'yes', text: 'هل خضعت لعملية زرع عظم أو جلد ؟' },
    { key: 'q15', flagIf: 'yes', text: 'هل لامست دم شخص آخر ؟' },
    { key: 'q16', flagIf: 'yes', text: 'هل تعرّضت لوخز إبرة عن طريق الخطأ ؟' },
    { key: 'q17', flagIf: 'yes', text: 'هل أجري لك وشماً ؟' },
    { key: 'q18', flagIf: 'yes', text: 'هل أجريت ثقب في الأذن أو في أي مكان آخر في الجسم ؟' },
    { key: 'q19', flagIf: 'yes', text: 'هل تعرّضت لعضّة كلب وتلقّيت لقاحًا ضد الكلب ؟' },
    { key: 'q20', flagIf: 'yes', text: 'هل كنت على اتصال جنسي بأيّ شخص مصاب بفيروس السيدا / الأيدز أو سبق وكانت نتيجة الكشف عنه إيجابية ؟' },
    { key: 'q21', flagIf: 'yes', text: 'هل كنت على اتصال جنسي مع عاملة جنس أو أي شخص آخر يتقاضى المال أو المخدرات أو غيره لقاء ممارسة الجنس ؟' },
    { key: 'q22', flagIf: 'yes', text: 'هل كنت على اتصال جنسي بشخص استخدم الإبر لتعاطي المخدرات أو المنشطات أو أيّ مادة أخرى لم يصفها طبيب، وذلك في أيّ مرحلة من حياته ؟' },
    { key: 'q23', flagIf: 'yes', text: 'هل كنت على اتصال جنسي مصاب الهيموفيليا أو استخدام مركزات عامل التخثر لمعالجة مشاكل النزيف ؟' },
    { key: 'q24', flagIf: 'yes', only: 'female', text: 'للمتبرّعات فقط: هل كنت على اتصال جنسي برجل كان له اتصال جنسي برجل آخر ؟' },
    { key: 'q25', flagIf: 'yes', text: 'هل كنت على اتصال جنسي بشخص مصاب بالتهاب الكبد، اليرقان أو الصفيرة ؟' },
    { key: 'q26', flagIf: 'yes', text: 'هل ساكنت أو خالطت شخص مصاب بالتهاب الكبد أو اليرقان ؟' },
    { key: 'q27', flagIf: 'yes', text: 'هل تلقّيت الأجسام المضادة لفيروس الإلتهاب الكبد الوبائيّ (باء) ؟ Hepatitis B' },
    { key: 'q28', flagIf: 'yes', text: 'هل أصبت بالزهري (Syphilis) أو بداء السيلان (Gonorrhea) أو تلقيت العلاج لأي منهما ؟' },
    { key: 'q29', flagIf: 'yes', text: 'هل أمضيت أكثر من 72 ساعة في مركز الإحتجاز للأحداث أو سجن أو حبس ؟' },
  ]},
  { title: '', questions: [
    { key: 'q30', flagIf: 'yes', detail: true, text: 'في السنوات الثلاث الماضية هل سافرت إلى خارج لبنان ؟ إلى أين ؟' },
    { key: 'q31', flagIf: 'yes', text: 'بين العامين 1980 و 1996، هل أمضيت فترة تبلغ ثلاثة أشهر أو أكثر في المملكة المتحدة ؟' },
    { key: 'q32', flagIf: 'yes', text: 'من العام 1980 إلى اليوم، هل أجريت لك عملية نقل دم في أوروبا ؟' },
    { key: 'q33', flagIf: 'yes', text: 'من العام 1977 إلى اليوم، هل تقاضيت المال أو المخدرات أو أي نوع آخر من البدل لقاء ممارسة الجنس ؟' },
    { key: 'q34', flagIf: 'yes', only: 'male', text: 'من العام 1977 إلى اليوم، للمتبرعين من الذكور فقط: هل كنت على اتصال جنسي برجل آخر، ولو لمرة واحدة ؟' },
    { key: 'q35', flagIf: 'yes', text: 'هل زرت أو سكنت في منطقة توطّن الملاريا ؟' },
    { key: 'q36', flagIf: 'yes', text: 'هل كان اختبارك إيجابياً لفيروس السيدا / الأيدز ؟' },
    { key: 'q37', flagIf: 'yes', sub: true, text: 'هل خسرت 5 كلغ أو أكثر من وزنك بشكل لا يمكن تفسيره ؟' },
    { key: 'q38', flagIf: 'yes', sub: true, text: 'هل أصبت بسعال أو بضيق في التنفّس أو بإسهال لفترة طويلة ؟' },
    { key: 'q39', flagIf: 'yes', sub: true, text: 'هل أصبت بحمّى لم تعرف أسبابها ؟' },
    { key: 'q40', flagIf: 'yes', sub: true, text: 'هل ظهرت كتل حمراء أو بنفسجية على بشرتك أو تحت الجلد في الأشهر الستة الأخيرة ؟' },
    { key: 'q41', flagIf: 'yes', sub: true, text: 'هل ظهرت كتل بقع بيضاء أو تقرحات غير عادية في فمك بشكل مستمر ؟' },
    { key: 'q42', flagIf: 'yes', text: 'هل استخدمت الإبر لتعاطي المخدرات أو المنشطات أو أي مادة أخرى لم يصفها طبيبك ؟' },
    { key: 'q43', flagIf: 'yes', text: 'هل عانيت نزيفاً أو مرضاً في الدم ؟' },
    { key: 'q44', flagIf: 'yes', text: 'هل استخدمت مركزات عامل التخثر لمعالجة مشاكل النزيف؟' },
    { key: 'q45', flagIf: 'yes', text: 'هل خضعت لجراحة في الرأس أو الدماغ؟' },
    { key: 'q46', flagIf: 'yes', text: 'هل تلقيت هرمون النمو من منشأ بشري؟ Growth Hormone' },
    { key: 'q47', flagIf: 'yes', text: 'هل لأي من أقربائك إصابة بمرض جنون البقر - كروتزفيلد جاكوب؟ Creutzfeldt-Jakob' },
    { key: 'q48', flagIf: 'yes', text: 'هل أصبت بالتهاب الكبد، اليرقان / الصفيرة أو كانت نتائج اختبارات التهاب الكبد إيجابية؟ Hepatitis' },
    { key: 'q49', flagIf: 'yes', text: 'هل أصبت بالملاريا؟' },
    { key: 'q50', flagIf: 'yes', text: 'هل أصبت بأي نوع من السرطان بما فيه اللوكيميا؟' },
    { key: 'q51', flagIf: 'yes', text: 'هل أصبت بأي مرض في الجهاز التنفسي أو شعرت بألم في الصدر أو عانيت مشاكل في القلب والرئتين؟' },
    { key: 'q52', flagIf: 'yes', text: 'هل تتبرع بالدم لأنك تريد أن تفحص دمك لكشف فيروس السيدا / الأيدز؟' },
    { key: 'q53', flagIf: 'no',  text: 'هل أنت مدرك أنك إذا كنت مصاباً بأي فيروس ، يمكن أن تنقله لشخص آخر ولو كنت تشعر أنك بصحة جيدة وكان اختبارك سلبياً ؟' },
    { key: 'q54', flagIf: 'no',  text: 'هل قرأت وفهمت كل المعلومات المرتبطة بالتبرع بالدم المقدمة إليك وهل تلقيت إجابات عن كل أسئلتك؟' },
    { key: 'q55', flagIf: null,  text: 'هل بإمكاننا الإتصال بك في حال احتاج مريض إلى دم من دمك؟' },
  ]},
  { title: 'التبرع بالصفائح:', only: 'platelet', questions: [
    { key: 'q56', flagIf: 'no', only: 'platelet', text: 'عدد الصفائح أكثر من 200.000/µL' },
    { key: 'q57', flagIf: 'no', only: 'platelet', text: 'المدة أكثر من خمسة أيام' },
  ]},
];

const ALL_QUESTIONS = SECTIONS.flatMap(s => s.questions);

// Acceptance limits printed on the paper form (Physical Examination /
// Laboratory Data). Used to highlight out-of-range values.
const LIMITS = {
  weight_min: 50,
  temp_max: 37.5,
  bp_sys_min: 90, bp_sys_max: 160,     // "Systolic over 90, under 160"
  bp_dia_min: 50, bp_dia_max: 100,
  pulse_min: 50,  pulse_max: 100,
  hb_min_female: 12.5, hct_min_female: 38,
  hb_min_male:   13.5, hct_min_male:   41,
};

const CONSENT_TEXT = [
  'أنا الموقع أدناه أؤكد بأن المعلومات الطبية التي أدليت بها صحيحة ودقيقة على حد علمي. لقد قرأت وفهمت المواد التعليمية بشأن السلوك عالي المخاطر ولا أعتبر نفسي معرضاً لخطر متزايد لإنتقال الإيدز أو أيّ أمراض معدية أخرى. إنني أعطي الإذن لسحب الدم الكامل مني وفحصه كما يعتبر مناسباً. إذا، ولأيّ سبب، أحسست أن دمي ليس آمناً للنقل، سأعلم المؤسسة التي تجمعه.',
  'أنا أفهم كلياً وأقبل أنه يجب أن أبقى لمدة 10 دقائق في بنك الدم، بعد التبرع بالدم. إذا غادرت قبل الدقائق العشر، أفهم أيضاً أن ذلك هو بخلاف المشورة الطبية وأيّ عواقب تتبع ذلك، هي على مسؤوليتي الكاملة.',
];

const POSITIVE_TESTS = [
  { key: 'pos_hiv', label: 'HIV' }, { key: 'pos_hbsag', label: 'HbsAg' },
  { key: 'pos_hcv', label: 'HCV' }, { key: 'pos_core', label: 'Core' },
  { key: 'pos_syphilis', label: 'Syphilis' }, { key: 'pos_indirect_coombs', label: 'Indirect coombs' },
];

// Eligibility decision recorded at the end of the screening.
//   d.eligibility      : 'accepted' | 'temp_deferred' | 'perm_deferred' ('' = pending)
//   d.deferral_reasons : array of DEFERRAL_REASONS keys
//   d.deferral_other   : free text when 'other' is ticked
//   d.deferral_until   : date the temporary deferral ends
// suggestFrom: the review flags (question keys / vital keys) that point to
// this reason, so the form can pre-tick reasons from what was flagged.
const DEFERRAL_REASONS = [
  { key: 'low_hb',           label: 'Low Hb / Hct',                   suggestFrom: ['hb', 'hct'] },
  { key: 'bp',               label: 'Blood pressure out of range',    suggestFrom: ['bp_sys', 'bp_dia'] },
  { key: 'pulse',            label: 'Pulse out of range',             suggestFrom: ['pulse'] },
  { key: 'weight',           label: 'Underweight (< 50 kg)',          suggestFrom: ['weight'] },
  { key: 'temp',             label: 'Fever / high temperature',       suggestFrom: ['temp'] },
  { key: 'recent_donation',  label: 'Donation interval not met',      suggestFrom: ['q05', 'q09'] },
  { key: 'medication',       label: 'Medication / antibiotics',       suggestFrom: ['q02', 'q03'] },
  { key: 'illness',          label: 'Recent illness / infection',     suggestFrom: ['q01', 'q07'] },
  { key: 'fasting',          label: 'Did not eat (fasting)',          suggestFrom: ['q04'] },
  { key: 'procedure',        label: 'Recent surgery / dental / transfusion', suggestFrom: ['q06', 'q08', 'q11', 'q12', 'q13', 'q14', 'q45', 'q46', 'q32'] },
  { key: 'tattoo_piercing',  label: 'Tattoo / piercing',              suggestFrom: ['q17', 'q18'] },
  { key: 'pregnancy',        label: 'Pregnancy',                      suggestFrom: ['q10'] },
  { key: 'travel_malaria',   label: 'Travel / malaria risk',          suggestFrom: ['q30', 'q31', 'q35', 'q49'] },
  { key: 'high_risk',        label: 'High-risk exposure / behaviour', suggestFrom: ['q15', 'q16', 'q19', 'q20', 'q21', 'q22', 'q23', 'q24', 'q25', 'q26', 'q27', 'q28', 'q29', 'q33', 'q34', 'q42', 'q44', 'q52', 'needle_marks', 'skin_lesions'] },
  { key: 'medical_history',  label: 'Medical history (blood, cancer, heart, hepatitis…)', suggestFrom: ['q36', 'q37', 'q38', 'q39', 'q40', 'q41', 'q43', 'q47', 'q48', 'q50', 'q51'] },
  { key: 'positive_test',    label: 'Positive infectious test',       suggestFrom: [] },
  { key: 'low_platelets',    label: 'Platelet count / interval (platelet donors)', suggestFrom: ['q56', 'q57'] },
  { key: 'other',            label: 'Other',                          suggestFrom: [] },
];
const ELIGIBILITY = ['accepted', 'temp_deferred', 'perm_deferred'];

// ── Helpers shared by save/list/export ──────────────────────────
function questionApplies(q, d) {
  if (!q.only) return true;
  if (q.only === 'platelet') return d.donation_type === 'platelet';
  // Gender-specific questions stay visible until a gender is chosen.
  return !d.gender || d.gender === q.only;
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// Everything on the card that needs a second look: answers matching a
// question's flagIf, plus vitals/lab values outside the printed limits.
function reviewFlags(d) {
  const flags = [];
  const answers = d.answers || {};
  ALL_QUESTIONS.forEach(q => {
    if (q.flagIf && questionApplies(q, d) && answers[q.key] === q.flagIf) flags.push(q.key);
  });
  const w = num(d.exam_weight), t = num(d.exam_temp), s = num(d.exam_bp_sys),
        di = num(d.exam_bp_dia), p = num(d.exam_pulse), hb = num(d.lab_hb), hct = num(d.lab_hct);
  if (w  != null && w  < LIMITS.weight_min) flags.push('weight');
  if (t  != null && t  > LIMITS.temp_max)   flags.push('temp');
  if (s  != null && (s  <= LIMITS.bp_sys_min || s  >= LIMITS.bp_sys_max)) flags.push('bp_sys');
  if (di != null && (di <  LIMITS.bp_dia_min || di >  LIMITS.bp_dia_max)) flags.push('bp_dia');
  if (p  != null && (p  <  LIMITS.pulse_min  || p  >  LIMITS.pulse_max))  flags.push('pulse');
  const female = d.gender === 'female';
  if (hb  != null && hb  < (female ? LIMITS.hb_min_female  : LIMITS.hb_min_male))  flags.push('hb');
  if (hct != null && hct < (female ? LIMITS.hct_min_female : LIMITS.hct_min_male)) flags.push('hct');
  if (d.exam_needle_marks === 'yes')  flags.push('needle_marks');
  if (d.exam_skin_lesions === 'yes')  flags.push('skin_lesions');
  return flags;
}

function str(v, max) { if (v == null || v === '') return null; return String(v).slice(0, max); }

// Labels for the non-question review flags produced by reviewFlags().
const VITAL_FLAG_LABELS = {
  weight: 'Weight < 50 kg', temp: 'Temp > 37.5 °C', bp_sys: 'Systolic out of 90–160',
  bp_dia: 'Diastolic out of 50–100', pulse: 'Pulse out of 50–100', hb: 'Hb below limit',
  hct: 'Hct below limit', needle_marks: 'Needle marks', skin_lesions: 'Skin lesions',
};

// Aggregates for the Donor Card dashboard. rows: DonorCards rows incl. data_json.
function buildStats(rows, days) {
  const pad = n => String(n).padStart(2, '0');
  const dayKey = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  const now = new Date();
  const todayKey   = dayKey(now);
  const monthKey   = todayKey.slice(0, 7);
  const lm         = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMoKey  = dayKey(lm).slice(0, 7);
  const weekStart  = new Date(now); weekStart.setDate(now.getDate() - 6);
  const weekKey    = dayKey(weekStart);

  // Pre-fill the daily series so empty days still show as zero.
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    daily.push({ date: dayKey(d), blood: 0, platelet: 0, other: 0, deferred: 0 });
  }
  const dailyIdx = Object.fromEntries(daily.map((d, i) => [d.date, i]));

  const qText = Object.fromEntries(ALL_QUESTIONS.map(q => [q.key, q.text]));
  const s = {
    total: rows.length, today: 0, week: 0, month: 0, lastMonth: 0,
    flaggedCards: 0, totalFlags: 0,
    byType:   { blood: 0, platelet: 0, unknown: 0 },
    byGender: { male: 0, female: 0, unknown: 0 },
    byGroup:  {},
    canContact: { yes: 0, no: 0, unanswered: 0 },
    positives: Object.fromEntries(POSITIVE_TESTS.map(t => [t.key, { label: t.label, count: 0 }])),
    questionFlags: {}, vitalFlags: {},
    daily, days,
    recentFlagged: [],
    // Eligibility / deferrals
    outcome: { accepted: 0, temp_deferred: 0, perm_deferred: 0, pending: 0 },
    outcomeByType: Object.fromEntries(['blood', 'platelet', 'unknown'].map(t =>
      [t, { total: 0, accepted: 0, temp_deferred: 0, perm_deferred: 0, pending: 0 }])),
    deferralReasons: Object.fromEntries(DEFERRAL_REASONS.map(r =>
      [r.key, { key: r.key, label: r.label, count: 0, blood: 0, platelet: 0, temp: 0, perm: 0 }])),
    deferredNoReason: 0,
    deferralOtherTexts: {},
    recentDeferred: [],
  };
  const reasonLabel = Object.fromEntries(DEFERRAL_REASONS.map(r => [r.key, r.label]));

  rows.forEach(r => {
    let d = {};
    try { d = JSON.parse(r.data_json) || {}; } catch (e) { /* columns only */ }
    d = { ...d, donation_type: r.donation_type ?? d.donation_type, gender: r.gender ?? d.gender };
    const created = r.created_at || '';
    const dk = created.slice(0, 10), mk = created.slice(0, 7);

    if (dk === todayKey) s.today++;
    if (dk >= weekKey)   s.week++;
    if (mk === monthKey) s.month++;
    if (mk === lastMoKey) s.lastMonth++;

    const type = d.donation_type === 'blood' || d.donation_type === 'platelet' ? d.donation_type : null;
    s.byType[type || 'unknown']++;
    if (dk in dailyIdx) daily[dailyIdx[dk]][type || 'other']++;

    s.byGender[d.gender === 'male' || d.gender === 'female' ? d.gender : 'unknown']++;

    const group = r.blood_group ? `${r.blood_group}${r.rh === 'Pos' ? '+' : r.rh === 'Neg' ? '−' : ''}` : 'Unknown';
    s.byGroup[group] = (s.byGroup[group] || 0) + 1;

    const contact = (d.answers || {}).q55;
    s.canContact[contact === 'yes' ? 'yes' : contact === 'no' ? 'no' : 'unanswered']++;

    POSITIVE_TESTS.forEach(t => { if (d[t.key]) s.positives[t.key].count++; });

    const outcome = ELIGIBILITY.includes(d.eligibility) ? d.eligibility : 'pending';
    s.outcome[outcome]++;
    const ot = s.outcomeByType[type || 'unknown'];
    ot.total++; ot[outcome]++;
    if (dk in dailyIdx && outcome !== 'accepted' && outcome !== 'pending') daily[dailyIdx[dk]].deferred++;
    if (outcome === 'temp_deferred' || outcome === 'perm_deferred') {
      const reasons = Array.isArray(d.deferral_reasons) ? d.deferral_reasons.filter(k => reasonLabel[k]) : [];
      if (!reasons.length) s.deferredNoReason++;
      reasons.forEach(k => {
        const b = s.deferralReasons[k];
        b.count++;
        if (type) b[type]++;
        b[outcome === 'perm_deferred' ? 'perm' : 'temp']++;
      });
      const other = reasons.includes('other') && d.deferral_other ? String(d.deferral_other).trim() : '';
      if (other) s.deferralOtherTexts[other] = (s.deferralOtherTexts[other] || 0) + 1;
      if (s.recentDeferred.length < 10) {
        s.recentDeferred.push({
          donor_card_id: r.donor_card_id, donor_name: r.donor_name, donation_number: r.donation_number,
          donation_type: r.donation_type, group: group === 'Unknown' ? '' : group, created_at: created,
          eligibility: outcome, until: d.deferral_until || '',
          reasons: reasons.map(k => k === 'other' && other ? other : reasonLabel[k]),
        });
      }
    }

    const flags = reviewFlags(d);
    if (flags.length) {
      s.flaggedCards++;
      s.totalFlags += flags.length;
      if (s.recentFlagged.length < 10) {
        s.recentFlagged.push({
          donor_card_id: r.donor_card_id, donor_name: r.donor_name, donation_number: r.donation_number,
          donation_type: r.donation_type, group: group === 'Unknown' ? '' : group, created_at: created,
          flags: flags.map(f => qText[f] ? f.toUpperCase() : (VITAL_FLAG_LABELS[f] || f)),
        });
      }
    }
    flags.forEach(f => {
      const bucket = qText[f] ? s.questionFlags : s.vitalFlags;
      bucket[f] = (bucket[f] || 0) + 1;
    });
  });

  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  s.byGroup       = sortDesc(s.byGroup).map(([group, count]) => ({ group, count }));
  s.questionFlags = sortDesc(s.questionFlags).slice(0, 10).map(([key, count]) => ({ key, text: qText[key], count }));
  s.vitalFlags    = sortDesc(s.vitalFlags).map(([key, count]) => ({ key, label: VITAL_FLAG_LABELS[key] || key, count }));
  s.positives     = Object.values(s.positives);
  s.deferralReasons = Object.values(s.deferralReasons).filter(r => r.count).sort((a, b) => b.count - a.count);
  s.deferralOtherTexts = sortDesc(s.deferralOtherTexts).slice(0, 10).map(([text, count]) => ({ text, count }));
  return s;
}

// ════════════════════════════════════════════════════════════════
// DB migration — called from initDB() in server.js
// ════════════════════════════════════════════════════════════════
async function ensureDonorCardTable(pool) {
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='DonorCards')
      CREATE TABLE DonorCards (
        donor_card_id   INT IDENTITY(1,1) PRIMARY KEY,
        donation_number NVARCHAR(50)  NULL,
        donation_type   NVARCHAR(20)  NULL,
        donor_name      NVARCHAR(255) NULL,
        donor_number    NVARCHAR(50)  NULL,
        blood_group     NVARCHAR(5)   NULL,
        rh              NVARCHAR(10)  NULL,
        gender          NVARCHAR(10)  NULL,
        phone           NVARCHAR(50)  NULL,
        patient_name    NVARCHAR(255) NULL,
        flagged_count   INT           NOT NULL DEFAULT 0,
        data_json       NVARCHAR(MAX) NOT NULL,
        saved_by        NVARCHAR(100) NULL,
        created_at      DATETIME      DEFAULT GETDATE(),
        updated_at      DATETIME      NULL
      );
  `);
}

// ════════════════════════════════════════════════════════════════
// Routes
//   ctx = { getPool, getSql, isDbReady, requireAdmin }
// getPool/sql are (re)assigned inside server.js initDB(), so they are
// read through getters at request time rather than captured once.
// ════════════════════════════════════════════════════════════════
function registerDonorCardRoutes(app, ctx) {
  const { requireAdmin, isDbReady } = ctx;

  function bindColumns(request, d) {
    const sql = ctx.getSql();
    return request
      .input('donation_number', sql.NVarChar, str(d.donation_number, 50))
      .input('donation_type',   sql.NVarChar, str(d.donation_type, 20))
      .input('donor_name',      sql.NVarChar, str(d.donor_name, 255))
      .input('donor_number',    sql.NVarChar, str(d.donor_number, 50))
      .input('blood_group',     sql.NVarChar, str(d.blood_group, 5))
      .input('rh',              sql.NVarChar, str(d.rh, 10))
      .input('gender',          sql.NVarChar, str(d.gender, 10))
      .input('phone',           sql.NVarChar, str(d.phone, 50))
      .input('patient_name',    sql.NVarChar, str(d.patient_name, 255))
      .input('flagged_count',   sql.Int,      reviewFlags(d).length)
      .input('data_json',       sql.NVarChar(sql.MAX), JSON.stringify(d));
  }

  function rowToRecord(r) {
    let data = {};
    try { data = JSON.parse(r.data_json); } catch (e) { /* keep columns only */ }
    const { data_json, ...cols } = r;
    return { ...data, ...cols };
  }

  app.get('/donor-card/questions', requireAdmin, (req, res) => {
    res.json({ sections: SECTIONS, limits: LIMITS, consent: CONSENT_TEXT, positiveTests: POSITIVE_TESTS,
               deferralReasons: DEFERRAL_REASONS });
  });

  app.post('/donor-card/save', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Database not connected.' });
    const d = req.body || {};
    if (!d.donor_name) return res.status(400).json({ error: 'Donor name is required.' });
    try {
      const pool = await ctx.getPool();
      const sql  = ctx.getSql();
      const result = await bindColumns(pool.request(), d)
        .input('saved_by', sql.NVarChar, req.user?.fullName || null)
        .query(`INSERT INTO DonorCards (
            donation_number, donation_type, donor_name, donor_number, blood_group, rh,
            gender, phone, patient_name, flagged_count, data_json, saved_by
          ) OUTPUT INSERTED.donor_card_id VALUES (
            @donation_number, @donation_type, @donor_name, @donor_number, @blood_group, @rh,
            @gender, @phone, @patient_name, @flagged_count, @data_json, @saved_by
          )`);
      res.json({ success: true, id: result.recordset[0].donor_card_id });
    } catch (err) {
      console.error('Donor card save error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/donor-card', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.json([]);
    try {
      const pool = await ctx.getPool();
      const sql  = ctx.getSql();
      const q    = (req.query.q || '').trim();
      const request = pool.request();
      let where = '';
      if (q) {
        request.input('q', sql.NVarChar, `%${q}%`);
        where = `WHERE donor_name LIKE @q OR donation_number LIKE @q OR donor_number LIKE @q
                 OR phone LIKE @q OR patient_name LIKE @q`;
      }
      // List view only needs the columns — the full form is fetched by id.
      const result = await request.query(`
        SELECT TOP 50 donor_card_id, donation_number, donation_type, donor_name, donor_number,
               blood_group, rh, gender, phone, patient_name, flagged_count, saved_by,
               CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM DonorCards ${where} ORDER BY donor_card_id DESC`);
      res.json(result.recordset);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard aggregates. Answers/vitals live in data_json, so the
  // breakdowns are computed here with the same reviewFlags() the save
  // path uses — the dashboard can't disagree with the per-card badges.
  // Must stay above /donor-card/:id or "stats" is read as an id.
  app.get('/donor-card/stats', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Database not connected.' });
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 365);
    try {
      const pool = await ctx.getPool();
      const result = await pool.request().query(`
        SELECT donor_card_id, donation_number, donation_type, donor_name, blood_group, rh,
               gender, flagged_count, data_json,
               CONVERT(VARCHAR(19), created_at, 120) AS created_at
        FROM DonorCards ORDER BY donor_card_id DESC`);
      res.json(buildStats(result.recordset, days));
    } catch (err) {
      console.error('Donor card stats error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/donor-card/:id', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Database not connected.' });
    try {
      const pool = await ctx.getPool();
      const result = await pool.request()
        .input('id', ctx.getSql().Int, parseInt(req.params.id))
        .query('SELECT * FROM DonorCards WHERE donor_card_id=@id');
      if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
      res.json(rowToRecord(result.recordset[0]));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/donor-card/:id', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Database not connected.' });
    const d = req.body || {};
    if (!d.donor_name) return res.status(400).json({ error: 'Donor name is required.' });
    try {
      const pool = await ctx.getPool();
      await bindColumns(pool.request(), d)
        .input('id', ctx.getSql().Int, parseInt(req.params.id))
        .query(`UPDATE DonorCards SET
            donation_number=@donation_number, donation_type=@donation_type, donor_name=@donor_name,
            donor_number=@donor_number, blood_group=@blood_group, rh=@rh, gender=@gender,
            phone=@phone, patient_name=@patient_name, flagged_count=@flagged_count,
            data_json=@data_json, updated_at=GETDATE()
          WHERE donor_card_id=@id`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/donor-card/:id', requireAdmin, async (req, res) => {
    if (!isDbReady()) return res.json({ success: false });
    try {
      const pool = await ctx.getPool();
      await pool.request()
        .input('id', ctx.getSql().Int, parseInt(req.params.id))
        .query('DELETE FROM DonorCards WHERE donor_card_id=@id');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/donor-card/export/:type', requireAdmin, async (req, res) => {
    const type = req.params.type;
    if (type !== 'pdf' && type !== 'docx') return res.status(400).json({ error: 'Unknown export type' });
    try {
      const d = req.body || {};
      const buffer = type === 'pdf' ? await generateDonorCardPdf(d) : await generateDonorCardDocx(d);
      res.setHeader('Content-Type', type === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="donor_card_${Date.now()}.${type}"`);
      res.send(buffer);
    } catch (err) {
      console.error('Donor card export error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

// ════════════════════════════════════════════════════════════════
// Display helpers for the exports
// ════════════════════════════════════════════════════════════════
const AR = {
  yes: 'نعم', no: 'كلا', male: 'ذكر', female: 'أنثى',
  blood: 'وحدة دم', platelet: 'بلاكيت',
};
function dateStr(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}
function dateTimeStr(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : dateStr(v);
}
function sigBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (e) { return null; }
}
function bloodGroupStr(d) { return [d.blood_group, d.rh].filter(Boolean).join(' '); }

// ════════════════════════════════════════════════════════════════
// PDF — Arabic support
//
// PDFKit (via fontkit) shapes Arabic letters correctly but lays words out
// left-to-right and reverses digit runs inside Arabic words. So Arabic
// lines are laid out here instead: wrap in logical order, split each line
// into right-to-left and left-to-right runs, and place each run manually
// starting from the right edge.
// ════════════════════════════════════════════════════════════════
const FONT_CANDIDATES = {
  regular: [
    process.env.ARABIC_FONT_PATH,
    'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/tahoma.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf',
    '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf',
  ],
  bold: [
    process.env.ARABIC_FONT_BOLD_PATH,
    'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/tahomabd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ],
};
function findFont(list) { return list.find(p => p && fs.existsSync(p)) || null; }

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR = /[A-Za-z0-9\u00C0-\u024F\u00B5]/;
const MIRROR   = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<' };

// Split a logical-order line into direction runs. Neutral characters
// (spaces, punctuation) take LTR only when sandwiched between LTR text,
// e.g. the space in "Hepatitis B" or the "." in "200.000"; otherwise they
// follow the paragraph's RTL direction.
function bidiRuns(text) {
  const chars = [...text];
  const cls = chars.map(c => RTL_CHAR.test(c) ? 'R' : LTR_CHAR.test(c) ? 'L' : 'N');
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 'N') continue;
    let j = i; while (j < cls.length && cls[j] === 'N') j++;
    const prev = i > 0 ? cls[i - 1] : 'R';
    const next = j < cls.length ? cls[j] : 'R';
    const dir  = prev === 'L' && next === 'L' ? 'L' : 'R';
    for (let k = i; k < j; k++) cls[k] = dir === 'L' ? 'l' : 'r';
    i = j - 1;
  }
  const runs = [];
  chars.forEach((c, i) => {
    const rtl = cls[i] === 'R' || cls[i] === 'r';
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.text += c; else runs.push({ text: c, rtl });
  });
  return runs;
}

// Visual pieces of one line, each with its text and width, in right-to-left
// placement order. RTL runs are split per word (and neutral chars mirrored)
// so fontkit never sees more than one word of Arabic at a time.
function rtlPieces(doc, line) {
  const pieces = [];
  bidiRuns(line).forEach(run => {
    if (!run.rtl) { pieces.push({ text: run.text, w: doc.widthOfString(run.text) }); return; }
    run.text.split(/( +)/).forEach(tok => {
      if (!tok) return;
      if (/^ +$/.test(tok)) { pieces.push({ text: '', w: doc.widthOfString(tok) }); return; }
      let chars = [...tok].map(c => MIRROR[c] || c);
      // fontkit reverses tokens containing Arabic letters itself; a token of
      // only punctuation (e.g. "):") is laid out LTR, so reverse it here.
      if (!RTL_CHAR.test(tok)) chars = chars.reverse();
      const t = chars.join('');
      pieces.push({ text: t, w: doc.widthOfString(t) });
    });
  });
  return pieces;
}

// Greedy word wrap in logical order.
function wrapLogical(doc, text, width) {
  const lines = [];
  String(text).split('\n').forEach(para => {
    let cur = '';
    para.split(/ +/).forEach(word => {
      const trial = cur ? cur + ' ' + word : word;
      if (cur && doc.widthOfString(trial) > width) { lines.push(cur); cur = word; }
      else cur = trial;
    });
    lines.push(cur);
  });
  return lines;
}

// ════════════════════════════════════════════════════════════════
// PDF
// ════════════════════════════════════════════════════════════════
function generateDonorCardPdf(d) {
  return new Promise((resolve, reject) => {
    const regular = findFont(FONT_CANDIDATES.regular);
    if (!regular) return reject(new Error('No Arabic-capable font found for the PDF. Set ARABIC_FONT_PATH to a .ttf that supports Arabic (e.g. Arial).'));
    const bold = findFont(FONT_CANDIDATES.bold) || regular;

    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
    doc.registerFont('ar', regular);
    doc.registerFont('arB', bold);

    const ML = 30, MR = 30, PW = 595.28, PH = 841.89;
    const W = PW - ML - MR, BOTTOM = PH - 40;
    const DK = '#1B2A3B', K = '#111', GREY = '#666', LINE = '#B0B8C4', SHADE = '#EEF1F5', RED = '#B42318';
    let y = 30;

    function setFont(b, sz, c) { doc.font(b ? 'arB' : 'ar').fontSize(sz).fillColor(c || K); }
    // Draw a single Arabic/mixed line right-aligned against `right`
    // (or centred between left/right when center=true).
    function rtlLine(line, left, right, ty, center) {
      const pieces = rtlPieces(doc, line);
      const total  = pieces.reduce((s, p) => s + p.w, 0);
      let x = center ? right - ((right - left) - total) / 2 : right;
      pieces.forEach(p => {
        x -= p.w;
        if (p.text) doc.text(p.text, x, ty, { lineBreak: false });
      });
    }
    // Wrapped Arabic paragraph; returns the height used.
    function rtlText(text, left, width, ty, opts = {}) {
      const { b = false, sz = 9, c = K, lh = sz * 1.45, center = false } = opts;
      setFont(b, sz, c);
      const lines = wrapLogical(doc, text, width);
      lines.forEach((ln, i) => rtlLine(ln, left, left + width, ty + i * lh, center));
      return lines.length * lh;
    }
    function rtlHeight(text, width, sz = 9, b = false) {
      setFont(b, sz);
      return wrapLogical(doc, text, width).length * sz * 1.45;
    }
    function ltr(text, x, ty, opts = {}) {
      const { b = false, sz = 8.5, c = K, w = 200 } = opts;
      setFont(b, sz, c);
      doc.text(String(text == null ? '' : text), x, ty, { width: w, lineBreak: false });
    }
    function ensure(h) {
      if (y + h > BOTTOM) { doc.addPage(); y = 30; return true; }
      return false;
    }
    function sectionBar(text, rtl) {
      ensure(22);
      doc.rect(ML, y, W, 15).fillColor(DK).fill();
      setFont(true, 8.5, 'white');
      if (rtl) rtlLine(text, ML + 4, ML + W - 6, y + 2.5);
      else doc.text(text, ML + 6, y + 3, { lineBreak: false });
      y += 15;
    }
    function sig(dataUrl, x, ty, w, h) {
      const buf = sigBuffer(dataUrl);
      if (!buf) return;
      try { doc.image(buf, x, ty, { fit: [w, h] }); } catch (e) { /* unreadable image */ }
    }

    // ── Header ──────────────────────────────────────────────────
    if (LOGO_BUF) { try { doc.image(LOGO_BUF, PW - MR - 50, y, { fit: [50, 50] }); } catch (e) {} }
    rtlText('بطاقة المتبرع', ML + 150, W - 300, y + 14, { b: true, sz: 16, center: true });
    doc.roundedRect(ML, y, 150, 50, 8).lineWidth(0.8).strokeColor(LINE).stroke();
    ltr('Donation Number', ML + 10, y + 8, { b: true, sz: 9, c: GREY, w: 130 });
    ltr(d.donation_number || '', ML + 10, y + 25, { b: true, sz: 13, w: 130 });
    y += 62;

    // ── Donor details (two RTL label/value columns) ─────────────
    const colW = W / 2;
    const info = [
      [['نوعية التطوع', AR[d.donation_type] || ''], ['Group / Rho', bloodGroupStr(d)]],
      [['إسم المتطوع', d.donor_name], ['تاريخ الولادة', dateStr(d.dob)]],
      [['الجنس', AR[d.gender] || ''], ['رقم المتبرع', d.donor_number]],
      [['الجنسية', d.nationality], ['رقم الهوية', d.id_number]],
      [['العنوان', d.address], ['تلفون', d.phone]],
      [['التبرع لصالح المريض', d.patient_name], ['صلة القرابة', d.relationship]],
    ];
    const infoTop = y;
    info.forEach(row => {
      row.forEach(([label, val], ci) => {
        // RTL: first column is on the right.
        const right = ML + W - ci * colW - 8;
        setFont(true, 9, DK);
        const lw = rtlPieces(doc, label + ':').reduce((s, p) => s + p.w, 0);
        rtlLine(label + ':', right - lw, right, y);
        setFont(false, 9.5, K);
        const v = String(val || '');
        const vRight = right - lw - 6;
        doc.moveTo(ML + (1 - ci) * colW + 8, y + 12).lineTo(vRight, y + 12).lineWidth(0.4).strokeColor(LINE).stroke();
        if (v) rtlLine(v, ML + (1 - ci) * colW + 8, vRight, y);
      });
      y += 19;
    });
    doc.roundedRect(ML, infoTop - 8, W, y - infoTop + 4, 8).lineWidth(0.8).strokeColor(LINE).stroke();
    y += 8;

    // ── Questionnaire ───────────────────────────────────────────
    const answers = d.answers || {}, notes = d.answer_notes || {};
    const ansW = 34, qW = W - ansW * 2;
    function tableHead() {
      doc.rect(ML, y, W, 16).fillColor(SHADE).fill();
      doc.rect(ML, y, W, 16).lineWidth(0.5).strokeColor(LINE).stroke();
      setFont(true, 9, DK);
      rtlLine('الأسئلة', ML + ansW * 2, ML + W, y + 3, true);
      rtlLine('نعم', ML + ansW, ML + ansW * 2, y + 3, true);
      rtlLine('كلا', ML, ML + ansW, y + 3, true);
      y += 16;
    }
    tableHead();
    SECTIONS.forEach(sec => {
      if (sec.only === 'platelet' && d.donation_type !== 'platelet') return;
      if (sec.title) {
        if (ensure(16 + 20)) tableHead();
        doc.rect(ML, y, W, 15).fillColor(SHADE).fill();
        doc.rect(ML, y, W, 15).lineWidth(0.5).strokeColor(LINE).stroke();
        setFont(true, 8.5, DK);
        rtlLine(sec.title, ML + 4, ML + W - 6, y + 3);
        y += 15;
      }
      sec.questions.forEach(q => {
        const applies = questionApplies(q, d);
        const indent  = q.sub ? 14 : 0;
        const textW   = qW - 14 - indent;
        const qText   = (q.sub ? '- ' : '• ') + q.text;
        const note    = q.detail && notes[q.key] ? notes[q.key] : '';
        const h = Math.max(16, rtlHeight(qText, textW) + (note ? rtlHeight(note, textW, 8.5) : 0) + 5);
        if (ensure(h)) tableHead();
        const a = applies ? answers[q.key] : null;
        const flagged = applies && q.flagIf && a === q.flagIf;
        if (flagged) doc.rect(ML, y, W, h).fillColor('#FDECEA').fill();
        doc.rect(ML, y, W, h).lineWidth(0.5).strokeColor(LINE).stroke();
        doc.moveTo(ML + ansW, y).lineTo(ML + ansW, y + h).stroke();
        doc.moveTo(ML + ansW * 2, y).lineTo(ML + ansW * 2, y + h).stroke();
        let ty = y + 3;
        ty += rtlText(qText, ML + ansW * 2 + 6, textW, ty, { c: applies ? K : '#999' });
        if (note) rtlText(note, ML + ansW * 2 + 6, textW, ty, { sz: 8.5, c: '#1A5276' });
        const markY = y + h / 2 - 5;
        if (!applies) {
          ltr('N/A', ML + 3, markY, { sz: 7, c: '#999', w: ansW * 2 - 6 });
        } else if (a === 'yes' || a === 'no') {
          const x = a === 'yes' ? ML + ansW : ML;
          ltr('X', x + ansW / 2 - 3, markY, { b: true, sz: 10, c: flagged ? RED : K, w: 12 });
        }
        y += h;
      });
    });
    y += 10;

    // ── Physical Examination / Laboratory Data (English, as on paper) ─
    const L = LIMITS;
    function kv(label, val, x, ty, w, warn) {
      setFont(true, 8, DK);
      doc.text(label, x, ty, { lineBreak: false });
      const lw = doc.widthOfString(label) + 4;
      setFont(false, 9, warn ? RED : K);
      doc.text(String(val || ''), x + lw, ty - 0.5, { width: w - lw, lineBreak: false });
      doc.moveTo(x + lw, ty + 10).lineTo(x + w - 6, ty + 10).lineWidth(0.4).strokeColor(LINE).stroke();
    }
    const flags = new Set(reviewFlags(d));
    ensure(15 + 19 * 3 + 15 + 19 * 4 + 10);
    sectionBar('Physical Examination:');
    y += 6;
    const third = W / 3;
    kv('General Appearance', d.exam_general_appearance, ML + 4, y, third);
    kv(`Weight (Min. ${L.weight_min} Kg)`, d.exam_weight, ML + 4 + third, y, third, flags.has('weight'));
    kv(`Temp (Max. ${L.temp_max} °C)`, d.exam_temp, ML + 4 + third * 2, y, third, flags.has('temp'));
    y += 19;
    const bp = [d.exam_bp_sys, d.exam_bp_dia].filter(Boolean).join(' / ');
    kv('Blood Pressure (Sys >90 <160, Dia 50-100)', bp, ML + 4, y, third * 2, flags.has('bp_sys') || flags.has('bp_dia'));
    kv(`Pulse (${L.pulse_min}-${L.pulse_max}/Min.)`, d.exam_pulse, ML + 4 + third * 2, y, third, flags.has('pulse'));
    y += 19;
    const yn = v => v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '';
    kv('Needle Marks On Arms:', yn(d.exam_needle_marks), ML + 4, y, W / 2, flags.has('needle_marks'));
    kv('Skin Lesions:', yn(d.exam_skin_lesions), ML + 4 + W / 2, y, W / 2, flags.has('skin_lesions'));
    y += 19;

    sectionBar('Laboratory Data:');
    y += 6;
    kv('Lot number of blood bag or platelet set:', d.lab_lot_number, ML + 4, y, W - 8);
    y += 19;
    const hbLabel = d.gender === 'female'
      ? `Hemoglobin / Hematocrit (Min. Fem. ${L.hb_min_female} / ${L.hct_min_female}%)`
      : d.gender === 'male'
        ? `Hemoglobin / Hematocrit (Min. Male ${L.hb_min_male} / ${L.hct_min_male}%)`
        : `Hemoglobin / Hematocrit (Min. Fem. ${L.hb_min_female}/${L.hct_min_female}%, Male ${L.hb_min_male}/${L.hct_min_male}%)`;
    const hbVal = [d.lab_hb, d.lab_hct ? d.lab_hct + '%' : ''].filter(Boolean).join(' / ');
    kv(hbLabel, hbVal, ML + 4, y, W - 8, flags.has('hb') || flags.has('hct'));
    y += 19;
    if (d.donation_type === 'platelet') {
      kv('For platelet donor:  WBC (/mm3)', d.lab_wbc, ML + 4, y, W / 2);
      kv('plt count (/mm3)', d.lab_plt_count, ML + 4 + W / 2, y, W / 2);
      y += 19;
    }
    kv('Phlebotomy by:', d.phlebotomy_by, ML + 4, y, third);
    kv('Date:', dateStr(d.phlebotomy_date), ML + 4 + third, y, third * 0.7);
    setFont(true, 8, DK);
    doc.text('Technician Signature:', ML + 4 + third * 1.7, y, { lineBreak: false });
    sig(d.technician_signature, ML + third * 1.7 + 100, y - 12, 90, 30);
    y += 28;

    // ── Consent ─────────────────────────────────────────────────
    const consent = [`أنا الموقع أدناه ${d.consent_name || '……………………'} ` + CONSENT_TEXT[0].replace('أنا الموقع أدناه ', ''), CONSENT_TEXT[1]];
    const consentH = consent.reduce((s, t) => s + rtlHeight('• ' + t, W - 20) + 4, 0) + 100;
    ensure(consentH);
    const cTop = y;
    y += 8;
    consent.forEach(t => { y += rtlText('• ' + t, ML + 10, W - 20, y, { b: true, sz: 9 }) + 4; });
    y += 6;
    // Signature row 1 (RTL: donor signature on the right)
    const c3 = W / 3;
    function arLabel(label, rightX, ty) { setFont(true, 8.5, DK); rtlLine(label, rightX - 150, rightX, ty); return rtlPieces(doc, label).reduce((s, p) => s + p.w, 0); }
    let lw = arLabel('توقيع المتبرع:', ML + W - 6, y);
    sig(d.donor_signature, ML + W - 6 - lw - 96, y - 12, 90, 30);
    lw = arLabel('تاريخ ووقت سحب الدم:', ML + c3 * 2 - 6, y);
    ltr(dateTimeStr(d.collection_datetime), ML + c3 + 4, y, { sz: 9, w: c3 - lw - 14 });
    lw = arLabel('كمية الدم والبلاكيت المسحوبة:', ML + c3 - 6, y);
    ltr(d.collected_quantity || '', ML + 4, y, { sz: 9, w: c3 - lw - 14 });
    y += 30;
    lw = arLabel('اسم الموظف الذي سحب وحدة الدم والعينة:', ML + W - 6, y);
    setFont(false, 9.5);
    if (d.staff_name) rtlLine(d.staff_name, ML + W / 2, ML + W - 12 - lw, y);
    lw = arLabel('التوقيع:', ML + W / 2 - 6, y);
    sig(d.staff_signature, ML + W / 2 - 6 - lw - 96, y - 12, 90, 30);
    y += 26;
    doc.roundedRect(ML, cTop, W, y - cTop, 8).lineWidth(0.8).strokeColor(LINE).stroke();
    y += 12;

    // ── Lab administration (page 4) ─────────────────────────────
    ensure(250);
    sectionBar('خاص إدارة المختبر:', true);
    y += 6;
    setFont(true, 9, DK);
    rtlLine('النتائج الإيجابية لفحوصات العدوى:', ML, ML + W - 6, y);
    y += 18;
    // Checkbox row, laid out right-to-left like the paper form.
    setFont(true, 9, DK);
    let bx = ML + W - 6;
    const lbl = 'الفحص الإيجابي:';
    const lblW = rtlPieces(doc, lbl).reduce((s, p) => s + p.w, 0);
    rtlLine(lbl, bx - lblW, bx, y);
    bx -= lblW + 12;
    POSITIVE_TESTS.forEach(t => {
      setFont(true, 8.5, K);
      const tw = doc.widthOfString(t.label);
      doc.rect(bx - 10, y, 9, 9).lineWidth(0.6).strokeColor(K).stroke();
      if (d[t.key]) { setFont(true, 9, RED); doc.text('X', bx - 8.5, y - 0.5, { lineBreak: false }); setFont(true, 8.5, K); }
      doc.text(t.label, bx - 14 - tw, y, { lineBreak: false });
      bx -= tw + 26;
    });
    y += 20;
    [1, 2, 3].forEach(n => {
      lw = arLabel(`تاريخ ووقت الإتصال (${n}):`, ML + W - 6, y);
      ltr(dateTimeStr(d[`contact${n}_datetime`]), ML + W - lw - 160, y, { sz: 9, w: 140 });
      y += 16;
      lw = arLabel('نتيجة الإتصال:', ML + W - 6, y);
      setFont(false, 9.5);
      if (d[`contact${n}_result`]) rtlLine(d[`contact${n}_result`], ML, ML + W - 12 - lw, y);
      doc.moveTo(ML + 6, y + 12).lineTo(ML + W - 12 - lw, y + 12).lineWidth(0.4).strokeColor(LINE).stroke();
      y += 20;
    });
    lw = arLabel('ملاحظات:', ML + W - 6, y);
    const notesH = d.lab_notes ? rtlText(d.lab_notes, ML + 6, W - lw - 20, y, { sz: 9.5 }) : 14;
    y += Math.max(notesH, 14) + 10;
    lw = arLabel('الإسم:', ML + W - 6, y);
    setFont(false, 9.5);
    if (d.lab_reviewer_name) rtlLine(d.lab_reviewer_name, ML + c3 * 2, ML + W - 12 - lw, y);
    lw = arLabel('التوقيع:', ML + c3 * 2 - 6, y);
    sig(d.lab_reviewer_signature, ML + c3 * 2 - 6 - lw - 96, y - 12, 90, 30);
    lw = arLabel('التاريخ:', ML + c3 - 6, y);
    ltr(dateStr(d.lab_reviewer_date), ML + 6, y, { sz: 9, w: c3 - lw - 16 });
    y += 26;

    // ── Footer on every page ────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      ltr(FORM_CODE, ML, PH - 26, { b: true, sz: 7.5, c: GREY, w: 120 });
      setFont(true, 7.5, GREY);
      doc.text(`${i + 1}/${range.count}`, ML, PH - 26, { width: W, align: 'center', lineBreak: false });
      doc.text('Apd: 03/06/2023', ML, PH - 26, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════
// DOCX — Word does its own bidi, so runs just need rightToLeft and
// the paragraphs/tables need bidirectional / visuallyRightToLeft.
// ════════════════════════════════════════════════════════════════
async function generateDonorCardDocx(d) {
  const FONT = 'Arial';
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B0B8C4' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const shade = { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF1F5' };
  const flagShade = { type: ShadingType.CLEAR, color: 'auto', fill: 'FDECEA' };

  const run = (text, o = {}) => new TextRun({
    text: String(text == null ? '' : text), font: FONT,
    size: o.size || 18, bold: !!o.bold, boldComplexScript: !!o.bold,
    color: o.color, rightToLeft: o.ltr ? false : true,
  });
  const arP = (children, o = {}) => new Paragraph({
    bidirectional: true, alignment: o.center ? AlignmentType.CENTER : undefined,
    spacing: { before: o.before || 0, after: o.after || 40 },
    children: Array.isArray(children) ? children : [children],
  });
  const enP = (children, o = {}) => new Paragraph({
    alignment: o.center ? AlignmentType.CENTER : undefined,
    spacing: { before: o.before || 0, after: o.after || 40 },
    children: Array.isArray(children) ? children : [children],
  });
  const cell = (children, o = {}) => new TableCell({
    children: Array.isArray(children) ? children : [children],
    width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
    columnSpan: o.span, shading: o.shade, borders,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
  const sigRun = (dataUrl) => {
    const buf = sigBuffer(dataUrl);
    return buf ? new ImageRun({ data: buf, transformation: { width: 110, height: 36 }, type: 'png' }) : run('');
  };
  // Word applies its own bidi to the paragraph, which flips number-only
  // values ("05/11/2026" -> "2026/11/05", "03 123 456" -> "456 123 03").
  // An LTR embedding (LRE ... PDF) keeps them in reading order.
  const ltrVal = v => v ? '‪' + v + '‬' : '';
  const labelVal = (label, val, isLtr) => [run(label + ': ', { bold: true }), run(isLtr ? ltrVal(val) : (val || ''), { ltr: isLtr })];

  const children = [];

  // Header
  children.push(new Table({
    width: { size: 10200, type: WidthType.DXA },
    visuallyRightToLeft: true,
    rows: [new TableRow({ children: [
      cell(arP(LOGO_BUF ? [new ImageRun({ data: LOGO_BUF, transformation: { width: 55, height: 55 }, type: 'png' })] : [run('')]), { width: 2000 }),
      cell(arP(run('بطاقة المتبرع', { bold: true, size: 32 }), { center: true }), { width: 5200 }),
      cell([enP(run('Donation Number', { bold: true, ltr: true, size: 18, color: '666666' })),
            enP(run(d.donation_number || '', { bold: true, ltr: true, size: 26 }))], { width: 3000 }),
    ]})],
  }));
  children.push(enP(run(''), { after: 80 }));

  // Donor details
  const info = [
    [['نوعية التطوع', AR[d.donation_type]], ['Group / Rho', bloodGroupStr(d)]],
    [['إسم المتطوع', d.donor_name], ['تاريخ الولادة', dateStr(d.dob), true]],
    [['الجنس', AR[d.gender]], ['رقم المتبرع', d.donor_number, true]],
    [['الجنسية', d.nationality], ['رقم الهوية', d.id_number, true]],
    [['العنوان', d.address], ['تلفون', d.phone, true]],
    [['التبرع لصالح المريض', d.patient_name], ['صلة القرابة', d.relationship]],
  ];
  children.push(new Table({
    width: { size: 10200, type: WidthType.DXA }, visuallyRightToLeft: true,
    rows: info.map(r => new TableRow({ children: r.map(([l, v, isLtr]) => cell(arP(labelVal(l, v, isLtr)), { width: 5100 })) })),
  }));
  children.push(enP(run(''), { after: 80 }));

  // Questionnaire
  const answers = d.answers || {}, notes = d.answer_notes || {};
  const qRows = [new TableRow({ tableHeader: true, children: [
    cell(arP(run('الأسئلة', { bold: true }), { center: true }), { width: 8800, shade }),
    cell(arP(run('نعم', { bold: true }), { center: true }), { width: 700, shade }),
    cell(arP(run('كلا', { bold: true }), { center: true }), { width: 700, shade }),
  ]})];
  SECTIONS.forEach(sec => {
    if (sec.only === 'platelet' && d.donation_type !== 'platelet') return;
    if (sec.title) qRows.push(new TableRow({ children: [cell(arP(run(sec.title, { bold: true })), { span: 3, shade })] }));
    sec.questions.forEach(q => {
      const applies = questionApplies(q, d);
      const a = applies ? answers[q.key] : null;
      const flagged = applies && q.flagIf && a === q.flagIf;
      const qParas = [arP(run((q.sub ? '    - ' : '• ') + q.text, { color: applies ? undefined : '999999' }))];
      if (q.detail && notes[q.key]) qParas.push(arP(run(notes[q.key], { color: '1A5276' })));
      const mark = (v) => !applies ? run('N/A', { ltr: true, size: 14, color: '999999' })
        : run(a === v ? 'X' : '', { bold: true, ltr: true, color: flagged ? 'B42318' : undefined });
      qRows.push(new TableRow({ children: [
        cell(qParas, { width: 8800, shade: flagged ? flagShade : undefined }),
        cell(enP(mark('yes'), { center: true }), { width: 700, shade: flagged ? flagShade : undefined }),
        cell(enP(mark('no'),  { center: true }), { width: 700, shade: flagged ? flagShade : undefined }),
      ]}));
    });
  });
  children.push(new Table({ width: { size: 10200, type: WidthType.DXA }, visuallyRightToLeft: true, rows: qRows }));
  children.push(enP(run(''), { after: 80 }));

  // Physical Examination / Laboratory Data (English)
  const L = LIMITS;
  const flags = new Set(reviewFlags(d));
  const en = (label, val, warn) => enP([run(label + ' ', { bold: true, ltr: true }), run(val || '', { ltr: true, color: warn ? 'B42318' : undefined })]);
  const yn = v => v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '';
  const examRows = [
    [cell(enP(run('Physical Examination:', { bold: true, ltr: true })), { span: 3, shade })],
    [cell(en('General Appearance:', d.exam_general_appearance), { width: 3400 }),
     cell(en(`Weight (Min. ${L.weight_min} Kg):`, d.exam_weight, flags.has('weight')), { width: 3400 }),
     cell(en(`Temp (Max. ${L.temp_max} °C):`, d.exam_temp, flags.has('temp')), { width: 3400 })],
    [cell(en('Blood Pressure (Sys >90 <160, Dia 50-100):', [d.exam_bp_sys, d.exam_bp_dia].filter(Boolean).join(' / '), flags.has('bp_sys') || flags.has('bp_dia')), { span: 2 }),
     cell(en(`Pulse (${L.pulse_min}-${L.pulse_max}/Min.):`, d.exam_pulse, flags.has('pulse')), { width: 3400 })],
    [cell(en('Needle Marks On Arms:', yn(d.exam_needle_marks), flags.has('needle_marks')), { span: 2 }),
     cell(en('Skin Lesions:', yn(d.exam_skin_lesions), flags.has('skin_lesions')), { width: 3400 })],
    [cell(enP(run('Laboratory Data:', { bold: true, ltr: true })), { span: 3, shade })],
    [cell(en('Lot number of blood bag or platelet set:', d.lab_lot_number), { span: 3 })],
    [cell(en(`Hemoglobin / Hematocrit (Min. Fem. ${L.hb_min_female}/${L.hct_min_female}%, Male ${L.hb_min_male}/${L.hct_min_male}%):`,
        [d.lab_hb, d.lab_hct ? d.lab_hct + '%' : ''].filter(Boolean).join(' / '), flags.has('hb') || flags.has('hct')), { span: 3 })],
  ];
  if (d.donation_type === 'platelet') {
    examRows.push([cell(en('For platelet donor: WBC (/mm3):', d.lab_wbc), { span: 2 }), cell(en('plt count (/mm3):', d.lab_plt_count), { width: 3400 })]);
  }
  examRows.push([
    cell(en('Phlebotomy by:', d.phlebotomy_by), { width: 3400 }),
    cell(en('Date:', dateStr(d.phlebotomy_date)), { width: 3400 }),
    cell(enP([run('Technician Signature: ', { bold: true, ltr: true }), sigRun(d.technician_signature)]), { width: 3400 }),
  ]);
  children.push(new Table({ width: { size: 10200, type: WidthType.DXA }, rows: examRows.map(c => new TableRow({ children: c })) }));
  children.push(enP(run(''), { after: 80 }));

  // Consent
  const consent0 = `أنا الموقع أدناه ${d.consent_name || '……………………'} ` + CONSENT_TEXT[0].replace('أنا الموقع أدناه ', '');
  children.push(new Table({
    width: { size: 10200, type: WidthType.DXA }, visuallyRightToLeft: true,
    rows: [
      new TableRow({ children: [cell([arP(run('• ' + consent0, { bold: true })), arP(run('• ' + CONSENT_TEXT[1], { bold: true }))], { span: 3 })] }),
      new TableRow({ children: [
        cell(arP([run('توقيع المتبرع: ', { bold: true }), sigRun(d.donor_signature)]), { width: 3400 }),
        cell(arP(labelVal('تاريخ ووقت سحب الدم', dateTimeStr(d.collection_datetime), true)), { width: 3400 }),
        cell(arP(labelVal('كمية الدم والبلاكيت المسحوبة', d.collected_quantity, true)), { width: 3400 }),
      ]}),
      new TableRow({ children: [
        cell(arP(labelVal('اسم الموظف الذي سحب وحدة الدم والعينة', d.staff_name)), { span: 2 }),
        cell(arP([run('التوقيع: ', { bold: true }), sigRun(d.staff_signature)]), { width: 3400 }),
      ]}),
    ],
  }));
  children.push(enP(run(''), { after: 80 }));

  // Lab administration
  const posLine = POSITIVE_TESTS.map(t => `${d[t.key] ? '☒' : '☐'} ${t.label}`).join('    ');
  const labRows = [
    [cell(arP(run('خاص إدارة المختبر:', { bold: true })), { span: 3, shade })],
    [cell([arP(run('النتائج الإيجابية لفحوصات العدوى:', { bold: true })),
           arP([run('الفحص الإيجابي: ', { bold: true }), run(posLine, { ltr: true })])], { span: 3 })],
  ];
  [1, 2, 3].forEach(n => {
    labRows.push([
      cell(arP(labelVal(`تاريخ ووقت الإتصال (${n})`, dateTimeStr(d[`contact${n}_datetime`]), true)), { width: 3400 }),
      cell(arP(labelVal('نتيجة الإتصال', d[`contact${n}_result`])), { span: 2 }),
    ]);
  });
  labRows.push([cell(arP(labelVal('ملاحظات', d.lab_notes)), { span: 3 })]);
  labRows.push([
    cell(arP(labelVal('الإسم', d.lab_reviewer_name)), { width: 3400 }),
    cell(arP([run('التوقيع: ', { bold: true }), sigRun(d.lab_reviewer_signature)]), { width: 3400 }),
    cell(arP(labelVal('التاريخ', dateStr(d.lab_reviewer_date), true)), { width: 3400 }),
  ]);
  children.push(new Table({ width: { size: 10200, type: WidthType.DXA }, visuallyRightToLeft: true, rows: labRows.map(c => new TableRow({ children: c })) }));
  children.push(enP(run(`${FORM_CODE}    ·    Apd: 03/06/2023`, { ltr: true, size: 14, color: '666666' }), { before: 120 }));

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 700, bottom: 700, left: 850, right: 850 } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = {
  ensureDonorCardTable, registerDonorCardRoutes,
  generateDonorCardPdf, generateDonorCardDocx,
  SECTIONS, LIMITS, reviewFlags, buildStats,
};
