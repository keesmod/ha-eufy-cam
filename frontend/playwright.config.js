import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.js', use: { headless: true }, reporter: 'list' });
