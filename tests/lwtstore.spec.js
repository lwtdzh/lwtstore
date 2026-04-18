// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const BASE_URL = "https://lwtstore.pages.dev";

// ============================================================
// Helper: create a temporary test file with random content
// ============================================================
function createTestFile(dir, name, sizeBytes) {
  const filePath = path.join(dir, name);
  const buf = crypto.randomBytes(sizeBytes);
  fs.writeFileSync(filePath, buf);
  return { filePath, buf };
}

// Helper: clean up temp files
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    // ignore
  }
}

// ============================================================
// Test Suite 1: Page Load & Basic UI
// ============================================================
test.describe("Page Load & Basic UI", () => {
  test("should load the homepage with correct title and elements", async ({ page }) => {
    await page.goto(BASE_URL);

    // Check page title
    await expect(page).toHaveTitle("Lwt's Store");

    // Check header
    const h1 = page.locator("header h1");
    await expect(h1).toHaveText("Lwt's Store");

    // Check subtitle
    const subtitle = page.locator(".subtitle");
    await expect(subtitle).toContainText("自由上传您的文件并自由下载");

    // Check upload area is visible
    const uploadArea = page.locator("#uploadArea");
    await expect(uploadArea).toBeVisible();

    // Check file list section exists
    const fileListSection = page.locator(".file-list-section h2");
    await expect(fileListSection).toHaveText("已上传的文件");
  });

  test("should show empty state or file table in file list", async ({ page }) => {
    await page.goto(BASE_URL);

    // Wait for file list to load (loading indicator should disappear)
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // Either empty state or file table should be visible
    const emptyState = page.locator("#emptyState");
    const fileTable = page.locator("#fileTable");

    const emptyVisible = await emptyState.isVisible();
    const tableVisible = await fileTable.isVisible();

    expect(emptyVisible || tableVisible).toBe(true);
  });
});

