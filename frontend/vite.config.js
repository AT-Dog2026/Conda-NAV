import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // 代码分割：将第三方依赖拆分为独立 chunk，便于并行加载与长效缓存
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('scheduler')) return 'react-vendor';
            if (id.includes('@ant-design/icons')) return 'icons-vendor';
            if (id.includes('antd') || id.includes('rc-') || id.includes('@rc-component')) return 'antd-vendor';
          }
        },
      },
    },
  },
});
