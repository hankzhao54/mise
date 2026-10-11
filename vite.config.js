import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'client',
  plugins: [react()],
  // 固定文件名 (不带哈希)，每次构建覆盖同两个文件
  build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'assets/app.js', assetFileNames: 'assets/app.[ext]' } } },
  server: { proxy: { '/api': 'http://localhost:3001' } },
});
