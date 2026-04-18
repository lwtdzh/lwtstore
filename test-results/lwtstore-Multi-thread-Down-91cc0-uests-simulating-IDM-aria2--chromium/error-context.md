# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lwtstore.spec.js >> Multi-thread Download Simulation >> should support concurrent Range requests (simulating IDM/aria2)
- Location: tests/lwtstore.spec.js:485:3

# Error details

```
TimeoutError: apiRequestContext.get: Timeout 30000ms exceeded.
Call log:
  - → GET https://lwtstore.pages.dev/api/download/mo3s8yod-7hu68dsi
    - user-agent: Playwright/1.59.1 (arm64; macOS 26.3) node/25.8
    - accept: */*
    - accept-encoding: gzip,deflate,br
  - ← 200 OK
    - date: Sat, 18 Apr 2026 03:35:09 GMT
    - content-type: application/octet-stream
    - transfer-encoding: chunked
    - connection: keep-alive
    - accept-ranges: bytes
    - access-control-allow-origin: *
    - cache-control: public, max-age=31536000, immutable
    - content-disposition: attachment; filename="test-multipart.bin"; filename*=UTF-8''test-multipart.bin
    - etag: "mo3s8yod-7hu68dsi"
    - access-control-expose-headers: Content-Length, Content-Range, Accept-Ranges, Content-Disposition
    - report-to: {"group":"cf-nel","max_age":604800,"endpoints":[{"url":"https://a.nel.cloudflare.com/report/v4?s=AGgZkvsOXI12dJzDbAJju%2BDLkaS5r%2B3iE00RnoOd9VrSfdjaGi2uWMtNNtTzStpxmgmOxIcBgqT6AbaZGjO%2BXKYZKXxfnBwgOv31PfksmwCw%2FhATYojqQ5%2BqTRy1BSVVdV%2FEMGY%3D"}]}
    - nel: {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
    - server: cloudflare
    - cf-ray: 9ee09e2c5e79a49b-SEA
    - alt-svc: h3=":443"; ma=86400

```

# Test source

