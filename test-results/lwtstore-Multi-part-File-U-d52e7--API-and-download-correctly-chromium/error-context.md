# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lwtstore.spec.js >> Multi-part File Upload >> should upload a multi-part file via API and download correctly
- Location: tests/lwtstore.spec.js:314:3

# Error details

```
TimeoutError: apiRequestContext.get: Timeout 30000ms exceeded.
Call log:
  - → GET https://lwtstore.pages.dev/api/download/mo3s8yod-7hu68dsi
    - user-agent: Playwright/1.59.1 (arm64; macOS 26.3) node/25.8
    - accept: */*
    - accept-encoding: gzip,deflate,br
  - ← 200 OK
    - date: Sat, 18 Apr 2026 03:34:19 GMT
    - content-type: application/octet-stream
    - transfer-encoding: chunked
    - connection: keep-alive
    - cf-ray: 9ee09cf17ceb5580-SEA
    - accept-ranges: bytes
    - access-control-allow-origin: *
    - cache-control: public, max-age=31536000, immutable
    - content-disposition: attachment; filename="test-multipart.bin"; filename*=UTF-8''test-multipart.bin
    - etag: "mo3s8yod-7hu68dsi"
    - access-control-expose-headers: Content-Length, Content-Range, Accept-Ranges, Content-Disposition
    - report-to: {"endpoints":[{"url":"https:\/\/a.nel.cloudflare.com\/report\/v4?s=uh5wjFHTLlVIKhhFFdLl1RULhulDhwsL901qfyZOu4bXIeoTj0F7fItsnEJkibwNLX2MlWYQIWDCTfzQ4SB3HrDxAGzInqSuYTiTdTiwlEiOL6gGKKYVVXOU2QOjtYa3SFW%2FPlU%3D"}],"group":"cf-nel","max_age":604800}
    - nel: {"success_fraction":0,"report_to":"cf-nel","max_age":604800}
    - vary: Accept-Encoding
    - server: cloudflare
    - alt-svc: h3=":443"; ma=86400

```

# Test source

