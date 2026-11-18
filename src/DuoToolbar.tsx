import type { ReactElement } from 'react';

export type DuoToolbarProps = {
  children: ReactElement;
  busy: boolean;
  onLibrary: () => void;
  onNewChat: () => void;
  onSettings: () => void;
};

export const hasDuoToolbar = false;

export function DuoToolbar({ children }: DuoToolbarProps) {
  return children;
}
