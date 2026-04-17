# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lwtstore.spec.js >> Small File Upload Flow >> should support Range request (partial download)
- Location: tests/lwtstore.spec.js:218:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "1000"
Received: undefined
```

# Test source

```ts
  127 | // Test Suite 3: Small File Upload via API + Download & Range Tests
  128 | // ============================================================
  129 | test.describe("Small File Upload Flow", () => {
  130 |   const FILE_SIZE = 512 * 1024; // 512KB
  131 |   const FILE_NAME = `test-small-${Date.now()}.bin`;
  132 |   let testFileContent;
  133 |   let uploadedFileId;
  134 |   let downloadPath;
  135 | 
  136 |   test.beforeAll(async ({ request }) => {
  137 |     // Create test content in memory
  138 |     testFileContent = crypto.randomBytes(FILE_SIZE);
  139 |     const fileHash = `${FILE_NAME}-${FILE_SIZE}-${Date.now()}`;
  140 | 
  141 |     // Upload via API to ensure reliability (not dependent on UI)
  142 |     const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
  143 |       data: { fileName: FILE_NAME, fileSize: FILE_SIZE, fileHash },
  144 |     });
  145 |     const initData = await initRes.json();
  146 |     uploadedFileId = initData.fileId;
  147 | 
  148 |     // Upload single part
  149 |     await request.post(`${BASE_URL}/api/upload/part`, {
  150 |       multipart: {
  151 |         fileId: uploadedFileId,
  152 |         partIndex: "0",
  153 |         data: {
  154 |           name: "chunk.bin",
  155 |           mimeType: "application/octet-stream",
  156 |           buffer: testFileContent,
  157 |         },
  158 |       },
  159 |     });
  160 | 
  161 |     // Complete upload
  162 |     const completeRes = await request.post(`${BASE_URL}/api/upload/complete`, {
  163 |       data: { fileId: uploadedFileId },
  164 |     });
  165 |     const completeData = await completeRes.json();
  166 |     downloadPath = completeData.downloadUrl;
  167 |   });
  168 | 
  169 |   test("should show uploaded file in file list via UI", async ({ page }) => {
  170 |     test.setTimeout(30000);
  171 | 
  172 |     await page.goto(BASE_URL);
  173 |     await page.waitForLoadState("networkidle");
  174 | 
  175 |     // Wait for file list to load
  176 |     await page.waitForFunction(() => {
  177 |       const loading = document.getElementById("fileListLoading");
  178 |       return loading && loading.style.display === "none";
  179 |     }, { timeout: 15000 });
  180 | 
  181 |     // Check file table is visible and contains our file
  182 |     const fileTable = page.locator("#fileTable");
  183 |     await expect(fileTable).toBeVisible({ timeout: 10000 });
  184 | 
  185 |     const fileNameCell = page.locator(".file-name-cell", { hasText: FILE_NAME });
  186 |     await expect(fileNameCell).toBeVisible();
  187 |   });
  188 | 
  189 |   test("should download the uploaded file and verify content matches", async ({ request }) => {
  190 |     test.setTimeout(60000);
  191 | 
  192 |     // Download the file
  193 |     const downloadRes = await request.get(`${BASE_URL}${downloadPath}`);
  194 |     expect(downloadRes.status()).toBe(200);
  195 | 
  196 |     // Verify headers
  197 |     const headers = downloadRes.headers();
  198 |     expect(headers["content-type"]).toBe("application/octet-stream");
  199 |     expect(headers["accept-ranges"]).toBe("bytes");
  200 |     expect(headers["content-disposition"]).toContain(FILE_NAME);
  201 | 
  202 |     // Verify content matches
  203 |     const downloadedBody = await downloadRes.body();
  204 |     expect(downloadedBody.length).toBe(testFileContent.length);
  205 |     expect(Buffer.compare(downloadedBody, testFileContent)).toBe(0);
  206 |   });
  207 | 
  208 |   test("should support HEAD request for download (multi-thread download pre-check)", async ({ request }) => {
  209 |     const headRes = await request.head(`${BASE_URL}${downloadPath}`);
  210 |     expect(headRes.status()).toBe(200);
  211 | 
  212 |     const headers = headRes.headers();
  213 |     expect(headers["accept-ranges"]).toBe("bytes");
  214 |     expect(headers["content-length"]).toBe(String(FILE_SIZE));
  215 |     expect(headers["content-disposition"]).toContain(FILE_NAME);
  216 |   });
  217 | 
  218 |   test("should support Range request (partial download)", async ({ request }) => {
  219 |     // Request first 1000 bytes
  220 |     const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
  221 |       headers: { Range: "bytes=0-999" },
  222 |     });
  223 |     expect(rangeRes.status()).toBe(206);
  224 | 
  225 |     const headers = rangeRes.headers();
  226 |     expect(headers["content-range"]).toBe(`bytes 0-999/${FILE_SIZE}`);
