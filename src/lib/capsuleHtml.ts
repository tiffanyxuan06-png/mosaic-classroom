/**
 * HTML rendering for generated practice capsules — split out of the
 * capsule/generate route because Next.js route files may only export
 * HTTP method handlers plus a small config-constant allowlist; exporting
 * generateCapsuleHTML and CapsuleResponse from route.ts directly failed
 * next build's route-type check.
 */

export type CapsuleMode = 'individual' | 'class_slip';

export interface CapsuleQuestion {
  questionId: string;
  questionText: string;
  visualScaffold: string | null;
  options: { A: string; B: string; C: string; D: string };
  correctOption: 'A' | 'B' | 'C' | 'D';
  explanation: string;
}

export interface CapsuleResponse {
  title: string;
  introduction: string;
  questions: CapsuleQuestion[];
  mode: CapsuleMode;
  misconceptionId: string;
  generatedAt: string;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate a complete, self-contained HTML string for a remediation capsule.
 *
 * - Print-optimised: white background, clear typography, page-break hints
 * - Includes a `#qr-code` placeholder div for the sync link QR code
 * - Answer bubbles (○ A–D) give students a pen-friendly response area
 *
 * @param capsuleData - The CapsuleResponse returned by this route
 * @param studentName - Optional student name to render in the header
 */
export function generateCapsuleHTML(
  capsuleData: CapsuleResponse,
  studentName?: string,
): string {
  const date = new Date(capsuleData.generatedAt).toLocaleDateString('en-MY', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const questionsHTML = capsuleData.questions
    .map((q, idx) => {
      const optionRows = (['A', 'B', 'C', 'D'] as const)
        .map(
          (letter) => `
          <tr>
            <td class="bubble-cell">
              <span class="bubble" aria-label="Option ${letter}">○</span>
              <span class="option-label">${esc(letter)}</span>
            </td>
            <td class="option-text">${esc(q.options[letter])}</td>
          </tr>`,
        )
        .join('');

      const scaffoldHTML = q.visualScaffold
        ? `<div class="scaffold">
             <span class="scaffold-label">📐 Visual guide:</span>
             <p>${esc(q.visualScaffold)}</p>
           </div>`
        : '';

      return `
      <div class="question-block" id="question-${esc(q.questionId)}">
        <p class="question-number">Question ${idx + 1}</p>
        <p class="question-text">${esc(q.questionText)}</p>
        ${scaffoldHTML}
        <table class="options-table">
          <tbody>
            ${optionRows}
          </tbody>
        </table>
        <details class="explanation">
          <summary>Show explanation</summary>
          <p>${esc(q.explanation)}</p>
        </details>
      </div>`;
    })
    .join('<hr class="question-divider">');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(capsuleData.title)}</title>
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13pt;
      color: #111;
      background: #fff;
      padding: 2cm 2.5cm;
      max-width: 21cm;
      margin: 0 auto;
    }

    /* ── Header ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #111;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    .header-left h1 {
      font-size: 17pt;
      font-weight: 700;
      line-height: 1.2;
    }
    .header-left .subtitle {
      font-size: 10pt;
      color: #555;
      margin-top: 4px;
    }
    .header-right {
      text-align: right;
      font-size: 10pt;
      color: #444;
      line-height: 1.6;
    }

    /* ── Student block ── */
    .student-block {
      display: flex;
      gap: 32px;
      margin-bottom: 18px;
      font-size: 11pt;
    }
    .student-field {
      flex: 1;
      border-bottom: 1px solid #999;
      padding-bottom: 2px;
    }
    .student-field label {
      font-size: 9pt;
      color: #777;
      display: block;
      margin-bottom: 6px;
    }

    /* ── Introduction ── */
    .introduction {
      background: #f5f5f5;
      border-left: 4px solid #333;
      padding: 10px 14px;
      font-size: 11pt;
      line-height: 1.5;
      margin-bottom: 24px;
      border-radius: 0 4px 4px 0;
    }

