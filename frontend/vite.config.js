// frontend/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tell Vite that the project root for building is the 'src' folder
  root: 'src', 
  build: {
    // And that the output should go back up one level to a 'dist' folder
    outDir: '../dist',
  }
});