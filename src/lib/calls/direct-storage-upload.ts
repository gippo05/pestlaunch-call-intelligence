"use client";

import { getPublicSupabaseConfig } from "@/lib/env/public";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { MAX_AUDIO_BYTES } from "./upload-validation";

const AUDIO_BUCKET = "pestlaunch-call-audio";
const objectPathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/i;
const STORAGE_REQUEST_TIMEOUT_MS = 9 * 60 * 1000;

export async function uploadDirectToSupabaseStorage(
  objectPath: string,
  file: File,
  onProgress: (progress: number) => void,
): Promise<void> {
  if (!objectPathPattern.test(objectPath)) throw new Error("INVALID_STORAGE_PATH");
  if (file.type !== "audio/mpeg" || !file.name.toLowerCase().endsWith(".mp3")) {
    throw new Error("UNSUPPORTED_AUDIO");
  }
  if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
    throw new Error(file.size > MAX_AUDIO_BYTES ? "FILE_TOO_LARGE" : "INVALID_FILE_SIZE");
  }

  const { data, error } = await createSupabaseBrowserClient().auth.getSession();
  const accessToken = data.session?.access_token;
  if (error || !accessToken) throw new Error("AUTH_REQUIRED");

  const { supabaseUrl, publishableKey } = getPublicSupabaseConfig();
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const storageUrl = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${AUDIO_BUCKET}/${encodedPath}`;

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", storageUrl);
    request.timeout = STORAGE_REQUEST_TIMEOUT_MS;
    request.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    request.setRequestHeader("apikey", publishableKey);
    request.setRequestHeader("Content-Type", "audio/mpeg");
    request.setRequestHeader("x-upsert", "false");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error("STORAGE_UPLOAD_FAILED"));
      }
    });
    request.addEventListener("error", () => reject(new Error("STORAGE_UPLOAD_FAILED")));
    request.addEventListener("timeout", () => reject(new Error("NETWORK_ERROR")));
    request.addEventListener("abort", () => reject(new Error("NETWORK_ERROR")));
    request.send(file);
  });
}