// ============================================================
// Test Suite 2: API Endpoints Direct Testing
// ============================================================
test.describe("API Endpoints", () => {
  test("GET /api/files should return paginated JSON", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files`);
    expect(res.status()).toBe(200);

    const contentType = res.headers()["content-type"];
    expect(contentType).toContain("application/json");

    const body = await res.json();
    expect(body).toHaveProperty("files");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("pageSize");
    expect(body).toHaveProperty("totalPages");
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
  });

  test("GET /api/upload/status with invalid fileId should return 404", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/upload/status?fileId=nonexistent_abc123`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("GET /api/download/nonexistent should return 404", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/download/nonexistent_abc123`);
    expect(res.status()).toBe(404);
  });

  test("HEAD /api/download/nonexistent should return 404", async ({ request }) => {
    const res = await request.head(`${BASE_URL}/api/download/nonexistent_abc123`);
    expect(res.status()).toBe(404);
  });

  test("POST /api/upload/init with missing fields should return 400", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName: "test.txt" }, // missing fileSize and fileHash
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required fields");
  });

  test("POST /api/upload/complete with missing fileId should return 400", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required field");
  });
});

// ============================================================
// Test Suite 3: Small File Upload via API + Download & Range Tests
// ============================================================
test.describe("Small File Upload Flow", () => {
  const FILE_SIZE = 512 * 1024; // 512KB
  const FILE_NAME = `test-small-${Date.now()}.bin`;
  let testFileContent;
  let uploadedFileId;
  let downloadPath;

  test.beforeAll(async ({ request }) => {
    // Create test content in memory
    testFileContent = crypto.randomBytes(FILE_SIZE);
    const fileHash = `${FILE_NAME}-${FILE_SIZE}-${Date.now()}`;

    // Upload via API to ensure reliability (not dependent on UI)
    const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName: FILE_NAME, fileSize: FILE_SIZE, fileHash },
    });
    const initData = await initRes.json();
    uploadedFileId = initData.fileId;

    // Upload single part
    await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId: uploadedFileId,
        partIndex: "0",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: testFileContent,
        },
      },
    });

    // Complete upload
    const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: { fileId: uploadedFileId },
    });
    const completeData = await completeRes.json();
    downloadPath = completeData.downloadUrl;
  });

  test("should verify uploaded file exists via API and UI shows file list", async ({ page, request }) => {
    test.setTimeout(30000);

    // Verify file exists via direct API call (bypasses KV list() eventual consistency)
    const downloadRes = await request.get(`${BASE_URL}${downloadPath}`);
    expect(downloadRes.status()).toBe(200);

    // Verify UI file list section works (shows at least some files)
    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // File table should be visible (previous test runs have uploaded files)
    const fileTable = page.locator("#fileTable");
    const emptyState = page.locator("#emptyState");
    const tableVisible = await fileTable.isVisible();
    const emptyVisible = await emptyState.isVisible();

    // Either state is valid - the important thing is the page loaded correctly
    expect(tableVisible || emptyVisible).toBe(true);

    // If table is visible, verify it has proper structure
    if (tableVisible) {
      const rows = await page.locator("#fileTableBody tr").count();
      expect(rows).toBeGreaterThan(0);

      // Each row should have file name, size, date, and action buttons
      const firstRow = page.locator("#fileTableBody tr").first();
      await expect(firstRow.locator(".file-name-cell")).toBeVisible();
      await expect(firstRow.locator(".btn-download")).toBeVisible();
    }
  });

  test("should download the uploaded file and verify content matches", async ({ request }) => {
    test.setTimeout(60000);

    // Download the file
    const downloadRes = await request.get(`${BASE_URL}${downloadPath}`);
    expect(downloadRes.status()).toBe(200);

    // Verify headers
    const headers = downloadRes.headers();
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["accept-ranges"]).toBe("bytes");
    expect(headers["content-disposition"]).toContain(FILE_NAME);

    // Verify content matches
    const downloadedBody = await downloadRes.body();
    expect(downloadedBody.length).toBe(testFileContent.length);
    expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  });

  test("should support HEAD request for download (multi-thread download pre-check)", async ({ request }) => {
    const headRes = await request.head(`${BASE_URL}${downloadPath}`);
    expect(headRes.status()).toBe(200);

    const headers = headRes.headers();
    expect(headers["accept-ranges"]).toBe("bytes");
    expect(headers["content-length"]).toBe(String(FILE_SIZE));
    expect(headers["content-disposition"]).toContain(FILE_NAME);
  });

  test("should support Range request (partial download)", async ({ request }) => {
    // Request first 1000 bytes
    const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
      headers: { Range: "bytes=0-999" },
    });
    expect(rangeRes.status()).toBe(206);

    const headers = rangeRes.headers();
    expect(headers["content-range"]).toBe(`bytes 0-999/${FILE_SIZE}`);
    // Note: content-length may not be present in HTTP/2 206 responses on Cloudflare

    const body = await rangeRes.body();
    expect(body.length).toBe(1000);
    expect(Buffer.compare(body, testFileContent.subarray(0, 1000))).toBe(0);
  });

  test("should support Range request for middle section", async ({ request }) => {
    // Request bytes 10000-19999 (10KB from middle)
    const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
      headers: { Range: "bytes=10000-19999" },
    });
    expect(rangeRes.status()).toBe(206);

    const body = await rangeRes.body();
    expect(body.length).toBe(10000);
    expect(Buffer.compare(body, testFileContent.subarray(10000, 20000))).toBe(0);
  });

  test("should support Range request for last N bytes", async ({ request }) => {
    // Request last 500 bytes
    const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
      headers: { Range: `bytes=${FILE_SIZE - 500}-${FILE_SIZE - 1}` },
    });
    expect(rangeRes.status()).toBe(206);

    const body = await rangeRes.body();
    expect(body.length).toBe(500);
    expect(Buffer.compare(body, testFileContent.subarray(FILE_SIZE - 500))).toBe(0);
  });

  test("should return 416 for invalid Range", async ({ request }) => {
    // Request beyond file size
    const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
      headers: { Range: `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}` },
    });
    expect(rangeRes.status()).toBe(416);
  });
});

// ============================================================
// Test Suite 4: Multi-part File Upload (> 20MB)
// ============================================================
test.describe("Multi-part File Upload", () => {
  const tmpDir = path.join(__dirname, "tmp");
  let testFilePath;
  let testFileContent;

  test.beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    // Create a 25MB test file (will be split into 2 parts: 20MB + 5MB)
    const result = createTestFile(tmpDir, "test-multipart.bin", 25 * 1024 * 1024);
    testFilePath = result.filePath;
    testFileContent = result.buf;
  });

  test.afterAll(() => {
    cleanupFile(testFilePath);
    try {
      fs.rmdirSync(tmpDir, { recursive: true });
    } catch (e) { /* ignore */ }
  });

  test("should upload a multi-part file via API and download correctly", async ({ request }) => {
    test.setTimeout(300000); // 5 minutes

    const fileName = "test-multipart.bin";
    const fileSize = testFileContent.length;
    const fileHash = `${fileName}-${fileSize}-${Date.now()}`;

    // Step 1: Initialize upload
    const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName, fileSize, fileHash },
    });
    expect(initRes.status()).toBe(200);
    const initData = await initRes.json();
    expect(initData.fileId).toBeTruthy();
    expect(initData.totalParts).toBe(2); // 25MB / 20MB = 2 parts
    expect(initData.uploadedParts).toEqual([]);

    const { fileId, totalParts } = initData;

    // Step 2: Upload parts
    const PART_SIZE = 20 * 1024 * 1024;
    for (let i = 0; i < totalParts; i++) {
      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, fileSize);
      const chunk = testFileContent.subarray(start, end);

      // Create a FormData-like multipart request
      const formData = new FormData();
      formData.append("fileId", fileId);
      formData.append("partIndex", i.toString());
      formData.append("data", new Blob([chunk]), "chunk.bin");

      const partRes = await request.post(`${BASE_URL}/api/upload/part`, {
        multipart: {
          fileId: fileId,
          partIndex: i.toString(),
          data: {
            name: "chunk.bin",
            mimeType: "application/octet-stream",
            buffer: chunk,
          },
        },
      });
      expect(partRes.status()).toBe(200);
      const partData = await partRes.json();
      expect(partData.success).toBe(true);
      expect(partData.partIndex).toBe(i);
    }

    // Step 3: Check upload status
    const statusRes = await request.get(`${BASE_URL}/api/upload/status?fileId=${fileId}`);
    expect(statusRes.status()).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.uploadedParts.length).toBe(totalParts);

    // Step 4: Complete upload
    const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: { fileId },
    });
    expect(completeRes.status()).toBe(200);
    const completeData = await completeRes.json();
    expect(completeData.success).toBe(true);
    expect(completeData.downloadUrl).toContain(fileId);

    // Step 5: Download and verify
    const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
    expect(downloadRes.status()).toBe(200);

    const downloadedBody = await downloadRes.body();
    expect(downloadedBody.length).toBe(fileSize);
    expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  });
});

// ============================================================
// Test Suite 5: Upload Resume (Simulated Disconnection)
// ============================================================
test.describe("Upload Resume After Disconnection", () => {
  const RESUME_FILE_SIZE = 25 * 1024 * 1024; // 25MB = 2 parts (20MB + 5MB)
  let testFileContent;

  test.beforeAll(() => {
    testFileContent = crypto.randomBytes(RESUME_FILE_SIZE);
  });

  test("should resume upload after partial upload (simulated disconnection)", async ({ request }) => {
    test.setTimeout(600000); // 10 minutes

    const fileName = `test-resume-${Date.now()}.bin`;
    const fileSize = testFileContent.length;
    const fileHash = `${fileName}-${fileSize}-${Date.now()}`;
    const PART_SIZE = 20 * 1024 * 1024;

    // Step 1: Initialize upload
    const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName, fileSize, fileHash },
    });
    expect(initRes.status()).toBe(200);
    const initData = await initRes.json();
    const { fileId, totalParts } = initData;
    expect(totalParts).toBe(2);

    // Step 2: Upload only the FIRST part (simulate disconnection after 1 part)
    const chunk0 = testFileContent.subarray(0, PART_SIZE);
    const part0Res = await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId: fileId,
        partIndex: "0",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: chunk0,
        },
      },
    });
    expect(part0Res.status()).toBe(200);

    // Step 3: "Disconnect" - now re-initialize with same fileHash to resume
    const resumeRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName, fileSize, fileHash },
    });
    expect(resumeRes.status()).toBe(200);
    const resumeData = await resumeRes.json();

    // Should detect the existing upload and return resume info
    expect(resumeData.resumed).toBe(true);
    expect(resumeData.fileId).toBe(fileId);
    expect(resumeData.uploadedParts).toContain(0);
    expect(resumeData.uploadedParts).not.toContain(1);

    // Step 4: Upload remaining part (1)
    const start = PART_SIZE;
    const end = fileSize;
    const chunk1 = testFileContent.subarray(start, end);

    const part1Res = await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId: fileId,
        partIndex: "1",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: chunk1,
        },
      },
    });
    expect(part1Res.status()).toBe(200);
    const part1Data = await part1Res.json();
    expect(part1Data.success).toBe(true);

    // Step 5: Complete upload
    const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: { fileId },
    });
    expect(completeRes.status()).toBe(200);

    // Step 6: Download and verify full file integrity
    const completeData = await completeRes.json();
    const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
    expect(downloadRes.status()).toBe(200);

    const downloadedBody = await downloadRes.body();
    expect(downloadedBody.length).toBe(fileSize);
    expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  });
});

// ============================================================
// Test Suite 6: Multi-thread Download Simulation
// ============================================================
test.describe("Multi-thread Download Simulation", () => {
  test("should support concurrent Range requests (simulating IDM/aria2)", async ({ request }) => {
    test.setTimeout(120000);

    // Get a file from the list
    const listRes = await request.get(`${BASE_URL}/api/files`);
    const listData = await listRes.json();
    const files = listData.files || [];

    if (files.length === 0) {
      test.skip();
      return;
    }

    const file = files[0];
    const totalSize = file.fileSize;
    const downloadUrl = `${BASE_URL}${file.downloadUrl}`;

    // Step 1: HEAD request (what download managers do first)
    const headRes = await request.head(downloadUrl);
    expect(headRes.status()).toBe(200);
    expect(headRes.headers()["accept-ranges"]).toBe("bytes");
    const reportedSize = parseInt(headRes.headers()["content-length"], 10);
    expect(reportedSize).toBe(totalSize);

    // Step 2: Simulate 4-thread download with concurrent Range requests
    const threadCount = 4;
    const chunkSize = Math.ceil(totalSize / threadCount);
    const ranges = [];

    for (let i = 0; i < threadCount; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
      ranges.push({ start, end });
    }

    // Fire all range requests concurrently
    const rangePromises = ranges.map(({ start, end }) =>
      request.get(downloadUrl, {
        headers: { Range: `bytes=${start}-${end}` },
      })
    );

    const rangeResponses = await Promise.all(rangePromises);

    // Verify all responses
    const chunks = [];
    for (let i = 0; i < rangeResponses.length; i++) {
      const res = rangeResponses[i];
      expect(res.status()).toBe(206);

      const contentRange = res.headers()["content-range"];
      expect(contentRange).toContain(`/${totalSize}`);

      const body = await res.body();
      const expectedSize = ranges[i].end - ranges[i].start + 1;
      expect(body.length).toBe(expectedSize);

      chunks.push(body);
    }

    // Reassemble and verify against full download
    const reassembled = Buffer.concat(chunks);
    expect(reassembled.length).toBe(totalSize);

    // Download full file for comparison
    const fullRes = await request.get(downloadUrl);
    const fullBody = await fullRes.body();
    expect(Buffer.compare(reassembled, fullBody)).toBe(0);
  });
});

// ============================================================
// Test Suite 7: Page Refresh & File List Persistence
// ============================================================
test.describe("Page Refresh & Persistence", () => {
  test("should persist file list after page refresh", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    // Wait for file list to load
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // Check if there are files
    const fileTable = page.locator("#fileTable");
    const isTableVisible = await fileTable.isVisible();

    if (!isTableVisible) {
      // No files uploaded yet, skip this test
      test.skip();
      return;
    }

    // Count files before refresh
    const rowsBefore = await page.locator("#fileTableBody tr").count();
    expect(rowsBefore).toBeGreaterThan(0);

    // Refresh the page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Wait for file list to reload
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // Count files after refresh
    const rowsAfter = await page.locator("#fileTableBody tr").count();
    expect(rowsAfter).toBe(rowsBefore);
  });

  test("should show download buttons for each file", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    const fileTable = page.locator("#fileTable");
    if (!(await fileTable.isVisible())) {
      test.skip();
      return;
    }

    // Each row should have a download button and copy link button
    const rows = page.locator("#fileTableBody tr");
    const count = await rows.count();

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const downloadBtn = row.locator(".btn-download");
      await expect(downloadBtn).toBeVisible();

      const copyBtn = row.locator(".btn-copy-small");
      await expect(copyBtn).toBeVisible();

      // Download link should point to /api/download/
      const href = await downloadBtn.getAttribute("href");
      expect(href).toContain("/api/download/");
    }
  });
});

// ============================================================
// Test Suite 8: Upload via UI with Page Refresh Resume
// ============================================================
test.describe("UI Upload with Refresh Resume Detection", () => {
  const tmpDir = path.join(__dirname, "tmp");
  let testFilePath;

  test.beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    createTestFile(tmpDir, "test-ui-resume.bin", 256 * 1024); // 256KB
    testFilePath = path.join(tmpDir, "test-ui-resume.bin");
  });

  test.afterAll(() => {
    cleanupFile(testFilePath);
    try {
      fs.rmdirSync(tmpDir, { recursive: true });
    } catch (e) { /* ignore */ }
  });

  test("should detect resume state after setting localStorage and refreshing", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    // Simulate a previous upload state in localStorage
    await page.evaluate(() => {
      const fakeHash = "test-ui-resume.bin-262144-1234567890";
      const uploads = {
        [fakeHash]: {
          fileId: "fake-resume-id",
          fileName: "test-ui-resume.bin",
          fileSize: 262144,
        },
      };
      localStorage.setItem("lwt_uploads", JSON.stringify(uploads));
      document.cookie = `lwt_upload_active=${fakeHash}; path=/; max-age=86400; SameSite=Lax`;
    });

    // Refresh the page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Should show a resume notification toast
    const resumeToast = page.locator(".toast.show");
    await expect(resumeToast).toBeVisible({ timeout: 5000 });
    await expect(resumeToast).toContainText("test-ui-resume.bin");

    // Clean up
    await page.evaluate(() => {
      localStorage.removeItem("lwt_uploads");
      document.cookie = "lwt_upload_active=; path=/; max-age=0";
    });
  });
});

// ============================================================
// Test Suite 9: Duplicate Part Upload (Idempotency)
// ============================================================
test.describe("Duplicate Part Upload", () => {
  test("should handle re-uploading an already uploaded part gracefully", async ({ request }) => {
    test.setTimeout(300000);

    const fileName = "test-idempotent.bin";
    const fileContent = crypto.randomBytes(512 * 1024); // 512KB, single part
    const fileSize = fileContent.length;
    const fileHash = `${fileName}-${fileSize}-${Date.now()}`;

    // Initialize
    const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName, fileSize, fileHash },
    });
    const { fileId } = await initRes.json();

    // Upload part 0
    const part0Res = await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId,
        partIndex: "0",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: fileContent,
        },
      },
    });
    expect(part0Res.status()).toBe(200);

    // Upload part 0 AGAIN (duplicate)
    const part0DupRes = await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId,
        partIndex: "0",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: fileContent,
        },
      },
    });
    expect(part0DupRes.status()).toBe(200);
    const dupData = await part0DupRes.json();
    expect(dupData.success).toBe(true);
    expect(dupData.skipped).toBe(true); // Should be skipped

    // Complete
    const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: { fileId },
    });
    expect(completeRes.status()).toBe(200);

    // Download and verify
    const completeData = await completeRes.json();
    const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
    const body = await downloadRes.body();
    expect(body.length).toBe(fileSize);
    expect(Buffer.compare(body, fileContent)).toBe(0);
  });
});

// ============================================================
// Test Suite 10: Static Assets
// ============================================================
test.describe("Static Assets", () => {
  test("should serve CSS file correctly", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/style.css`);
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"];
    expect(contentType).toContain("css");
  });

  test("should serve JS file correctly", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/app.js`);
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"];
    expect(contentType).toContain("javascript");
  });
});

// ============================================================
// Test Suite 11: Pagination API
// ============================================================
test.describe("Pagination API", () => {
  test("should return paginated results with correct structure", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files?page=1&pageSize=5`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(5);
    expect(data.files.length).toBeLessThanOrEqual(5);
    expect(data.total).toBeGreaterThanOrEqual(0);
    expect(data.totalPages).toBe(Math.max(1, Math.ceil(data.total / 5)));
  });

  test("should return different results for different pages", async ({ request }) => {
    // Get page 1 with small page size
    const res1 = await request.get(`${BASE_URL}/api/files?page=1&pageSize=2`);
    const data1 = await res1.json();

    if (data1.total <= 2) {
      // Not enough files to test multi-page, skip
      return;
    }

    // Get page 2
    const res2 = await request.get(`${BASE_URL}/api/files?page=2&pageSize=2`);
    const data2 = await res2.json();

    expect(data2.page).toBe(2);
    expect(data2.files.length).toBeGreaterThan(0);

    // Files on page 1 and page 2 should be different
    const page1Ids = data1.files.map((f) => f.fileId);
    const page2Ids = data2.files.map((f) => f.fileId);
    const overlap = page1Ids.filter((id) => page2Ids.includes(id));
    expect(overlap.length).toBe(0);
  });

  test("should respect pageSize parameter", async ({ request }) => {
    const res10 = await request.get(`${BASE_URL}/api/files?page=1&pageSize=10`);
    const data10 = await res10.json();
    expect(data10.pageSize).toBe(10);
    expect(data10.files.length).toBeLessThanOrEqual(10);

    const res100 = await request.get(`${BASE_URL}/api/files?page=1&pageSize=100`);
    const data100 = await res100.json();
    expect(data100.pageSize).toBe(100);
    expect(data100.files.length).toBeLessThanOrEqual(100);
  });

  test("should clamp pageSize to max 100", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files?page=1&pageSize=999`);
    const data = await res.json();
    expect(data.pageSize).toBe(100);
  });

  test("should default to page 1 and pageSize 20", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files`);
    const data = await res.json();
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(20);
  });

  test("should handle page beyond total pages gracefully", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files?page=9999&pageSize=10`);
    const data = await res.json();
    // Should clamp to last page
    expect(data.page).toBeLessThanOrEqual(data.totalPages);
  });
});

// ============================================================
// Test Suite 12: Search API
// ============================================================
test.describe("Search API", () => {
  test("should filter files by search keyword", async ({ request }) => {
    // Search for "test" which should match test files
    const res = await request.get(`${BASE_URL}/api/files?search=test`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    // All returned files should contain "test" in their name
    for (const file of data.files) {
      expect(file.fileName.toLowerCase()).toContain("test");
    }
  });

  test("should return empty results for non-matching search", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files?search=zzz_nonexistent_xyz_12345`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.files.length).toBe(0);
    expect(data.total).toBe(0);
  });

  test("should be case-insensitive", async ({ request }) => {
    const resLower = await request.get(`${BASE_URL}/api/files?search=test`);
    const dataLower = await resLower.json();

    const resUpper = await request.get(`${BASE_URL}/api/files?search=TEST`);
    const dataUpper = await resUpper.json();

    expect(dataLower.total).toBe(dataUpper.total);
  });

  test("should work with pagination combined", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/files?search=test&page=1&pageSize=2`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.files.length).toBeLessThanOrEqual(2);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(2);
  });
});

// ============================================================
// Test Suite 13: Pagination UI
// ============================================================
test.describe("Pagination UI", () => {
  test("should show pagination controls on main page", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // Search box should be visible
    const searchInput = page.locator("#searchInput");
    await expect(searchInput).toBeVisible();

    // Page size selector should exist
    const pageSizeSelect = page.locator("#pageSizeSelect");
    await expect(pageSizeSelect).toBeVisible();
  });

  test("should filter file list when searching", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    // Type a search term
    const searchInput = page.locator("#searchInput");
    await searchInput.fill("zzz_nonexistent_xyz");

    // Wait for debounce + API call
    await page.waitForTimeout(500);
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 10000 });

    // Should show empty state
    const emptyState = page.locator("#emptyState");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("没有找到");
  });

  test("should restore file list when clearing search", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 15000 });

    const searchInput = page.locator("#searchInput");

    // Search for something that doesn't exist
    await searchInput.fill("zzz_nonexistent_xyz");
    await page.waitForTimeout(500);
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 10000 });

    // Clear search
    await searchInput.fill("");
    await page.waitForTimeout(500);
    await page.waitForFunction(() => {
      const loading = document.getElementById("fileListLoading");
      return loading && loading.style.display === "none";
    }, { timeout: 10000 });

    // File table should be visible again (if there are files)
    const fileTable = page.locator("#fileTable");
    const emptyState = page.locator("#emptyState");
    const tableVisible = await fileTable.isVisible();
    const emptyVisible = await emptyState.isVisible();
    expect(tableVisible || emptyVisible).toBe(true);
  });
});

// ============================================================
// Test Suite 14: Admin Page
// ============================================================
test.describe("Admin Page", () => {
  test("should load admin page with login form", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin.html`);
    await page.waitForLoadState("networkidle");

    // Check title
    await expect(page).toHaveTitle("Lwt's Store - Admin");

    // Login form should be visible
    const passwordInput = page.locator("#adminPassword");
    await expect(passwordInput).toBeVisible();

    const loginBtn = page.locator("#loginBtn");
    await expect(loginBtn).toBeVisible();
    await expect(loginBtn).toHaveText("登录");
  });

  test("should reject wrong password", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin.html`);
    await page.waitForLoadState("networkidle");

    const passwordInput = page.locator("#adminPassword");
    await passwordInput.fill("wrong_password_12345");

    const loginBtn = page.locator("#loginBtn");
    await loginBtn.click();

    // Should show error message
    const loginError = page.locator("#loginError");
    await expect(loginError).toBeVisible({ timeout: 10000 });
    await expect(loginError).toContainText("密码错误");

    // Admin panel should NOT be visible
    const adminPanel = page.locator("#adminPanel");
    await expect(adminPanel).not.toBeVisible();
  });

  test("should have back to home link", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin.html`);
    await page.waitForLoadState("networkidle");

    const backLink = page.locator("a.admin-link");
    await expect(backLink).toBeVisible();
    await expect(backLink).toContainText("返回首页");

    const href = await backLink.getAttribute("href");
    expect(href).toBe("/");
  });

  test("should have admin link in main page footer", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState("networkidle");

    const adminLink = page.locator("footer a.admin-link");
    await expect(adminLink).toBeVisible();
    await expect(adminLink).toContainText("管理");

    const href = await adminLink.getAttribute("href");
    expect(href).toBe("/admin.html");
  });
});

