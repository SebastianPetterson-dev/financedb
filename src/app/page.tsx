"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import Tesseract from "tesseract.js";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

// ---------- Helpers (OCR parsing) ----------
function parseAmountDK(text: string): number | null {
  // Matches: 129,95 or 129.95 or 1.299,95 etc.
  const matches = text.match(/(\d{1,3}(?:[.\s]\d{3})*|\d+)([.,]\d{2})?/g) || [];
  const nums = matches
    .map((m) => {
      let s = m.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "");
      if (s.includes(",")) s = s.replace(",", ".");
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n !== null && n > 0 && n < 100000);
  return nums.length ? nums.sort((a, b) => b - a)[0] : null; // pick largest (TOTAL)
}

function guessMerchant(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const banned = /^(kvittering|receipt|faktura|moms|vat|cvr|org\.?nr|order|ordrenr|transaction)/i;

  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const line = lines[i]
      .replace(/[^\p{L}\p{N}\s.&'-]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!line) continue;
    if (banned.test(line)) continue;
    if (!/[A-Za-zÆØÅæøå]/.test(line)) continue; // must contain letters
    // Avoid obvious addresses/dates
    if (/\d{1,4}\s?[A-Za-z]/.test(line) && /[0-9]/.test(line) && (/,/.test(line) || /\d{4}/.test(line))) continue;
    return line.slice(0, 50);
  }
  return (lines[0] || "").replace(banned, "").trim().slice(0, 50);
}

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);

  // PWA install handling
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const handler = (e: Event) => {
      const ev = e as BeforeInstallPromptEvent;
      ev.preventDefault();
      setDeferredPrompt(ev);
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setCanInstall(false);
  }

  function onFileChange(f: File | null) {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  // ---------- OCR autofill ----------
  async function handleAutoFill() {
    if (!file) {
      alert("Pick a receipt image first.");
      return;
    }
    setStatus("🔎 Reading receipt…");

    let tempURL: string | null = null;
    try {
      // Feed Tesseract an object URL for better Safari compatibility
      const src = preview || (tempURL = URL.createObjectURL(file));
      const { data } = await Tesseract.recognize(src, "eng");
      const text = data.text || "";

      const amt = parseAmountDK(text);
      const mer = guessMerchant(text);

      if (amt !== null) setAmount(amt.toFixed(2));
      if (mer) setMerchant(mer);

      setStatus("✅ Parsed. Review and send.");
    } catch {
      setStatus("❌ OCR failed. You can still fill fields manually.");
    } finally {
      if (tempURL) URL.revokeObjectURL(tempURL);
    }
  }

  // ---------- Submit ----------
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      alert("Please select a receipt photo first.");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("amount", amount.replace(",", ".").trim());
    fd.append("merchant", merchant);
    fd.append("date", date);
    fd.append("notes", notes);

    setSending(true);
    setStatus("Sending to Notion…");

    try {
      const res = await fetch("/api/notion-receipt", {
        method: "POST",
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_API_KEY || "",
        },
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t);
      }
      setStatus("✅ Done! Check your Finances DB in Notion.");
      setFile(null);
      setPreview(null);
      setAmount("");
      setMerchant("");
      setNotes("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("❌ Error: " + msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 bg-white text-black">
      <h1 className="text-2xl font-bold mb-4">Upload Receipt → Notion</h1>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 w-full max-w-md bg-gray-50 rounded-lg p-6 shadow"
      >
        <input
          type="file"
          accept="image/*,.heic,.pdf"
          capture="environment"
          onChange={(e) => onFileChange(e.target.files?.[0] || null)}
          className="p-2 rounded border border-gray-300"
        />

        {preview && (
          <div className="w-32 h-32 relative">
            <Image
              src={preview}
              alt="preview"
              fill
              className="object-cover rounded border border-gray-300"
              unoptimized
            />
          </div>
        )}

        {/* OCR Auto-fill button */}
        <button
          type="button"
          onClick={handleAutoFill}
          className="py-2 rounded border border-gray-300 hover:bg-gray-100"
          disabled={!file}
        >
          Auto-fill Amount &amp; Merchant
        </button>

        <input
          type="number"
          step="0.01"
          placeholder="Amount (e.g. 129.95)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="p-2 rounded border border-gray-300"
        />

        <input
          type="text"
          placeholder="Merchant"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          className="p-2 rounded border border-gray-300"
        />

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="p-2 rounded border border-gray-300"
        />

        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="p-2 rounded border border-gray-300"
        />

        <button
          type="submit"
          disabled={sending}
          className={`py-2 rounded transition ${
            sending ? "bg-gray-400 text-white" : "bg-black text-white hover:opacity-80"
          }`}
        >
          {sending ? "Sending…" : "Send to Notion"}
        </button>

        <div className="flex items-center gap-2">
          {canInstall && (
            <button
              type="button"
              onClick={handleInstall}
              className="py-2 rounded border border-gray-300 hover:bg-gray-100"
            >
              Install App
            </button>
          )}
          <p className="text-sm text-gray-600">{status}</p>
        </div>
      </form>
    </main>
  );
}
