"use client";

import { useEffect, useRef, useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { Camera, Loader2, Printer, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";

import { db } from "@/lib/firebase-client";
import { updateStudentProgress, type AnswerPayload } from "@/lib/studentProgress";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_OPTIONS = ["A", "B", "C", "D"] as const;
export type AnswerOption = (typeof ANSWER_OPTIONS)[number];

export interface ScannedResult {
  studentIdentifier: string;
  answers: Record<string, AnswerOption | null>;
}

interface PaperScannerProps {
  classId: string;
  questionLabels: string[];
  isOpen: boolean;
  onClose: () => void;
  onResultsProcessed: (results: ScannedResult[]) => void;
}

type ScanPhase = "idle" | "preview" | "scanning" | "results" | "error";

interface ScanApiSuccess {
  results: ScannedResult[];
  scannedAt: string;
  totalSlipsDetected: number;
}

interface ScanApiFailure {
  results: never[];
  error: "scan_failed";
  message: string;
}

const DEFAULT_ERROR_MESSAGE =
  "Could not read the slips clearly. Try again with better lighting.";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function detectImageType(file: File): "jpeg" | "png" | "webp" {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpeg";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Paper scans have no auth uid, so progress is keyed by a class-scoped name
 * slug — same convention as kiosk sessions, kept simple rather than trying to
 * fuzzy-match handwritten names against the class roster.
 */
function paperStudentId(classId: string, studentIdentifier: string): string {
  const slug = studentIdentifier.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `paper_${classId}_${slug}`;
}

function buildPrintableSlipsHtml(questionLabels: string[]): string {
  const slipHtml = `
    <div class="slip">
      <div class="slip-header">Name: ______________________________</div>
      <div class="questions">
        ${questionLabels
          .map(
            (label) => `
          <div class="question-row">
            <span class="question-label">${label}</span>
            <div class="bubbles">
              ${ANSWER_OPTIONS.map((opt) => `<span class="bubble">${opt}</span>`).join("")}
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>`;

  const page = `<div class="page">${slipHtml}${slipHtml}${slipHtml}</div>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Answer Slips</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; }
  .page { display: flex; flex-direction: column; gap: 24px; }
  .slip { border: 2px solid #333; border-radius: 8px; padding: 16px 20px; }
  .slip-header { font-size: 16px; font-weight: bold; margin-bottom: 16px; }
  .question-row { display: flex; align-items: center; gap: 16px; margin-bottom: 10px; }
  .question-label { width: 32px; font-weight: bold; font-size: 15px; }
  .bubbles { display: flex; gap: 12px; }
  .bubble {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border: 2px solid #333; border-radius: 50%;
    font-size: 14px; font-weight: 600;
  }
  @media print {
    .slip { break-inside: avoid; }
  }
</style>
</head>
<body>
  ${page}
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function PaperScanner({
  classId,
  questionLabels,
  isOpen,
  onClose,
  onResultsProcessed,
}: PaperScannerProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [results, setResults] = useState<ScannedResult[]>([]);
  const [answerKey, setAnswerKey] = useState<Record<string, AnswerOption | "">>({});
  const [topic, setTopic] = useState("");
  const [confirming, setConfirming] = useState(false);

  // Reset to a clean slate every time the sheet is opened
  useEffect(() => {
    if (!isOpen) return;
    setPhase("idle");
    setImageFile(null);
    setImagePreviewUrl(null);
    setErrorMessage(null);
    setResults([]);
    setAnswerKey(Object.fromEntries(questionLabels.map((label) => [label, ""])));
    setTopic("");
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  function handleFileSelected(file: File | undefined) {
    if (!file) return;
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
    setErrorMessage(null);
    setPhase("preview");
  }

  function handleTryAgain() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
    setErrorMessage(null);
    setResults([]);
    setPhase("idle");
  }

  async function handleScan() {
    if (!imageFile) return;
    setPhase("scanning");
    setErrorMessage(null);

    try {
      const dataUrl = await fileToDataUrl(imageFile);

      const res = await fetch("/api/scanner/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl,
          imageType: detectImageType(imageFile),
          classId,
          questionLabels,
        }),
      });

      const data: ScanApiSuccess | ScanApiFailure = await res.json();

      if (!res.ok || "error" in data) {
        setErrorMessage(
          "message" in data && data.message ? data.message : DEFAULT_ERROR_MESSAGE
        );
        setPhase("error");
        return;
      }

      setResults(data.results);
      setPhase("results");
    } catch (err) {
      console.error("[PaperScanner] scan error", err);
      setErrorMessage(DEFAULT_ERROR_MESSAGE);
      setPhase("error");
    }
  }

  function updateAnswer(rowIndex: number, label: string, value: AnswerOption | "") {
    setResults((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? { ...row, answers: { ...row.answers, [label]: value === "" ? null : value } }
          : row
      )
    );
  }

  const canConfirm =
    topic.trim().length > 0 &&
    questionLabels.every((label) => answerKey[label]) &&
    results.length > 0;

  async function handleConfirm() {
    if (!canConfirm || confirming) return;
    setConfirming(true);

    try {
      let answersWritten = 0;

      await Promise.all(
        results.map(async (row) => {
          const studentId = paperStudentId(classId, row.studentIdentifier);

          for (const label of questionLabels) {
            const selected = row.answers[label];
            const correctOption = answerKey[label] || null;
            const isCorrect = selected !== null && selected === correctOption;

            await addDoc(collection(db, "scannedAnswers"), {
              classId,
              studentIdentifier: row.studentIdentifier,
              questionLabel: label,
              selectedOption: selected,
              correctOption,
              isCorrect: selected === null ? null : isCorrect,
              topic,
              source: "paper_scan",
              scannedAt: serverTimestamp(),
            });

            if (selected === null) continue;

            const payload: AnswerPayload = {
              studentId,
              classId,
              topic,
              isCorrect,
              isTransferQuestion: false,
              isResetQuestion: false,
              confidenceLevel: "unsure",
              misconceptionId: null,
              misconceptionLabel: null,
              misconceptionLabel_bm: null,
              timeSpentMs: 0,
              answerChanges: 0,
            };

            await updateStudentProgress(payload);
            answersWritten += 1;
          }
        })
      );

      toast.success(`${answersWritten} student answers processed`);
      onResultsProcessed(results);
      handleTryAgain();
      onClose();
    } catch (err) {
      console.error("[PaperScanner] confirm error", err);
      toast.error("Could not save scanned answers. Try again.");
    } finally {
      setConfirming(false);
    }
  }

  function openPrintableSlips() {
    const html = buildPrintableSlipsHtml(questionLabels);
    const printWindow = window.open("", "_blank", "width=850,height=1100");
    if (!printWindow) return;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.onload = () => printWindow.print();
  }

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-xl md:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle>Scan Paper Answer Slips</SheetTitle>
          <SheetDescription>
            Photograph completed answer slips to update the class heatmap.
          </SheetDescription>
        </SheetHeader>

        <Button type="button" variant="outline" onClick={openPrintableSlips} className="gap-2">
          <Printer className="h-4 w-4" />
          Generate Printable Slips
        </Button>

        {(phase === "idle" || phase === "preview") && (
          <div className="space-y-4">
            {phase === "idle" && (
              <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-input py-10 text-center">
                <Camera className="h-12 w-12 text-muted-foreground" />
                <p className="text-base font-medium text-muted-foreground">
                  Take a photo of your students&apos; answer slips
                </p>
              </div>
            )}

            {imagePreviewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imagePreviewUrl}
                alt="Selected answer slips"
                className="w-full rounded-lg border"
              />
            )}

            <div className="flex gap-3">
              <Button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex-1 gap-2"
              >
                <Camera className="h-4 w-4" />
                Open Camera
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => uploadInputRef.current?.click()}
                className="flex-1 gap-2"
              >
                <Upload className="h-4 w-4" />
                Upload Image
              </Button>
            </div>

            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => handleFileSelected(e.target.files?.[0])}
            />
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFileSelected(e.target.files?.[0])}
            />

            {phase === "preview" && (
              <Button type="button" onClick={handleScan} className="w-full gap-2">
                <Sparkles className="h-4 w-4" />
                Scan with AI
              </Button>
            )}
          </div>
        )}

        {phase === "scanning" && (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-lg font-medium">Reading answer slips...</p>
          </div>
        )}

        {phase === "error" && (
          <Alert variant="destructive">
            <AlertTitle>Scan failed</AlertTitle>
            <AlertDescription className="space-y-4">
              <p>{errorMessage ?? DEFAULT_ERROR_MESSAGE}</p>
              <Button type="button" variant="outline" onClick={handleTryAgain}>
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {phase === "results" && (
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="scan-topic">Topic for this batch</Label>
              <Input
                id="scan-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. fractions"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Answer key</Label>
              <div className="flex flex-wrap gap-4">
                {questionLabels.map((label) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    <select
                      value={answerKey[label] ?? ""}
                      onChange={(e) =>
                        setAnswerKey((prev) => ({
                          ...prev,
                          [label]: e.target.value as AnswerOption | "",
                        }))
                      }
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">—</option>
                      {ANSWER_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  {questionLabels.map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((row, rowIndex) => {
                  const answeredCount = questionLabels.filter(
                    (label) => row.answers[label]
                  ).length;

                  return (
                    <TableRow key={`${row.studentIdentifier}-${rowIndex}`}>
                      <TableCell className="font-medium">
                        {row.studentIdentifier}
                      </TableCell>
                      {questionLabels.map((label) => (
                        <TableCell key={label}>
                          <select
                            value={row.answers[label] ?? ""}
                            onChange={(e) =>
                              updateAnswer(
                                rowIndex,
                                label,
                                e.target.value as AnswerOption | ""
                              )
                            }
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                          >
                            <option value="">—</option>
                            {ANSWER_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                      ))}
                      <TableCell>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            answeredCount === questionLabels.length
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          )}
                        >
                          {answeredCount}/{questionLabels.length} answered
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <SheetFooter>
              <Button type="button" variant="outline" onClick={handleTryAgain}>
                Rescan
              </Button>
              <Button
                type="button"
                onClick={handleConfirm}
                disabled={!canConfirm || confirming}
                className="gap-2"
              >
                {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm + Update Heatmap
              </Button>
            </SheetFooter>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
