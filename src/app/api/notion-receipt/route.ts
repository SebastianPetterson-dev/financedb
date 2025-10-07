export const runtime = "nodejs";

import { NextResponse } from "next/server";
import heicConvert from "heic-convert"; // npm i heic-convert

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const DB = process.env.NOTION_DATABASE_ID!;
const NOTION_API = "https://api.notion.com/v1";
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

    // ---- HEIC/HEIF → JPEG (type-safe) ----
    let uploadFile: File = file;
    const isHeic =
      file.type === "image/heic" ||
      file.type === "image/heif" ||
      /\.hei[cf]$/i.test(file.name);

    if (isHeic) {
      // Get ArrayBuffer for the HEIC
      const inputBuf = Buffer.from(await file.arrayBuffer());
      // Slice to a clean ArrayBuffer view (what heic-convert typings expect)
      const inputAB = inputBuf.buffer.slice(
        inputBuf.byteOffset,
        inputBuf.byteOffset + inputBuf.byteLength
      );
      // heic-convert returns an ArrayBuffer (or Buffer depending on version); both are fine
      const outAB = (await heicConvert({
        buffer: inputAB as ArrayBuffer,
        format: "JPEG",
        quality: 0.9,
      })) as ArrayBuffer;

      // Wrap back into a Buffer for File()
      const outBuf = Buffer.isBuffer(outAB) ? outAB : Buffer.from(outAB);
      uploadFile = new File([outBuf], file.name.replace(/\.hei[cf]$/i, ".jpg"), {
        type: "image/jpeg",
      });
    }

    // Optional guard: Notion single-part uploads are small (~20 MB typical)
    const MAX_SINGLE = 20 * 1024 * 1024;
    if (uploadFile.size > MAX_SINGLE) {
      return new NextResponse("File too large for single-part upload", { status: 413 });
    }

    // ---- Notion direct file upload ----
    let fileUploadId: string | null = null;
    try {
      const createFU = await fetch(`${NOTION_API}/file_uploads`, {
        method: "POST",
        headers: { ...HEAD, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadFile.name || "receipt" }),
      });

      if (createFU.ok) {
        const fu = await createFU.json(); // { id, ... }
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
      // If uploads aren't supported for your workspace/integration, we still create the page.
    }

    // ---- Properties (match your Notion columns exactly) ----
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
            file_upload: { id: fileUploadId }, // ✅ correct key
            name: uploadFile.name || "receipt.jpg",
          },
        ],
      };
    }

    const createPage = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: { ...HEAD, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: DB },
        properties,
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
