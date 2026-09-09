import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { port: 15173, proxy: { '/api': 'http://127.0.0.1:14311', '/events': { target: 'ws://127.0.0.1:14311', ws: true } } }, build: { outDir: 'dist' } });
