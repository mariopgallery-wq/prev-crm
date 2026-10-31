export const CATEGORIES = [
  'Impianto elettrico',
  'Climatizzazione',
  'Impianto idraulico',
  'Antifurto',
  'Videosorveglianza',
  'Fotovoltaico',
];

export const DEFAULT_SETTINGS = {
  name: 'CHIARADIA IMPIANTI',
  contact: 'Di Filippo Chiaradia',
  address: 'C.da graviglione 9',
  city: '70024 – Gravina in Puglia (BA)',
  vat: '08623720722',
  pec: 'chiaradiafilippo@pec.it',
  phone: '3395046509',
  email: 'filippochiaradia@hotmail.it',
  defaultVat: 10,
  payment: '',
  logoData: '',
};


export function dashboardGreeting(date = new Date()) {
  const hour = date instanceof Date ? date.getHours() : new Date(date).getHours();
  if (hour >= 4 && hour < 15) return 'Buongiorno';
  if (hour >= 15 && hour < 20) return 'Buon pomeriggio';
  return 'Buonasera';
}

export function defaultDb() {
  return { quotes: [], items: [], clients: [], trash: [], settings: { ...DEFAULT_SETTINGS, categoryTemplates: {} } };
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function normalizeDb(value) {
  const d = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = { ...DEFAULT_SETTINGS, categoryTemplates: {}, ...(d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings) ? d.settings : {}) };
  if (String(settings.payment || '').trim() === '70% a conferma lavoro\n30% a completamento') settings.payment = '';
  if (!settings.categoryTemplates || typeof settings.categoryTemplates !== 'object' || Array.isArray(settings.categoryTemplates)) settings.categoryTemplates = {};
  const quotes = Array.isArray(d.quotes) ? d.quotes.filter(q => q && typeof q === 'object' && !Array.isArray(q)).map((q, index) => {
    const net = Math.max(0, Number(q.net) || 0);
    const vatRate = Math.min(100, Math.max(0, Number(q.vatRate ?? settings.defaultVat) || 0));
    const vat = Math.round((net * vatRate / 100 + Number.EPSILON) * 100) / 100;
    return {
      ...q,
      id: q.id || `legacy-quote-${index}-${String(q.number || q.date || 'document')}`,
      number: String(q.number || ''), date: String(q.date || todayISO()),
      category: CATEGORIES.includes(q.category) ? q.category : CATEGORIES[0],
      status: String(q.status || 'Bozza'), client: String(q.client || ''),
      address: String(q.address || ''), tax: String(q.tax || ''), place: String(q.place || ''),
      phone: String(q.phone || ''), email: String(q.email || ''), pec: String(q.pec || ''),
      title: ['Preventivo per fornitura e posa in opera di', 'Preventivo per fornitura e posa in opera'].includes(String(q.title || '').trim()) ? '' : String(q.title || ''),
      subtitle: String(q.subtitle || ''), intro: String(q.intro || '').trim() === 'Si precisa quanto segue:' ? '' : String(q.intro || ''), closing: String(q.closing || ''),
      payment: String(q.payment ?? settings.payment ?? DEFAULT_SETTINGS.payment),
      lines: Array.isArray(q.lines) ? q.lines.filter(line => line && typeof line === 'object' && !Array.isArray(line)).map((line, lineIndex) => ({
        ...line, id: line.id || `legacy-line-${index}-${lineIndex}`, desc: String(line.desc || ''), showPrice: line.showPrice === true,
      })) : [],
      net, vatRate,
      vat: Number.isFinite(Number(q.vat)) && q.vat !== undefined ? Number(q.vat) : vat,
      total: Number.isFinite(Number(q.total)) && q.total !== undefined ? Number(q.total) : Math.round((net + vat + Number.EPSILON) * 100) / 100,
      updated: String(q.updated || q.date || ''),
    };
  }) : [];
  const items = Array.isArray(d.items) ? d.items.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map((item, index) => ({
    ...item, id: item.id || `legacy-item-${index}`, cat: CATEGORIES.includes(item.cat) ? item.cat : CATEGORIES[0], desc: String(item.desc || ''),
  })) : [];
  const clients = Array.isArray(d.clients) ? d.clients.filter(client => client && typeof client === 'object' && !Array.isArray(client)).map(client => ({
    ...client, name: String(client.name || ''), address: String(client.address || ''), tax: String(client.tax || ''), place: String(client.place || ''),
    phone: String(client.phone || ''), email: String(client.email || ''), pec: String(client.pec || ''),
  })).filter(client => client.name.trim()) : [];
  const defaultVat = Math.min(100, Math.max(0, Number(settings.defaultVat) || 0));
  const trash = Array.isArray(d.trash) ? d.trash.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && ['quote', 'client', 'catalog'].includes(entry.type) && entry.data && typeof entry.data === 'object').map((entry, index) => ({ ...entry, id: String(entry.id || `trash-${index}`), type: entry.type, label: String(entry.label || entry.data.number || entry.data.name || entry.data.desc || 'Elemento eliminato'), deletedAt: String(entry.deletedAt || '') })) : [];
  return { quotes, items, clients, trash, settings: { ...settings, defaultVat } };
}

export function quoteNumber(quotes = []) {
  const year = String(new Date().getFullYear()).slice(-2);
  const sameYear = (Array.isArray(quotes) ? quotes : []).map(q => String(q?.number || '')).filter(n => n.endsWith(`.${year}`));
  const used = sameYear.map(n => Number(n.match(/^P\s*(\d+)/i)?.[1] || 0));
  return `P ${String(Math.max(0, ...used) + 1).padStart(2, '0')}.${year}`;
}

export function newDraft(db = defaultDb()) {
  const settings = db?.settings || DEFAULT_SETTINGS;
  return {
    id: null, number: quoteNumber(db?.quotes), date: todayISO(), category: CATEGORIES[0],
    status: 'Bozza', payment: settings.payment || '',
    client: '', address: '', tax: '', place: '', phone: '', email: '', pec: '',
    title: '',
    subtitle: '', intro: '',
    lines: [{ id: `l${Date.now()}`, desc: '', internalPrice: null, showPrice: false }],
    closing: '', net: 0, vatRate: Number(settings.defaultVat ?? DEFAULT_SETTINGS.defaultVat),
  };
}

export function calcTotal(draft = {}) {
  const net = Math.round((Math.max(0, Number(draft?.net) || 0) + Number.EPSILON) * 100) / 100;
  const rate = Math.min(100, Math.max(0, Number(draft?.vatRate) || 0));
  const vat = Math.round((net * rate / 100 + Number.EPSILON) * 100) / 100;
  return { net, vat, rate, total: Math.round((net + vat + Number.EPSILON) * 100) / 100 };
}

export function money(value) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('it-IT').format(date);
}

export function escapeName(value) {
  return String(value || '').trim().toLowerCase();
}