    /* ── Questions ── */
    .question-block {
      margin-bottom: 24px;
      page-break-inside: avoid;
    }
    .question-number {
      font-size: 9pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #555;
      margin-bottom: 4px;
    }
    .question-text {
      font-size: 13pt;
      font-weight: 600;
      line-height: 1.45;
      margin-bottom: 12px;
    }

    /* ── Visual scaffold ── */
    .scaffold {
      background: #fafafa;
      border: 1px dashed #bbb;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 10.5pt;
      color: #444;
      line-height: 1.5;
    }
    .scaffold-label {
      font-weight: 600;
      display: block;
      margin-bottom: 4px;
    }

    /* ── Options table ── */
    .options-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
    }
    .options-table tr { vertical-align: top; }
    .options-table tr + tr td { padding-top: 8px; }
    .bubble-cell {
      width: 52px;
      white-space: nowrap;
      padding-right: 8px;
    }
    .bubble {
      font-size: 16pt;
      line-height: 1;
      color: #333;
    }
    .option-label {
      font-weight: 700;
      font-size: 11pt;
      margin-left: 4px;
    }
    .option-text {
      font-size: 12pt;
      line-height: 1.4;
    }

    /* ── Explanation (print: hidden by default) ── */
    .explanation {
      margin-top: 10px;
      font-size: 10.5pt;
      color: #444;
    }
    .explanation summary {
      cursor: pointer;
      font-weight: 600;
      color: #333;
      list-style: none;
      user-select: none;
    }
    .explanation summary::before { content: '▶ '; }
    .explanation[open] summary::before { content: '▼ '; }
    .explanation p { margin-top: 6px; line-height: 1.5; padding-left: 16px; }

    /* ── Dividers ── */
    .question-divider {
      border: none;
      border-top: 1px solid #ddd;
      margin: 20px 0;
    }

    /* ── QR code placeholder ── */
    .qr-section {
      display: flex;
      align-items: center;
      gap: 20px;
      border-top: 2px solid #111;
      padding-top: 16px;
      margin-top: 32px;
    }
    #qr-code {
      width: 80px;
      height: 80px;
      border: 1px dashed #999;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8pt;
      color: #bbb;
      text-align: center;
      flex-shrink: 0;
      border-radius: 4px;
    }
    .qr-label {
      font-size: 10pt;
      color: #444;
      line-height: 1.5;
    }
    .qr-label strong {
      display: block;
      font-size: 11pt;
      color: #111;
      margin-bottom: 2px;
    }

    /* ── Print overrides ── */
    @media print {
      body { padding: 1.5cm 2cm; }
      .explanation { display: none; }   /* hide toggle on paper */
      @page { margin: 1.5cm; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <h1>${esc(capsuleData.title)}</h1>
      <p class="subtitle">
        Mosaic Classroom · ${esc(capsuleData.mode === 'class_slip' ? 'Class Practice Slip' : 'Individual Remediation')}
      </p>
    </div>
    <div class="header-right">
      <div>${esc(date)}</div>
      <div>Misconception: <strong>${esc(capsuleData.misconceptionId)}</strong></div>
    </div>
  </header>

  <!-- Student name + date fields -->
  <div class="student-block">
    <div class="student-field">
      <label>Name</label>
      ${esc(studentName ?? '')}
    </div>
    <div class="student-field">
      <label>Class</label>
    </div>
    <div class="student-field">
      <label>Date</label>
    </div>
  </div>

  <!-- Introduction -->
  <div class="introduction">${esc(capsuleData.introduction)}</div>

  <!-- Questions -->
  <main>
    ${questionsHTML}
  </main>

  <!-- QR code sync link placeholder -->
  <footer class="qr-section">
    <div id="qr-code" aria-label="QR code placeholder">
      QR<br>code
    </div>
    <div class="qr-label">
      <strong>Scan to submit your answers</strong>
      Use the Mosaic Classroom app to sync your responses and get instant
      feedback on your misconception.
    </div>
  </footer>

</body>
</html>`;
}
