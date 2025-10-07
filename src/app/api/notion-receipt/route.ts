export const runtime = "nodejs";

import { NextResponse } from "next/server";
import heicConvert from "heic-convert";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const DB = process.env.NOTION_DATABASE_ID!;
const API_KEY = process.env.API_KEY; // <= server-only key

const NOTION_API = "https://api.notion.com/v1";
const HEAD: Record<string, string> = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
};

type NotionFileUploadCreateRes = { id: string };

export async function POST(req: Request) {
  // --- API key gate ---
  const incomingKey = req.headers.get("x-api-key");
  if (!API_KEY || incomingKey !== API_KEY) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return new NextResponse("Missing file", { status: 400 });

    const amountRaw = (form.get("amount") as string | null)?.trim() ?? "";
    const merchant = (form.get("merchant") as string | null)?.trim() ?? "";
    const date = (form.get("date") as string | null) ?? new Date().toISOString().slice(0, 10);
    const notes = (form.get("notes") as string | null)?.trim() ?? "";
    const title = `Receipt — ${date}`;

    // --- HEIC/HEIF → JPEG ---
    let uploadFile: File = file;
    const isHeic =
      file.type === "image/heic" ||
      file.type === "image/heif" ||
      /\.hei[cf]$/i.test(file.name);

    if (isHeic) {
      const inputBuf = Buffer.from(await file.arrayBuffer());
      const inputAB = inputBuf.buffer.slice(
        inputBuf.byteOffset,
        inputBuf.byteOffset + inputBuf.byteLength
      );
      const outAB = (await heicConvert({
        buffer: inputAB as ArrayBuffer,
        format: "JPEG",
        quality: 0.9,
      })) as ArrayBuffer;
      const outBuf = Buffer.from(outAB);
      uploadFile = new File([outBuf], file.name.replace(/\.hei[cf]$/i, ".jpg"), {
        type: "image/jpeg",
      });
    }

    // --- size guard (single-part Notion upload) ---
    const MAX_SINGLE = 20 * 1024 * 1024;
    if (uploadFile.size > MAX_SINGLE) {
      return new NextResponse("File too large for single-part upload", { status: 413 });
    }

    // --- Notion direct file upload ---
    let fileUploadId: string | null = null;
    try {
      const createFU = await fetch(`${NOTION_API}/file_uploads`, {
        method: "POST",
        headers: { ...HEAD, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: uploadFile.name || "receipt" }),
      });

      if (createFU.ok) {
        const fu = (await createFU.json()) as NotionFileUploadCreateRes;

        const sendFD = new FormData();
        sendFD.append("file", uploadFile);

        const sendFU = await fetch(`${NOTION_API}/file_uploads/${fu.id}/send`, {
          method: "POST",
          headers: HEAD, // FormData sets boundary
          body: sendFD,
        });
        if (!sendFU.ok) throw new Error(await sendFU.text());

        fileUploadId = fu.id;
      }
    } catch {
      // If uploads aren't supported by your workspace, we'll still create the page.
    }

    // --- Properties (match your Finances DB) ---
    const properties: Record<string, unknown> = {
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
            file_upload: { id: fileUploadId }, // correct key
            name: uploadFile.name || "receipt.jpg",
          },
        ],
      };
    }

    // --- Create page ---
    const createPage = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: { ...HEAD, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: DB },
        properties,
      }),
    });

    if (!createPage.ok) {
      const text = await createPage.text();
      return new NextResponse(text, { status: createPage.status });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg || "Server error", { status: 500 });
  }
}
