"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);

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
    } catch (err: unknown) {
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
              // blob: URLs are fine with unoptimized to skip Next Image optimization
              unoptimized
            />
          </div>
        )}

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
      </form>
    </main>
  );
}