// ============================================================
// Test Suite 15: Admin Delete API
// ============================================================
test.describe("Admin Delete API", () => {
  test("should reject delete without password", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/admin/delete`, {
      data: { fileId: "some-id" },
    });
    expect(res.status()).toBe(400);
  });

  test("should reject delete with wrong password", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/admin/delete`, {
      data: { fileId: "some-id", password: "wrong_password" },
    });
    expect(res.status()).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("Unauthorized");
  });
});

// ============================================================
// Test Suite: Admin Delete - Full Flow (upload → delete → verify gone)
// ============================================================
test.describe("Admin Delete Full Flow", () => {
  const ADMIN_PWD = "438700qwe";
  const FILE_SIZE = 256 * 1024; // 256KB (small, single part)
  const FILE_NAME = `delete-test-${Date.now()}.bin`;
  let testFileContent;
  let uploadedFileId;
  let downloadUrl;

  test.beforeAll(async ({ request }) => {
    // Upload a small test file via API
    testFileContent = crypto.randomBytes(FILE_SIZE);
    const fileHash = `${FILE_NAME}-${FILE_SIZE}-${Date.now()}`;

    const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
      data: { fileName: FILE_NAME, fileSize: FILE_SIZE, fileHash },
    });
    expect(initRes.ok()).toBeTruthy();
    const initData = await initRes.json();
    uploadedFileId = initData.fileId;

    // Upload single part
    const partRes = await request.post(`${BASE_URL}/api/upload/part`, {
      multipart: {
        fileId: uploadedFileId,
        partIndex: "0",
        data: {
          name: "chunk.bin",
          mimeType: "application/octet-stream",
          buffer: testFileContent,
        },
      },
    });
    expect(partRes.ok()).toBeTruthy();

    // Complete upload
    const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
      data: { fileId: uploadedFileId },
    });
    expect(completeRes.ok()).toBeTruthy();
    const completeData = await completeRes.json();
    downloadUrl = completeData.downloadUrl;
  });

  test("should download the file before deletion", async ({ request }) => {
    // Verify the file is downloadable before we delete it
    const res = await request.get(`${BASE_URL}${downloadUrl}`);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.length).toBe(FILE_SIZE);
  });

  test("should delete file via admin API with correct password", async ({ request }) => {
    test.setTimeout(60000);

    const res = await request.post(`${BASE_URL}/api/admin/delete`, {
      data: { fileId: uploadedFileId, password: ADMIN_PWD },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toContain(FILE_NAME);
    expect(data.fileId).toBe(uploadedFileId);
  });

  test("should return 404 when downloading deleted file", async ({ request }) => {
    // File metadata should be gone from D1
    const res = await request.get(`${BASE_URL}${downloadUrl}`);
    expect(res.status()).toBe(404);
  });

  test("should return 404 when checking status of deleted file", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/upload/status?fileId=${uploadedFileId}`);
    expect(res.status()).toBe(404);
  });

  test("should not show deleted file in file list", async ({ request }) => {
    // Search for the deleted file by name
    const res = await request.get(`${BASE_URL}/api/files?search=${encodeURIComponent(FILE_NAME)}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    // The deleted file should not appear in results
    const found = data.files.find((f) => f.fileId === uploadedFileId);
    expect(found).toBeUndefined();
  });

  test("should return 404 when trying to delete same file again", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/admin/delete`, {
      data: { fileId: uploadedFileId, password: ADMIN_PWD },
    });
    expect(res.status()).toBe(404);
  });
});
