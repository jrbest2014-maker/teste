/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VONE_LOCAL_URL?: string;
  readonly VITE_VONE_LOCAL_TOKEN?: string;
  readonly VITE_VONE_MASTER_URL?: string;
  readonly VITE_VONE_CLOUD_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