```ts
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
  480 | 
  481 | // ============================================================
  482 | // Test Suite 6: Multi-thread Download Simulation
  483 | // ============================================================
  484 | test.describe("Multi-thread Download Simulation", () => {
  485 |   test("should support concurrent Range requests (simulating IDM/aria2)", async ({ request }) => {
  486 |     test.setTimeout(120000);
  487 | 
  488 |     // Get a file from the list
  489 |     const listRes = await request.get(`${BASE_URL}/api/files`);
  490 |     const listData = await listRes.json();
  491 |     const files = listData.files || [];
  492 | 
  493 |     if (files.length === 0) {
  494 |       test.skip();
  495 |       return;
  496 |     }
  497 | 
  498 |     const file = files[0];
  499 |     const totalSize = file.fileSize;
  500 |     const downloadUrl = `${BASE_URL}${file.downloadUrl}`;
  501 | 
  502 |     // Step 1: HEAD request (what download managers do first)
  503 |     const headRes = await request.head(downloadUrl);
  504 |     expect(headRes.status()).toBe(200);
  505 |     expect(headRes.headers()["accept-ranges"]).toBe("bytes");
  506 |     const reportedSize = parseInt(headRes.headers()["content-length"], 10);
  507 |     expect(reportedSize).toBe(totalSize);
  508 | 
  509 |     // Step 2: Simulate 4-thread download with concurrent Range requests
  510 |     const threadCount = 4;
  511 |     const chunkSize = Math.ceil(totalSize / threadCount);
  512 |     const ranges = [];
  513 | 
  514 |     for (let i = 0; i < threadCount; i++) {
  515 |       const start = i * chunkSize;
  516 |       const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
  517 |       ranges.push({ start, end });
  518 |     }
  519 | 
  520 |     // Fire all range requests concurrently
  521 |     const rangePromises = ranges.map(({ start, end }) =>
  522 |       request.get(downloadUrl, {
  523 |         headers: { Range: `bytes=${start}-${end}` },
  524 |       })
  525 |     );
  526 | 
  527 |     const rangeResponses = await Promise.all(rangePromises);
  528 | 
  529 |     // Verify all responses
  530 |     const chunks = [];
  531 |     for (let i = 0; i < rangeResponses.length; i++) {
  532 |       const res = rangeResponses[i];
  533 |       expect(res.status()).toBe(206);
  534 | 
  535 |       const contentRange = res.headers()["content-range"];
  536 |       expect(contentRange).toContain(`/${totalSize}`);
  537 | 
  538 |       const body = await res.body();
  539 |       const expectedSize = ranges[i].end - ranges[i].start + 1;
  540 |       expect(body.length).toBe(expectedSize);
  541 | 
  542 |       chunks.push(body);
  543 |     }
  544 | 
  545 |     // Reassemble and verify against full download
  546 |     const reassembled = Buffer.concat(chunks);
  547 |     expect(reassembled.length).toBe(totalSize);
  548 | 
  549 |     // Download full file for comparison
> 550 |     const fullRes = await request.get(downloadUrl);
      |                                   ^ TimeoutError: apiRequestContext.get: Timeout 30000ms exceeded.
  551 |     const fullBody = await fullRes.body();
  552 |     expect(Buffer.compare(reassembled, fullBody)).toBe(0);
  553 |   });
  554 | });
  555 | 
  556 | // ============================================================
  557 | // Test Suite 7: Page Refresh & File List Persistence
  558 | // ============================================================
  559 | test.describe("Page Refresh & Persistence", () => {
  560 |   test("should persist file list after page refresh", async ({ page }) => {
  561 |     test.setTimeout(30000);
  562 | 
  563 |     await page.goto(BASE_URL);
  564 |     await page.waitForLoadState("networkidle");
  565 | 
  566 |     // Wait for file list to load
  567 |     await page.waitForFunction(() => {
  568 |       const loading = document.getElementById("fileListLoading");
  569 |       return loading && loading.style.display === "none";
  570 |     }, { timeout: 15000 });
  571 | 
  572 |     // Check if there are files
  573 |     const fileTable = page.locator("#fileTable");
  574 |     const isTableVisible = await fileTable.isVisible();
  575 | 
  576 |     if (!isTableVisible) {
  577 |       // No files uploaded yet, skip this test
  578 |       test.skip();
  579 |       return;
  580 |     }
  581 | 
  582 |     // Count files before refresh
  583 |     const rowsBefore = await page.locator("#fileTableBody tr").count();
  584 |     expect(rowsBefore).toBeGreaterThan(0);
  585 | 
  586 |     // Refresh the page
  587 |     await page.reload();
  588 |     await page.waitForLoadState("networkidle");
  589 | 
  590 |     // Wait for file list to reload
  591 |     await page.waitForFunction(() => {
  592 |       const loading = document.getElementById("fileListLoading");
  593 |       return loading && loading.style.display === "none";
  594 |     }, { timeout: 15000 });
  595 | 
  596 |     // Count files after refresh
  597 |     const rowsAfter = await page.locator("#fileTableBody tr").count();
  598 |     expect(rowsAfter).toBe(rowsBefore);
  599 |   });
  600 | 
  601 |   test("should show download buttons for each file", async ({ page }) => {
  602 |     await page.goto(BASE_URL);
  603 |     await page.waitForLoadState("networkidle");
  604 | 
  605 |     await page.waitForFunction(() => {
  606 |       const loading = document.getElementById("fileListLoading");
  607 |       return loading && loading.style.display === "none";
  608 |     }, { timeout: 15000 });
  609 | 
  610 |     const fileTable = page.locator("#fileTable");
  611 |     if (!(await fileTable.isVisible())) {
  612 |       test.skip();
  613 |       return;
  614 |     }
  615 | 
  616 |     // Each row should have a download button and copy link button
  617 |     const rows = page.locator("#fileTableBody tr");
  618 |     const count = await rows.count();
  619 | 
  620 |     for (let i = 0; i < count; i++) {
  621 |       const row = rows.nth(i);
  622 |       const downloadBtn = row.locator(".btn-download");
  623 |       await expect(downloadBtn).toBeVisible();
  624 | 
  625 |       const copyBtn = row.locator(".btn-copy-small");
  626 |       await expect(copyBtn).toBeVisible();
  627 | 
  628 |       // Download link should point to /api/download/
  629 |       const href = await downloadBtn.getAttribute("href");
  630 |       expect(href).toContain("/api/download/");
  631 |     }
  632 |   });
  633 | });
  634 | 
  635 | // ============================================================
  636 | // Test Suite 8: Upload via UI with Page Refresh Resume
  637 | // ============================================================
  638 | test.describe("UI Upload with Refresh Resume Detection", () => {
  639 |   const tmpDir = path.join(__dirname, "tmp");
  640 |   let testFilePath;
  641 | 
  642 |   test.beforeAll(() => {
  643 |     if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  644 |     createTestFile(tmpDir, "test-ui-resume.bin", 256 * 1024); // 256KB
  645 |     testFilePath = path.join(tmpDir, "test-ui-resume.bin");
  646 |   });
  647 | 
  648 |   test.afterAll(() => {
  649 |     cleanupFile(testFilePath);
  650 |     try {
```