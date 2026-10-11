import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  build: { rollupOptions: { output: { manualChunks(id) {
    if (!id.includes('node_modules')) return;
    if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react-vendor';
    if (id.includes('@radix-ui')) return 'ui-vendor';
    if (id.includes('react-markdown') || id.includes('remark-') || id.includes('micromark') || id.includes('mdast-') || id.includes('hast-') || id.includes('unist-')) return 'markdown-vendor';
  } } } },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
