'use client';

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase-client';
import {
  EMPTY_CLASS_CONTEXT,
  type ClassContext,
  type MisconceptionMeta,
} from '@/lib/classInsights';

/**
 * Resolves the display layer the misconception views need: student uid → name
 * (via the teacher-authorised roster route, since `profiles` RLS hides other
 * students) and misconceptionId → catalogue metadata (readable directly, the
 * catalogue is public reference data).
 */
export function useClassContext(classId: string): {
  context: ClassContext;
  loading: boolean;
} {
  const [context, setContext] = useState<ClassContext>(EMPTY_CLASS_CONTEXT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      const misconceptions = new Map<string, MisconceptionMeta>();
      const studentNames = new Map<string, string>();

      const { data: catalogue, error: catalogueError } = await supabase
        .from('misconceptions')
        .select('id, name, name_bm, plain_language_label, plain_language_label_bm, remediation_approach');

      if (catalogueError) {
        console.error('[useClassContext] misconception catalogue error', catalogueError);
      }

      for (const row of catalogue ?? []) {
        misconceptions.set(row.id as string, {
          name: (row.name as string) ?? (row.id as string),
          name_bm: (row.name_bm as string | null) ?? null,
          plainLanguageLabel: (row.plain_language_label as string | null) ?? null,
          plainLanguageLabel_bm: (row.plain_language_label_bm as string | null) ?? null,
          remediationApproach: (row.remediation_approach as string | null) ?? null,
        });
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;

        if (accessToken) {
          const res = await fetch(`/api/class/roster?classId=${encodeURIComponent(classId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (res.ok) {
            const data: { students: { id: string; name: string }[] } = await res.json();
            for (const student of data.students) {
              studentNames.set(student.id, student.name);
            }
          }
        }
      } catch (err) {
        console.error('[useClassContext] roster fetch error', err);
      }

      if (cancelled) return;
      setContext({ studentNames, misconceptions });
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [classId]);

  return { context, loading };
}
