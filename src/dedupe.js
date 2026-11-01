/**
 * Normalize company/role for dedupe keys.
 * @param {string} value
 * @returns {string}
 */
export function normalize(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Deduplicate jobs by company + role. Keeps first occurrence.
 * @param {Array<{ role: string, company: string, url: string, description?: string }>} jobs
 * @returns {Array<{ role: string, company: string, url: string, description?: string }>}
 */
export function dedupeJobs(jobs) {
  const seen = new Set();
  const unique = [];

  for (const job of jobs) {
    const key = `${normalize(job.company)}||${normalize(job.role)}`;
    if (!job.role || !job.company || seen.has(key)) continue;
    seen.add(key);
    unique.push(job);
  }

  return unique;
}
