import { LanguageProvider } from '@/lib/LanguageContext';
import type { ReactNode } from 'react';

export default function TeacherLayout({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}
