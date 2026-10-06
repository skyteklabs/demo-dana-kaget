export const STEPS = [
  { id: 'email', title: 'Email', fields: ['email', 'turnstile'] },
  { id: 'verification', title: 'Verifikasi', fields: ['verification_code'] },
  { id: 'complete', title: 'Kode DANA', fields: [] },
];
export const FIELDS = {
  email: { label: 'Alamat email', type: 'email' },
  turnstile: { label: 'Verifikasi keamanan', type: 'captcha' },
  verification_code: { label: 'Kode verifikasi email', type: 'text' },
};
export function validateField(id, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'required';
  if (id === 'email' && (text.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(text))) return 'invalid_format';
  if (id === 'verification_code' && !/^\d{6}$/.test(text)) return 'invalid_format';
  return null;
}
