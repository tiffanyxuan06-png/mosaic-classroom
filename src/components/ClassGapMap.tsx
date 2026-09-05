'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/LanguageContext';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MisconceptionCellData {
  misconceptionId: string;
  /** English name */
  name: string;
  /** Bahasa Melayu name */
  name_bm: string;
  /** Number of students currently flagged with this misconception */
  studentCount: number;
  /** Fraction of the class affected: 0–1 */
  prevalence: number;
}

export interface TopicRowData {
  topic: string;
  topic_bm: string;
  misconceptions: MisconceptionCellData[];
}

export interface ClassGapMapProps {
  classSize: number;
  rows: TopicRowData[];
  /** Optional: highlight a specific misconception cell */
  highlightMisconceptionId?: string;
  /** Called when a teacher clicks a cell to drill in */
  onCellClick?: (misconceptionId: string, topic: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Maps a 0–1 prevalence fraction to a Tailwind heat colour. */
function heatColour(prevalence: number): string {
  if (prevalence === 0) return 'bg-slate-50 text-slate-300 border-slate-100';
  if (prevalence < 0.15) return 'bg-green-50 text-green-700 border-green-200';
  if (prevalence < 0.35) return 'bg-yellow-50 text-yellow-700 border-yellow-200';
  if (prevalence < 0.55) return 'bg-orange-50 text-orange-700 border-orange-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

function heatDot(prevalence: number): string {
  if (prevalence === 0) return 'bg-slate-200';
  if (prevalence < 0.15) return 'bg-green-400';
  if (prevalence < 0.35) return 'bg-yellow-400';
  if (prevalence < 0.55) return 'bg-orange-400';
  return 'bg-red-500';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Language toggle button
// ─────────────────────────────────────────────────────────────────────────────

function LanguageToggle() {
  const { language, toggleLanguage } = useLanguage();

  return (
    <button
      type="button"
      id="gap-map-language-toggle"
      onClick={toggleLanguage}
      aria-label="Toggle display language"
      className={cn(
        'flex items-center gap-1 px-3 py-1.5 rounded-full border-2 text-xs font-bold',
        'transition-all duration-200 select-none',
        language === 'bm'
          ? 'border-blue-500 bg-blue-50 text-blue-700'
          : 'border-slate-300 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-600',
      )}
    >
      <span className={language === 'en' ? 'opacity-100' : 'opacity-40'}>EN</span>
      <span className="opacity-30 font-normal">|</span>
      <span className={language === 'bm' ? 'opacity-100' : 'opacity-40'}>BM</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Heat cell
// ─────────────────────────────────────────────────────────────────────────────

interface HeatCellProps {
  cell: MisconceptionCellData;
  isHighlighted: boolean;
  onClick?: () => void;
}

function HeatCell({ cell, isHighlighted, onClick }: HeatCellProps) {
  const { language } = useLanguage();
  const [hovered, setHovered] = useState(false);

  const colours = heatColour(cell.prevalence);
  const dot = heatDot(cell.prevalence);
  const displayName = language === 'bm' ? cell.name_bm : cell.name;
  const pct = Math.round(cell.prevalence * 100);

  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={`${displayName}: ${pct}% of class`}
        className={cn(
          'w-full min-h-[72px] p-2.5 rounded-xl border-2 text-left',
          'transition-all duration-200 active:scale-[0.97]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
          colours,
          isHighlighted && 'ring-2 ring-blue-400 ring-offset-2',
          onClick ? 'cursor-pointer hover:shadow-md' : 'cursor-default',
        )}
      >
        {/* Header row: dot + % */}
        <div className="flex items-center justify-between mb-1.5">
          <span
            className={cn('w-2 h-2 rounded-full flex-shrink-0', dot)}
            aria-hidden="true"
          />
          <span className="text-[10px] font-bold tabular-nums">
            {cell.studentCount > 0 ? `${pct}%` : '—'}
          </span>
        </div>

        {/* Misconception name */}
        <p className="text-[11px] leading-snug font-medium line-clamp-2">
          {displayName}
        </p>

        {/* Student count */}
        {cell.studentCount > 0 && (
          <p className="text-[10px] mt-1 opacity-60">
            {cell.studentCount} student{cell.studentCount !== 1 ? 's' : ''}
          </p>
        )}
      </button>

      {/* Tooltip — shows full name when truncated */}
      {hovered && displayName.length > 40 && (
        <div
          className={cn(
            'absolute z-20 bottom-full left-0 mb-1.5 w-56',
            'bg-slate-800 text-white text-[11px] leading-snug',
            'px-3 py-2 rounded-lg shadow-xl pointer-events-none',
          )}
          role="tooltip"
        >
          {displayName}
          <div className="absolute top-full left-4 border-4 border-transparent border-t-slate-800" />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Legend
// ─────────────────────────────────────────────────────────────────────────────

function HeatLegend() {
  const { language } = useLanguage();
  const items = [
    { dot: 'bg-slate-200', label: language === 'bm' ? 'Tiada' : 'None', range: '0%' },
    { dot: 'bg-green-400', label: language === 'bm' ? 'Rendah' : 'Low', range: '<15%' },
    { dot: 'bg-yellow-400', label: language === 'bm' ? 'Sederhana' : 'Moderate', range: '15–35%' },
    { dot: 'bg-orange-400', label: language === 'bm' ? 'Tinggi' : 'High', range: '35–55%' },
    { dot: 'bg-red-500', label: language === 'bm' ? 'Kritikal' : 'Critical', range: '>55%' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map(({ dot, label, range }) => (
        <div key={range} className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dot)} />
          <span className="font-medium">{label}</span>
          <span className="opacity-60">({range})</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component: ClassGapMap
// ─────────────────────────────────────────────────────────────────────────────

export default function ClassGapMap({
  classSize,
  rows,
  highlightMisconceptionId,
  onCellClick,
}: ClassGapMapProps) {
  const { language } = useLanguage();

  const headerLabel = language === 'bm' ? 'Peta Jurang Kelas' : 'Class Gap Map';
  const subLabel =
    language === 'bm'
      ? `${classSize} pelajar · Kemas kini masa nyata`
      : `${classSize} students · Live prevalence`;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* ── Header ── */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-slate-800">{headerLabel}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{subLabel}</p>
        </div>

        {/* Language toggle — top-right corner */}
        <LanguageToggle />
      </div>

      {/* ── Legend ── */}
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
        <HeatLegend />
      </div>

      {/* ── Heatmap grid ── */}
      <div className="p-5 space-y-6 overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">
            {language === 'bm'
              ? 'Tiada data tersedia.'
              : 'No data available yet.'}
          </p>
        ) : (
          rows.map((row) => {
            const topicName = language === 'bm' ? row.topic_bm : row.topic;

            return (
              <div key={row.topic}>
                {/* Topic label */}
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2.5">
                  {topicName}
                </p>

                {/* Misconception cells grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                  {row.misconceptions.map((cell) => (
                    <HeatCell
                      key={cell.misconceptionId}
                      cell={cell}
                      isHighlighted={
                        cell.misconceptionId === highlightMisconceptionId
                      }
                      onClick={
                        onCellClick
                          ? () => onCellClick(cell.misconceptionId, row.topic)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-5 py-3 border-t border-slate-100 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        <span className="text-[10px] text-slate-400">
          {language === 'bm'
            ? 'Dikemas kini secara langsung apabila pelajar menjawab'
            : 'Updates live as students answer'}
        </span>
      </div>
    </div>
  );
}
