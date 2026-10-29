// Copy into Chum's src directory. Serve/proxy /api and /?access on the same origin.
export function createChumbucketClient(base = '') {
  let csrf;
  async function request(route, { method = 'GET', body, raw = false } = {}) {
    const headers = {};
    if (method !== 'GET') {
      headers['X-Chum-Request'] = '1';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (!raw) headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${base}${route}`, {
      method, credentials: 'same-origin', headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (data.csrfToken) csrf = data.csrfToken;
    return data;
  }
  return {
    session: () => request('/api/session'),
    login: passphrase => request('/api/session', { method: 'POST', body: { passphrase } }),
    logout: async () => { await request('/api/session', { method: 'DELETE' }); csrf = undefined; },
    list: id => request(`/api/folders${id ? `?id=${encodeURIComponent(id)}` : ''}`),
    mkdir: (parent, name) => request('/api/folders', { method: 'POST', body: { parent, name } }),
    upload: (parent, file) => request(`/api/files?${new URLSearchParams({ parent, name: file.name })}`, { method: 'POST', body: file, raw: true }),
    update: (id, changes) => request(`/api/items/${id}`, { method: 'PATCH', body: changes }),
    remove: id => request(`/api/items/${id}`, { method: 'DELETE' }),
    downloadUrl: id => `${base}/api/items/${id}/download`,
    links: () => request('/api/links'),
    invite: (folder, hours) => request('/api/links', { method: 'POST', body: { folder, hours } }),
    revoke: id => request(`/api/links/${id}/revoke`, { method: 'POST' }),
    settings: () => request('/api/settings'),
    saveSettings: settings => request('/api/settings', { method: 'PATCH', body: settings }),
  };
}
