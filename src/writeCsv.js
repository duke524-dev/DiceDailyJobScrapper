import fs from "node:fs";
import path from "node:path";

/**
 * Escape a CSV field (RFC 4180-ish).
 * @param {string} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * @param {Array<{ role: string, company: string, url: string, description?: string }>} jobs
 * @returns {string}
 */
function buildCsv(jobs) {
  const lines = ["role,company,url,description"];
  for (const job of jobs) {
    lines.push(
      [job.role, job.company, job.url, job.description ?? ""]
        .map(escapeCsvField)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Write jobs to a CSV file with columns: role, company, url, description.
 * Uses a temp file + rename; falls back to a timestamped name if the target is locked.
 * @param {Array<{ role: string, company: string, url: string, description?: string }>} jobs
 * @param {string} filePath
 * @returns {string} path actually written
 */
export function writeCsv(jobs, filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const contents = buildCsv(jobs);
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  fs.writeFileSync(tmpPath, contents, "utf8");

  try {
    fs.renameSync(tmpPath, filePath);
    return filePath;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const alt = filePath.replace(/\.csv$/i, `-${stamp}.csv`);
      try {
        fs.renameSync(tmpPath, alt);
      } catch {
        fs.copyFileSync(tmpPath, alt);
        fs.unlinkSync(tmpPath);
      }
      console.warn(`Could not overwrite ${filePath} (file locked); wrote ${alt}`);
      return alt;
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Today's date as YYYY-MM-DD (local).
 * @returns {string}
 */
export function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
