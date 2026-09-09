import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/browser',workers:1,use:{baseURL:'http://127.0.0.1:14319',headless:true,viewport:{width:1440,height:1000},trace:'retain-on-failure'},webServer:{command:'pnpm exec tsx tests/e2e-server.ts',url:'http://127.0.0.1:14319/api/health',reuseExistingServer:false,timeout:60000},timeout:60000});
