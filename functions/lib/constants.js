// Shared constants for Lwt's Store

export const PART_SIZE = 5 * 1024 * 1024; // 5MB per part (smaller to avoid Cloudflare Workers 503 from memory/CPU pressure)
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB max file size
export const MAX_BUCKET_SIZE_KB = 5 * 1024 * 1024; // 5GB in KB (GitHub API returns size in KB)
export const BUCKET_PREFIX = "lwtstore-bucket-";
export const GITHUB_API = "https://api.github.com";
export const RAW_GITHUB = "https://raw.githubusercontent.com";
