const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const API = `${API_BASE}/api`;
let accessToken = null;
let csrfToken = null;

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.message || 'The request could not be completed.');
  return payload.data;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return parseResponse(response);
}

async function getCsrfToken() {
  if (!csrfToken) {
    const result = await request('/auth/csrf');
    csrfToken = result.csrfToken;
  }
  return csrfToken;
}

export async function signIn({ email, password }) {
  const result = await request('/buyers/login', { method: 'POST', body: { email, password } });
  accessToken = result.accessToken;
  csrfToken = result.csrfToken;
  return result;
}

export async function registerCustomer({ company, fullName, email, phone, password, confirmPassword }) {
  const result = await request('/buyers/signup', {
    method: 'POST',
    body: { companyName: company, fullName, email, phone: phone || undefined, password, confirmPassword },
  });
  accessToken = result.accessToken;
  csrfToken = result.csrfToken;
  return result;
}

export function getAccessToken() { return accessToken; }

export async function refreshSession() {
  const token = await getCsrfToken();
  const result = await request('/auth/refresh', { method: 'POST', headers: { 'X-CSRF-Token': token } });
  accessToken = result.accessToken;
  csrfToken = result.csrfToken;
  return result;
}

export async function authenticatedRequest(path, options = {}) {
  if (!accessToken) await refreshSession();
  const send = () => fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  let response = await send();
  if (response.status === 401) {
    await refreshSession();
    response = await send();
  }
  return parseResponse(response);
}

export async function signOut() {
  const token = await getCsrfToken();
  const result = await request('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
  accessToken = null;
  csrfToken = null;
  return result;
}

export async function publicRequest(path, options = {}) {
  return request(path, options);
}
