import { defineConfig } from 'vite';

// During viewer development, the Rust backend (`mind-expander view`)
// owns `/api/facts` and `/api/source`. We just proxy those routes
// through Vite so the frontend code can use the same URLs in dev and
// in production (where the Rust binary serves the viewer bundle too).
//
// Start the backend separately, e.g.:
//     cargo run -- view /path/to/workspace --port 5180 --no-open
//
// Override the target with `MIND_EXPANDER_BACKEND` if you bind a
// different host/port.
const BACKEND = process.env.MIND_EXPANDER_BACKEND ?? 'http://127.0.0.1:5180';

export default defineConfig({
  root: '.',
  server: {
    open: '/index.html',
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: false,
      },
    },
  },
});
