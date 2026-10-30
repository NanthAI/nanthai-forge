import type { ReactNode } from 'react';
export type LifecycleParts = {
  items: ReactNode;
  status: ReactNode;
  dialog: ReactNode;
  abandon?: () => void;
  complete?: () => void;
  reopen?: () => void;
};
