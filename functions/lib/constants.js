// Shared constants for Lwt's Store

export const PART_SIZE = 20 * 1024 * 1024; // 20MB per part
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB max file size
export const MAX_BUCKET_SIZE_KB = 1; // TEMP: 1KB for bucket-full testing (restore to 5 * 1024 * 1024 after test)
export const BUCKET_PREFIX = "lwtstore-bucket-";
export const GITHUB_API = "https://api.github.com";
export const RAW_GITHUB = "https://raw.githubusercontent.com";
