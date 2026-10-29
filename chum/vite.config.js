import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.CHUM_BACKEND_TARGET || 'http://127.0.0.1:3001';
  const backendOrigin = env.VITE_CHUM_BACKEND_ORIGIN || 'http://localhost:3001';
  const port = Number(env.CHUM_FRONTEND_PORT || 5173);
  const previewPort = Number(env.CHUM_PREVIEW_PORT || 4173);
  const allowedOrigins = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    `http://localhost:${previewPort}`, `http://127.0.0.1:${previewPort}`,
    ...(env.CHUM_FRONTEND_ORIGIN ? [new URL(env.CHUM_FRONTEND_ORIGIN).origin] : []),
  ]);
  const isApiRequest = url => url.startsWith('/api/') || /^\/(?:\?.*)?$/.test(url) && new URL(url, 'http://localhost').searchParams.has('access');
  const proxy = () => Object.fromEntries(['/api', '^/\\?.*\\baccess='].map(route => [route, {
    target,
    changeOrigin: true,
    configure(server) {
      server.on('proxyReq', (proxyReq, req) => {
        // Translate only an explicitly trusted local frontend Origin. Backend CSRF
        // checks remain active; arbitrary Origins are rejected before proxying.
        if (req.headers.origin && allowedOrigins.has(req.headers.origin)) proxyReq.setHeader('Origin', backendOrigin);
      });
    },
  }]));
  const guard = server => { server.middlewares.use((req, res, next) => {
    if (isApiRequest(req.url || '') && req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Frontend origin rejected.' }));
      return;
    }
    next();
  }); };
  return {
    plugins: [react(), tailwindcss(), { name: 'chum-local-origin-guard', configureServer: guard, configurePreviewServer: guard }],
    server: { port, strictPort: true, proxy: proxy() },
    preview: { port: previewPort, strictPort: true, proxy: proxy() },
  };
});
