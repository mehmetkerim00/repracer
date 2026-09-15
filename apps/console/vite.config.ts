import { defineConfig } from 'vite';

// Интерфейс ходит только к серверу стенда на 127.0.0.1 [Р-67]
export default defineConfig({
  root: import.meta.dirname,
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.STAND_PORT ?? 4318}` },
  },
});
