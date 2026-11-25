/// <reference types="vite/client" />

import type { NexlinkAPI } from '../preload';

declare global {
  interface Window {
    nexlinkAPI: NexlinkAPI;
  }
}
