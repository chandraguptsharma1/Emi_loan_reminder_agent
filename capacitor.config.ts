import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'ionic-chat',
  webDir: 'www',
  server: {
    androidScheme: 'http',   // << https → http
    cleartext: true,         // cleartext allow
    allowNavigation: ['15.207.88.18'] // (optional)
  }
};
export default config;

