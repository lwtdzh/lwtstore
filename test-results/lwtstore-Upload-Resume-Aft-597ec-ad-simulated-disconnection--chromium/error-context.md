# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lwtstore.spec.js >> Upload Resume After Disconnection >> should resume upload after partial upload (simulated disconnection)
- Location: tests/lwtstore.spec.js:375:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  315 | 
  316 |       // Create a FormData-like multipart request
  317 |       const formData = new FormData();
  318 |       formData.append("fileId", fileId);
  319 |       formData.append("partIndex", i.toString());
  320 |       formData.append("data", new Blob([chunk]), "chunk.bin");
  321 | 
  322 |       const partRes = await request.post(`${BASE_URL}/api/upload/part`, {
  323 |         multipart: {
  324 |           fileId: fileId,
  325 |           partIndex: i.toString(),
  326 |           data: {
  327 |             name: "chunk.bin",
  328 |             mimeType: "application/octet-stream",
  329 |             buffer: chunk,
  330 |           },
  331 |         },
  332 |       });
  333 |       expect(partRes.status()).toBe(200);
  334 |       const partData = await partRes.json();
  335 |       expect(partData.success).toBe(true);
  336 |       expect(partData.partIndex).toBe(i);
  337 |     }
  338 | 
  339 |     // Step 3: Check upload status
  340 |     const statusRes = await request.get(`${BASE_URL}/api/upload/status?fileId=${fileId}`);
  341 |     expect(statusRes.status()).toBe(200);
  342 |     const statusData = await statusRes.json();
  343 |     expect(statusData.uploadedParts.length).toBe(totalParts);
  344 | 
  345 |     // Step 4: Complete upload
  346 |     const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
  347 |       data: { fileId },
  348 |     });
  349 |     expect(completeRes.status()).toBe(200);
  350 |     const completeData = await completeRes.json();
  351 |     expect(completeData.success).toBe(true);
  352 |     expect(completeData.downloadUrl).toContain(fileId);
  353 | 
  354 |     // Step 5: Download and verify
  355 |     const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
  356 |     expect(downloadRes.status()).toBe(200);
  357 | 
  358 |     const downloadedBody = await downloadRes.body();
  359 |     expect(downloadedBody.length).toBe(fileSize);
  360 |     expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  361 |   });
  362 | });
  363 | 
  364 | // ============================================================
  365 | // Test Suite 5: Upload Resume (Simulated Disconnection)
  366 | // ============================================================
  367 | test.describe("Upload Resume After Disconnection", () => {
  368 |   const RESUME_FILE_SIZE = 25 * 1024 * 1024; // 25MB = 2 parts (20MB + 5MB)
  369 |   let testFileContent;
  370 | 
  371 |   test.beforeAll(() => {
  372 |     testFileContent = crypto.randomBytes(RESUME_FILE_SIZE);
  373 |   });
  374 | 
  375 |   test("should resume upload after partial upload (simulated disconnection)", async ({ request }) => {
  376 |     test.setTimeout(600000); // 10 minutes
  377 | 
  378 |     const fileName = `test-resume-${Date.now()}.bin`;
  379 |     const fileSize = testFileContent.length;
  380 |     const fileHash = `${fileName}-${fileSize}-${Date.now()}`;
  381 |     const PART_SIZE = 20 * 1024 * 1024;
  382 | 
  383 |     // Step 1: Initialize upload
  384 |     const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
  385 |       data: { fileName, fileSize, fileHash },
  386 |     });
  387 |     expect(initRes.status()).toBe(200);
  388 |     const initData = await initRes.json();
  389 |     const { fileId, totalParts } = initData;
  390 |     expect(totalParts).toBe(2);
  391 | 
  392 |     // Step 2: Upload only the FIRST part (simulate disconnection after 1 part)
  393 |     const chunk0 = testFileContent.subarray(0, PART_SIZE);
  394 |     const part0Res = await request.post(`${BASE_URL}/api/upload/part`, {
  395 |       multipart: {
  396 |         fileId: fileId,
  397 |         partIndex: "0",
  398 |         data: {
  399 |           name: "chunk.bin",
  400 |           mimeType: "application/octet-stream",
  401 |           buffer: chunk0,
  402 |         },
  403 |       },
  404 |     });
  405 |     expect(part0Res.status()).toBe(200);
  406 | 
  407 |     // Step 3: "Disconnect" - now re-initialize with same fileHash to resume
  408 |     const resumeRes = await request.post(`${BASE_URL}/api/upload/init`, {
  409 |       data: { fileName, fileSize, fileHash },
  410 |     });
  411 |     expect(resumeRes.status()).toBe(200);
  412 |     const resumeData = await resumeRes.json();
  413 | 
  414 |     // Should detect the existing upload and return resume info
> 415 |     expect(resumeData.resumed).toBe(true);
      |                                ^ Error: expect(received).toBe(expected) // Object.is equality
  416 |     expect(resumeData.fileId).toBe(fileId);
  417 |     expect(resumeData.uploadedParts).toContain(0);
  418 |     expect(resumeData.uploadedParts).not.toContain(1);
  419 | 
  420 |     // Step 4: Upload remaining part (1)
  421 |     const start = PART_SIZE;
  422 |     const end = fileSize;
  423 |     const chunk1 = testFileContent.subarray(start, end);
  424 | 
  425 |     const part1Res = await request.post(`${BASE_URL}/api/upload/part`, {
  426 |       multipart: {
  427 |         fileId: fileId,
  428 |         partIndex: "1",
  429 |         data: {
  430 |           name: "chunk.bin",
  431 |           mimeType: "application/octet-stream",
  432 |           buffer: chunk1,
  433 |         },
  434 |       },
  435 |     });
  436 |     expect(part1Res.status()).toBe(200);
  437 |     const part1Data = await part1Res.json();
  438 |     expect(part1Data.success).toBe(true);
  439 | 
  440 |     // Step 5: Complete upload
  441 |     const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
  442 |       data: { fileId },
  443 |     });
  444 |     expect(completeRes.status()).toBe(200);
  445 | 
  446 |     // Step 6: Download and verify full file integrity
  447 |     const completeData = await completeRes.json();
  448 |     const downloadRes = await request.get(`${BASE_URL}${completeData.downloadUrl}`);
  449 |     expect(downloadRes.status()).toBe(200);
  450 | 
  451 |     const downloadedBody = await downloadRes.body();
  452 |     expect(downloadedBody.length).toBe(fileSize);
  453 |     expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  454 |   });
  455 | });
  456 | 
  457 | // ============================================================
  458 | // Test Suite 6: Multi-thread Download Simulation
  459 | // ============================================================
  460 | test.describe("Multi-thread Download Simulation", () => {
  461 |   test("should support concurrent Range requests (simulating IDM/aria2)", async ({ request }) => {
  462 |     test.setTimeout(120000);
  463 | 
  464 |     // Get a file from the list
  465 |     const listRes = await request.get(`${BASE_URL}/api/files`);
  466 |     const files = await listRes.json();
  467 | 
  468 |     if (files.length === 0) {
  469 |       test.skip();
  470 |       return;
  471 |     }
  472 | 
  473 |     const file = files[0];
  474 |     const totalSize = file.fileSize;
  475 |     const downloadUrl = `${BASE_URL}${file.downloadUrl}`;
  476 | 
  477 |     // Step 1: HEAD request (what download managers do first)
  478 |     const headRes = await request.head(downloadUrl);
  479 |     expect(headRes.status()).toBe(200);
  480 |     expect(headRes.headers()["accept-ranges"]).toBe("bytes");
  481 |     const reportedSize = parseInt(headRes.headers()["content-length"], 10);
  482 |     expect(reportedSize).toBe(totalSize);
  483 | 
  484 |     // Step 2: Simulate 4-thread download with concurrent Range requests
  485 |     const threadCount = 4;
  486 |     const chunkSize = Math.ceil(totalSize / threadCount);
  487 |     const ranges = [];
  488 | 
  489 |     for (let i = 0; i < threadCount; i++) {
  490 |       const start = i * chunkSize;
  491 |       const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
  492 |       ranges.push({ start, end });
  493 |     }
  494 | 
  495 |     // Fire all range requests concurrently
  496 |     const rangePromises = ranges.map(({ start, end }) =>
  497 |       request.get(downloadUrl, {
  498 |         headers: { Range: `bytes=${start}-${end}` },
  499 |       })
  500 |     );
  501 | 
  502 |     const rangeResponses = await Promise.all(rangePromises);
  503 | 
  504 |     // Verify all responses
  505 |     const chunks = [];
  506 |     for (let i = 0; i < rangeResponses.length; i++) {
  507 |       const res = rangeResponses[i];
  508 |       expect(res.status()).toBe(206);
  509 | 
  510 |       const contentRange = res.headers()["content-range"];
  511 |       expect(contentRange).toContain(`/${totalSize}`);
  512 | 
  513 |       const body = await res.body();
  514 |       const expectedSize = ranges[i].end - ranges[i].start + 1;
  515 |       expect(body.length).toBe(expectedSize);
```