```ts
  279 |     expect(Buffer.compare(body, testFileContent.subarray(FILE_SIZE - 500))).toBe(0);
  280 |   });
  281 | 
  282 |   test("should return 416 for invalid Range", async ({ request }) => {
  283 |     // Request beyond file size
  284 |     const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
  285 |       headers: { Range: `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}` },
  286 |     });
  287 |     expect(rangeRes.status()).toBe(416);
  288 |   });
  289 | });
  290 | 
  291 | // ============================================================
  292 | // Test Suite 4: Multi-part File Upload (> 20MB)
  293 | // ============================================================
  294 | test.describe("Multi-part File Upload", () => {
  295 |   const tmpDir = path.join(__dirname, "tmp");
  296 |   let testFilePath;
  297 |   let testFileContent;
  298 | 
  299 |   test.beforeAll(() => {
  300 |     if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  301 |     // Create a 25MB test file (will be split into 2 parts: 20MB + 5MB)
  302 |     const result = createTestFile(tmpDir, "test-multipart.bin", 25 * 1024 * 1024);
  303 |     testFilePath = result.filePath;
  304 |     testFileContent = result.buf;
  305 |   });
  306 | 
  307 |   test.afterAll(() => {
  308 |     cleanupFile(testFilePath);
  309 |     try {
  310 |       fs.rmdirSync(tmpDir, { recursive: true });
  311 |     } catch (e) { /* ignore */ }
  312 |   });
  313 | 
  314 |   test("should upload a multi-part file via API and download correctly", async ({ request }) => {
  315 |     test.setTimeout(300000); // 5 minutes
  316 | 
  317 |     const fileName = "test-multipart.bin";
  318 |     const fileSize = testFileContent.length;
  319 |     const fileHash = `${fileName}-${fileSize}-${Date.now()}`;
  320 | 
  321 |     // Step 1: Initialize upload
  322 |     const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
  323 |       data: { fileName, fileSize, fileHash },
  324 |     });
  325 |     expect(initRes.status()).toBe(200);
  326 |     const initData = await initRes.json();
  327 |     expect(initData.fileId).toBeTruthy();
  328 |     expect(initData.totalParts).toBe(2); // 25MB / 20MB = 2 parts
  329 |     expect(initData.uploadedParts).toEqual([]);
  330 | 
  331 |     const { fileId, totalParts } = initData;
  332 | 
  333 |     // Step 2: Upload parts
  334 |     const PART_SIZE = 20 * 1024 * 1024;
  335 |     for (let i = 0; i < totalParts; i++) {
  336 |       const start = i * PART_SIZE;
  337 |       const end = Math.min(start + PART_SIZE, fileSize);
  338 |       const chunk = testFileContent.subarray(start, end);
  339 | 
  340 |       // Create a FormData-like multipart request
  341 |       const formData = new FormData();
  342 |       formData.append("fileId", fileId);
  343 |       formData.append("partIndex", i.toString());
  344 |       formData.append("data", new Blob([chunk]), "chunk.bin");
  345 | 
  346 |       const partRes = await request.post(`${BASE_URL}/api/upload/part`, {
  347 |         multipart: {
  348 |           fileId: fileId,
  349 |           partIndex: i.toString(),
  350 |           data: {
  351 |             name: "chunk.bin",
  352 |             mimeType: "application/octet-stream",
  353 |             buffer: chunk,
  354 |           },
  355 |         },
  356 |       });
  357 |       expect(partRes.status()).toBe(200);
  358 |       const partData = await partRes.json();
  359 |       expect(partData.success).toBe(true);
  360 |       expect(partData.partIndex).toBe(i);
  361 |     }
  362 | 
  363 |     // Step 3: Check upload status
  364 |     const statusRes = await request.get(`${BASE_URL}/api/upload/status?fileId=${fileId}`);
  365 |     expect(statusRes.status()).toBe(200);
  366 |     const statusData = await statusRes.json();
  367 |     expect(statusData.uploadedParts.length).toBe(totalParts);
  368 | 
  369 |     // Step 4: Complete upload
  370 |     const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
  371 |       data: { fileId },
  372 |     });
  373 |     expect(completeRes.status()).toBe(200);
  374 |     const completeData = await completeRes.json();
  375 |     expect(completeData.success).toBe(true);
  376 |     expect(completeData.downloadUrl).toContain(fileId);
  377 | 
  378 |     // Step 5: Download and verify
> 379 |     const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
      |                                       ^ TimeoutError: apiRequestContext.get: Timeout 30000ms exceeded.
  380 |     expect(downloadRes.status()).toBe(200);
  381 | 
  382 |     const downloadedBody = await downloadRes.body();
  383 |     expect(downloadedBody.length).toBe(fileSize);
  384 |     expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  385 |   });
  386 | });
  387 | 
  388 | // ============================================================
  389 | // Test Suite 5: Upload Resume (Simulated Disconnection)
  390 | // ============================================================
  391 | test.describe("Upload Resume After Disconnection", () => {
  392 |   const RESUME_FILE_SIZE = 25 * 1024 * 1024; // 25MB = 2 parts (20MB + 5MB)
  393 |   let testFileContent;
  394 | 
  395 |   test.beforeAll(() => {
  396 |     testFileContent = crypto.randomBytes(RESUME_FILE_SIZE);
  397 |   });
  398 | 
  399 |   test("should resume upload after partial upload (simulated disconnection)", async ({ request }) => {
  400 |     test.setTimeout(600000); // 10 minutes
  401 | 
  402 |     const fileName = `test-resume-${Date.now()}.bin`;
  403 |     const fileSize = testFileContent.length;
  404 |     const fileHash = `${fileName}-${fileSize}-${Date.now()}`;
  405 |     const PART_SIZE = 20 * 1024 * 1024;
  406 | 
  407 |     // Step 1: Initialize upload
  408 |     const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
  409 |       data: { fileName, fileSize, fileHash },
  410 |     });
  411 |     expect(initRes.status()).toBe(200);
  412 |     const initData = await initRes.json();
  413 |     const { fileId, totalParts } = initData;
  414 |     expect(totalParts).toBe(2);
  415 | 
  416 |     // Step 2: Upload only the FIRST part (simulate disconnection after 1 part)
  417 |     const chunk0 = testFileContent.subarray(0, PART_SIZE);
  418 |     const part0Res = await request.post(`${BASE_URL}/api/upload/part`, {
  419 |       multipart: {
  420 |         fileId: fileId,
  421 |         partIndex: "0",
  422 |         data: {
  423 |           name: "chunk.bin",
  424 |           mimeType: "application/octet-stream",
  425 |           buffer: chunk0,
  426 |         },
  427 |       },
  428 |     });
  429 |     expect(part0Res.status()).toBe(200);
  430 | 
  431 |     // Step 3: "Disconnect" - now re-initialize with same fileHash to resume
  432 |     const resumeRes = await request.post(`${BASE_URL}/api/upload/init`, {
  433 |       data: { fileName, fileSize, fileHash },
  434 |     });
  435 |     expect(resumeRes.status()).toBe(200);
  436 |     const resumeData = await resumeRes.json();
  437 | 
  438 |     // Should detect the existing upload and return resume info
  439 |     expect(resumeData.resumed).toBe(true);
  440 |     expect(resumeData.fileId).toBe(fileId);
  441 |     expect(resumeData.uploadedParts).toContain(0);
  442 |     expect(resumeData.uploadedParts).not.toContain(1);
  443 | 
  444 |     // Step 4: Upload remaining part (1)
  445 |     const start = PART_SIZE;
  446 |     const end = fileSize;
  447 |     const chunk1 = testFileContent.subarray(start, end);
  448 | 
  449 |     const part1Res = await request.post(`${BASE_URL}/api/upload/part`, {
  450 |       multipart: {
  451 |         fileId: fileId,
  452 |         partIndex: "1",
  453 |         data: {
  454 |           name: "chunk.bin",
  455 |           mimeType: "application/octet-stream",
  456 |           buffer: chunk1,
  457 |         },
  458 |       },
  459 |     });
  460 |     expect(part1Res.status()).toBe(200);
  461 |     const part1Data = await part1Res.json();
  462 |     expect(part1Data.success).toBe(true);
  463 | 
  464 |     // Step 5: Complete upload
  465 |     const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
  466 |       data: { fileId },
  467 |     });
  468 |     expect(completeRes.status()).toBe(200);
  469 | 
  470 |     // Step 6: Download and verify full file integrity
  471 |     const completeData = await completeRes.json();
  472 |     const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
  473 |     expect(downloadRes.status()).toBe(200);
  474 | 
  475 |     const downloadedBody = await downloadRes.body();
  476 |     expect(downloadedBody.length).toBe(fileSize);
  477 |     expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  478 |   });
  479 | });
```