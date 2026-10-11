const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const API = `${API_BASE}/api`;
let accessToken = null;
let csrfToken = null;
let csrfRequest = null;
let refreshRequest = null;
let refreshFailure = null;

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || payload.message || 'The request could not be completed.');
    error.status = response.status;
    error.code = payload.error?.code;
    throw error;
  }
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
  if (csrfToken) return csrfToken;
  if (!csrfRequest) {
    csrfRequest = request('/auth/csrf').then((result) => {
      csrfToken = result.csrfToken;
      return csrfToken;
    }).finally(() => { csrfRequest = null; });
  }
  return csrfRequest;
}

export async function signIn({ email, password }) {
  const result = await request('/buyers/login', { method: 'POST', body: { email, password } });
  accessToken = result.accessToken;
  csrfToken = result.csrfToken;
  refreshFailure = null;
  return result;
}

export async function registerCustomer({ company, fullName, email, phone, password, confirmPassword }) {
  const result = await request('/buyers/signup', {
    method: 'POST',
    body: { companyName: company, fullName, email, phone: phone || undefined, password, confirmPassword },
  });
  accessToken = result.accessToken;
  csrfToken = result.csrfToken;
  refreshFailure = null;
  return result;
}

export function getAccessToken() { return accessToken; }

export async function refreshSession() {
  if (refreshRequest) return refreshRequest;
  if (refreshFailure) throw refreshFailure;
  refreshRequest = (async () => {
    try {
      const token = await getCsrfToken();
      let result;
      try {
        result = await request('/auth/refresh', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      } catch (error) {
        // Recover once from a stale/mismatched CSRF cookie; other failures
        // should be surfaced without repeatedly rotating the refresh token.
        if (error.status !== 403 || error.code !== 'CSRF_VALIDATION_FAILED') throw error;
        csrfToken = null;
        const retryToken = await getCsrfToken();
        result = await request('/auth/refresh', { method: 'POST', headers: { 'X-CSRF-Token': retryToken } });
      }
      accessToken = result.accessToken;
      csrfToken = result.csrfToken;
      refreshFailure = null;
      return result;
    } catch (error) {
      accessToken = null;
      // A rejected/expired refresh session will not become valid by retrying
      // every protected request. Sign-in clears this cached failure.
      if (error.status === 401) refreshFailure = error;
      throw error;
    }
  })().finally(() => { refreshRequest = null; });
  return refreshRequest;
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
  refreshFailure = null;
  return result;
}

export async function publicRequest(path, options = {}) {
  return request(path, options);
}
