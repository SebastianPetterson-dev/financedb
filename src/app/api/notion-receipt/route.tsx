// app/api/notion-receipt/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import heicConvert from "heic-convert"; // npm i heic-convert

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const DB = process.env.NOTION_DATABASE_ID!;
const NOTION_API = "https://api.notion.com/v1";

// NOTE: This Notion version works with file uploads in practice.
// If you ever hit issues, try upgrading the Notion-Version string.
const HEAD = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
} as const;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return new NextResponse("Missing file", { status: 400 });

    const amountRaw = (form.get("amount") as string | null)?.trim() || "";
    const merchant = (form.get("merchant") as string | null)?.trim() || "";
    const date = (form.get("date") as string | null) || new Date().toISOString().slice(0, 10);
    const notes = (form.get("notes") as string | null)?.trim() || "";
    const title = `Receipt — ${date}`;

    // --- Convert HEIC to JPEG (before uploading) ---
    let uploadFile: File = file;
    const isHeic =
      file.type === "image/heic" ||
      file.type === "image/heif" ||
      /\.hei[c|f]$/i.test(file.name);

    if (isHeic) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const jpeg = await heicConvert({ buffer, format: "JPEG", quality: 0.9 });
      uploadFile = new File([jpeg], file.name.replace(/\.hei[c|f]$/i, ".jpg"), {
        type: "image/jpeg",
      });
    }

    // (Optional) Reject huge files (Notion single-part uploads are small; ~20MB typical)
    const MAX_SINGLE = 20 * 1024 * 1024;
    if (uploadFile.size > MAX_SINGLE) {
      return new NextResponse("File too large for single-part upload", { status: 413 });
    }

    // --- Try Notion direct file upload ---
    let fileUploadId: string | null = null;
    try {
      // 1) Create upload handle
      const createFU = await fetch(`${NOTION_API}/file_uploads`, {
        method: "POST",
        headers: { ...HEAD, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadFile.name || "receipt" }),
      });

      if (createFU.ok) {
        const fu = await createFU.json(); // { id, ... }

        // 2) Send bytes
        const sendFD = new FormData();
        sendFD.append("file", uploadFile);
        const sendFU = await fetch(`${NOTION_API}/file_uploads/${fu.id}/send`, {
          method: "POST",
          headers: HEAD as any, // let FormData set Content-Type
          body: sendFD,
        });
        if (!sendFU.ok) throw new Error(await sendFU.text());

        fileUploadId = fu.id;
      }
    } catch {
      // Ignore: we'll still create the page without a file if upload isn't supported
    }

    // --- Build properties (match your Notion column names exactly) ---
    const properties: any = {
      Name: { title: [{ text: { content: title } }] },
      Date: { date: { start: date } },
    };

    const amount = parseFloat(amountRaw.replace(",", "."));
    if (!Number.isNaN(amount)) properties.Amount = { number: amount };
    if (merchant) properties.Merchant = { rich_text: [{ text: { content: merchant } }] };
    if (notes) properties.Notes = { rich_text: [{ text: { content: notes } }] };

    if (fileUploadId) {
      properties.Receipt = {
        files: [
          {
            type: "file_upload",
            file_upload: { id: fileUploadId }, // <-- correct key
            name: uploadFile.name || "receipt.jpg",
          },
        ],
      };
    }

    // --- Create the page ---
    const createPage = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: { ...HEAD, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: DB },
        properties,
        // Optional: also include as a content block:
        // children: fileUploadId ? [{
        //   object: "block",
        //   type: "image",
        //   image: { type: "file_upload", file_upload: { id: fileUploadId } }
        // }] : []
      }),
    });

    if (!createPage.ok) {
      const text = await createPage.text();
      return new NextResponse(text, { status: createPage.status });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return new NextResponse(e?.message || "Server error", { status: 500 });
  }
}
