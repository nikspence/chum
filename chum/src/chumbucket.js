export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

// Cookies remain HttpOnly. Only the CSRF token is kept in this client's memory.
export function createChumbucketClient(base = '', fetcher = (...args) => fetch(...args)) {
  let csrf, authVersion = 0;
  async function request(route, { method = 'GET', body, raw = false } = {}) {
    const version = authVersion;
    const headers = {};
    if (!['GET', 'HEAD'].includes(method)) {
      headers['X-Chum-Request'] = '1';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (!raw) headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetcher(`${base}${route}`, {
        method, credentials: 'same-origin', headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
    } catch { throw new ApiError('Cannot reach the bucket. Check your connection and try again.'); }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new ApiError('The server returned an unexpected response. Check the API proxy.', response.status); }
    if (!response.ok) {
      if (response.status === 401 && version === authVersion) csrf = undefined;
      throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
    }
    if (data.csrfToken && version === authVersion) csrf = data.csrfToken;
    return data;
  }
  return {
    session: () => request('/api/session'),
    login: passphrase => { authVersion++; return request('/api/session', { method: 'POST', body: { passphrase } }); },
    logout: async () => { authVersion++; await request('/api/session', { method: 'DELETE' }); csrf = undefined; },
    list: id => request(`/api/folders${id ? `?id=${encodeURIComponent(id)}` : ''}`),
    mkdir: (parent, name) => request('/api/folders', { method: 'POST', body: { parent, name } }),
    upload: (parent, file) => request(`/api/files?${new URLSearchParams({ parent, name: file.name })}`, { method: 'POST', body: file, raw: true }),
    update: (id, changes) => request(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes }),
    remove: id => request(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    checkDownload: id => request(`/api/items/${encodeURIComponent(id)}/download`, { method: 'HEAD' }),
    downloadUrl: id => `${base}/api/items/${encodeURIComponent(id)}/download`,
    viewUrl: id => `${base}/api/items/${encodeURIComponent(id)}/view`,
    links: () => request('/api/links'),
    invite: (folder, hours) => request('/api/links', { method: 'POST', body: { folder, hours } }),
    revoke: id => request(`/api/links/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    settings: () => request('/api/settings'),
    saveSettings: settings => request('/api/settings', { method: 'PATCH', body: settings }),
  };
}
