import { createHash } from "node:crypto";
import type { GitHubClient } from "./client.js";
import { GitHubError } from "./errors.js";

/**
 * Git LFS without a checkout (spec 6.3): the Batch API with the basic
 * transfer and SHA-256 object IDs. Objects go to GitHub's LFS storage; the
 * repository holds only the pointer file.
 */

export interface LfsPointer {
  oid: string;
  size: number;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The pointer file git-lfs writes (spec v1). */
export function pointerText(p: LfsPointer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${p.oid}\nsize ${p.size}\n`;
}

export function parsePointer(text: string): LfsPointer | undefined {
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1")) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size ([0-9]+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : undefined;
}

interface Action {
  href: string;
  header?: Record<string, string>;
}

interface BatchObject {
  oid: string;
  size: number;
  actions?: { upload?: Action; verify?: Action; download?: Action };
  error?: { code: number; message: string };
}

const LFS_JSON = "application/vnd.git-lfs+json";

async function batch(client: GitHubClient, operation: "upload" | "download", obj: LfsPointer): Promise<BatchObject> {
  const url = `https://github.com/${client.repository}.git/info/lfs/objects/batch`;
  let res: Response;
  try {
    res = await client.fetcher(url, {
      method: "POST",
      headers: { Authorization: client.lfsAuthorization(), Accept: LFS_JSON, "Content-Type": LFS_JSON },
      body: JSON.stringify({ operation, transfers: ["basic"], objects: [{ oid: obj.oid, size: obj.size }], hash_algo: "sha256" }),
    });
  } catch (err) {
    throw new GitHubError(0, `could not reach Git LFS: ${(err as Error).message}`, "Check the network connection and run the command again.", `POST ${url}`);
  }
  const data = (await res.json().catch(() => ({}))) as { objects?: BatchObject[]; message?: string };
  if (!res.ok) {
    throw new GitHubError(res.status, `Git LFS ${operation} batch failed with ${res.status}: ${data.message ?? res.statusText}`, res.status === 401 || res.status === 403 ? "The token needs Contents read and write on the documentation repository (README section \"Documentation token\")." : "Run the command again.", `POST ${url}`);
  }
  const o = data.objects?.[0];
  if (!o) throw new GitHubError(502, "Git LFS answered without the object", "Run the command again.", `POST ${url}`);
  return o;
}

/** Uploads one object (skips the upload when the server already has it), then calls verify when given. */
export async function uploadObject(client: GitHubClient, data: Buffer): Promise<LfsPointer & { uploaded: boolean; verified: boolean }> {
  const p = { oid: sha256(data), size: data.length };
  const o = await batch(client, "upload", p);
  if (o.error) throw new GitHubError(o.error.code, `Git LFS refused the upload: ${o.error.message}`, "Check the file and run the command again.", "LFS upload");
  let uploaded = false;
  let verified = false;
  if (o.actions?.upload) {
    const up = await client.fetcher(o.actions.upload.href, { method: "PUT", headers: { ...o.actions.upload.header, "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });
    if (!up.ok) throw new GitHubError(up.status, `uploading the object failed with ${up.status}`, "Run the command again.", "LFS PUT");
    uploaded = true;
  }
  if (o.actions?.verify) {
    const v = await client.fetcher(o.actions.verify.href, { method: "POST", headers: { ...o.actions.verify.header, Accept: LFS_JSON, "Content-Type": LFS_JSON }, body: JSON.stringify({ oid: p.oid, size: p.size }) });
    if (!v.ok) throw new GitHubError(v.status, `Git LFS verify failed with ${v.status}`, "Run the command again.", "LFS verify");
    verified = true;
  }
  return { ...p, uploaded, verified };
}

/** Downloads one object and checks its SHA-256 and size. */
export async function downloadObject(client: GitHubClient, p: LfsPointer): Promise<Buffer> {
  const o = await batch(client, "download", p);
  if (o.error || !o.actions?.download) throw new GitHubError(o.error?.code ?? 404, `Git LFS has no object ${p.oid.slice(0, 12)}…: ${o.error?.message ?? "no download action"}`, "The binary was never uploaded; upload it again with `att create`.", "LFS download");
  const res = await client.fetcher(o.actions.download.href, { headers: o.actions.download.header });
  if (!res.ok) throw new GitHubError(res.status, `downloading the object failed with ${res.status}`, "Run the command again.", "LFS GET");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length !== p.size || sha256(data) !== p.oid) throw new GitHubError(422, "the downloaded object does not match its pointer (size or sha256)", "Report this; the stored object is damaged.", "LFS GET");
  return data;
}
