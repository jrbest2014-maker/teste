/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VONE_MASTER_URL?: string;
  readonly VITE_VONE_CLOUD_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
