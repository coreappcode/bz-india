import type { CapacitorConfig } from '@capacitor/cli';

// The native shell lives in this folder only. The web app is built from the repo root
// and copied in as static assets; nothing here changes the web build.
const config: CapacitorConfig = {
  appId: 'com.bzead.india',
  appName: 'BZEAD: Shop Online',
  webDir: '../dist-buyer-in',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
