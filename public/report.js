import { FIELDS, STEPS } from './form-schema.js';

const $ = selector => document.querySelector(selector);
const statuses = { active: 'Aktif / baru berinteraksi', away: 'Meninggalkan halaman', dropoff: 'Drop-off (perkiraan)', completed: 'Selesai', restarted: 'Mulai ulang' };
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
let selected;
let loading = false;

function row(values, numberFrom = Infinity) {
  const tr = el('tr');
  values.forEach((value, index) => { const td = el('td'); if (value instanceof Node) td.append(value); else td.textContent = value; if (index >= numberFrom) td.className = 'number'; tr.append(td); });
  return tr;
}

function timeline(journey, focus = false) {
  selected = journey.id;
  $('#timeline').hidden = false;
  $('#timeline-title').textContent = 'Urutan journey ' + journey.id.slice(0, 8);
  $('#timeline-events').replaceChildren(...journey.timeline.map(event => {
    const li = el('li');
    li.append(el('strong', '#' + event.properties.sequence + ' ' + event.name));
    li.append(el('span', new Date(event.at).toLocaleTimeString('id-ID')));
    li.append(el('pre', JSON.stringify(event.properties, null, 2)));
    return li;
  }));
  if (focus) $('#timeline-title').focus();
}

function render(report) {
  $('#empty').hidden = report.totals.journeys !== 0;
  $('#results').hidden = report.totals.journeys === 0;
  const metrics = [['Perjalanan', report.totals.journeys], ['Mulai mengisi', report.totals.started], ['Kode ditampilkan', report.totals.completed], ['Drop-off (perkiraan)', report.totals.dropoffs]];
  $('#totals').replaceChildren(...metrics.map(([label, value]) => { const div = el('div'); div.append(el('dt', label), el('dd', String(value))); return div; }));
  $('#step-rows').replaceChildren(...report.steps.map(s => row([s.title, s.viewed, s.attempted, s.continued, s.viewed ? Math.round(s.continued / s.viewed * 100) + '%' : 'Belum ada', s.dropoffs], 1)));
  $('#outcome-rows').replaceChildren(...report.outcomes.map(s => row([s.name, s.events, s.journeys], 1)));
  $('#failure-rows').replaceChildren(...report.failures.map(s => row([s.code, s.events, s.journeys], 1)));
  $('#field-rows').replaceChildren(...report.fields.map(f => row([f.id + ' · ' + (f.id === 'terms' ? 'Pernyataan simulasi' : f.label), f.hovered, f.focused, f.typed, f.valid, f.errors, f.continued, f.lastAtDrop, (f.averageFocusMs / 1000).toFixed(1) + ' dtk'], 1)));
  $('#journey-rows').replaceChildren(...report.journeys.map(j => {
    const button = el('button', j.id.slice(0, 8)); button.className = 'secondary';
    button.setAttribute('aria-label', 'Lihat journey ' + j.id.slice(0, 8));
    button.addEventListener('click', () => timeline(j, true));
    return row([button, statuses[j.state], STEPS.find(s => s.id === j.step)?.title || j.step, j.lastField || 'Belum memilih kolom', new Date(j.lastActivity).toLocaleString('id-ID'), j.events]);
  }));
  const current = report.journeys.find(j => j.id === selected);
  if (current) timeline(current);
  $('#report-status').textContent = 'Diperbarui ' + new Date(report.generatedAt).toLocaleTimeString('id-ID') + ' · otomatis setiap 10 detik';
}

async function refresh() {
  if (loading) return;
  loading = true;
  $('#refresh').disabled = true;
  $('#report-status').textContent = 'Memuat event tersimpan…';
  try {
    const response = await fetch('/api/report');
    if (!response.ok) throw new Error('Report unavailable');
    render(await response.json());
    $('#report-error').hidden = true;
  } catch {
    $('#report-error').hidden = false;
    $('#report-status').textContent = 'Gagal diperbarui. Data sebelumnya mungkin belum terbaru.';
  } finally { loading = false; $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', refresh);
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
