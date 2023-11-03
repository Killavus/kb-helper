export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      OAUTH_CLIENT_ID: string;
      OAUTH_CLIENT_SECRET: string;
      OAUTH_AUTH_URL: string;
      KB_ID: string;
    }
  }
}