> 227 |     expect(headers["content-length"]).toBe("1000");
      |                                       ^ Error: expect(received).toBe(expected) // Object.is equality
  228 | 
  229 |     const body = await rangeRes.body();
  230 |     expect(body.length).toBe(1000);
  231 |     expect(Buffer.compare(body, testFileContent.subarray(0, 1000))).toBe(0);
  232 |   });
  233 | 
  234 |   test("should support Range request for middle section", async ({ request }) => {
  235 |     // Request bytes 10000-19999 (10KB from middle)
  236 |     const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
  237 |       headers: { Range: "bytes=10000-19999" },
  238 |     });
  239 |     expect(rangeRes.status()).toBe(206);
  240 | 
  241 |     const body = await rangeRes.body();
  242 |     expect(body.length).toBe(10000);
  243 |     expect(Buffer.compare(body, testFileContent.subarray(10000, 20000))).toBe(0);
  244 |   });
  245 | 
  246 |   test("should support Range request for last N bytes", async ({ request }) => {
  247 |     // Request last 500 bytes
  248 |     const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
  249 |       headers: { Range: `bytes=${FILE_SIZE - 500}-${FILE_SIZE - 1}` },
  250 |     });
  251 |     expect(rangeRes.status()).toBe(206);
  252 | 
  253 |     const body = await rangeRes.body();
  254 |     expect(body.length).toBe(500);
  255 |     expect(Buffer.compare(body, testFileContent.subarray(FILE_SIZE - 500))).toBe(0);
  256 |   });
  257 | 
  258 |   test("should return 416 for invalid Range", async ({ request }) => {
  259 |     // Request beyond file size
  260 |     const rangeRes = await request.get(`${BASE_URL}${downloadPath}`, {
  261 |       headers: { Range: `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}` },
  262 |     });
  263 |     expect(rangeRes.status()).toBe(416);
  264 |   });
  265 | });
  266 | 
  267 | // ============================================================
  268 | // Test Suite 4: Multi-part File Upload (> 20MB)
  269 | // ============================================================
  270 | test.describe("Multi-part File Upload", () => {
  271 |   const tmpDir = path.join(__dirname, "tmp");
  272 |   let testFilePath;
  273 |   let testFileContent;
  274 | 
  275 |   test.beforeAll(() => {
  276 |     if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  277 |     // Create a 25MB test file (will be split into 2 parts: 20MB + 5MB)
  278 |     const result = createTestFile(tmpDir, "test-multipart.bin", 25 * 1024 * 1024);
  279 |     testFilePath = result.filePath;
  280 |     testFileContent = result.buf;
  281 |   });
  282 | 
  283 |   test.afterAll(() => {
  284 |     cleanupFile(testFilePath);
  285 |     try {
  286 |       fs.rmdirSync(tmpDir, { recursive: true });
  287 |     } catch (e) { /* ignore */ }
  288 |   });
  289 | 
  290 |   test("should upload a multi-part file via API and download correctly", async ({ request }) => {
  291 |     test.setTimeout(300000); // 5 minutes
  292 | 
  293 |     const fileName = "test-multipart.bin";
  294 |     const fileSize = testFileContent.length;
  295 |     const fileHash = `${fileName}-${fileSize}-${Date.now()}`;
  296 | 
  297 |     // Step 1: Initialize upload
  298 |     const initRes = await request.post(`${BASE_URL}/api/upload/init`, {
  299 |       data: { fileName, fileSize, fileHash },
  300 |     });
  301 |     expect(initRes.status()).toBe(200);
  302 |     const initData = await initRes.json();
  303 |     expect(initData.fileId).toBeTruthy();
  304 |     expect(initData.totalParts).toBe(2); // 25MB / 20MB = 2 parts
  305 |     expect(initData.uploadedParts).toEqual([]);
  306 | 
  307 |     const { fileId, totalParts } = initData;
  308 | 
  309 |     // Step 2: Upload parts
  310 |     const PART_SIZE = 20 * 1024 * 1024;
  311 |     for (let i = 0; i < totalParts; i++) {
  312 |       const start = i * PART_SIZE;
  313 |       const end = Math.min(start + PART_SIZE, fileSize);
  314 |       const chunk = testFileContent.subarray(start, end);
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
```