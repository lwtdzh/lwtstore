# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lwtstore.spec.js >> Small File Upload Flow >> should show uploaded file in file list via UI
- Location: tests/lwtstore.spec.js:169:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.file-name-cell').filter({ hasText: 'test-small-1776425855950.bin' })
Expected: visible
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for locator('.file-name-cell').filter({ hasText: 'test-small-1776425855950.bin' })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - banner [ref=e3]:
    - heading "Lwt's Store" [level=1] [ref=e4]
    - paragraph [ref=e5]: 自由上传您的文件并自由下载！
  - generic [ref=e7] [cursor=pointer]:
    - generic [ref=e8]: 📁
    - paragraph [ref=e9]: 拖拽文件到此处，或点击选择文件
    - paragraph [ref=e10]: 支持最大 5GB 的文件，支持断点续传
  - generic [ref=e11]:
    - heading "已上传的文件" [level=2] [ref=e12]
    - table [ref=e14]:
      - rowgroup [ref=e15]:
        - row "文件名 大小 上传时间 操作" [ref=e16]:
          - columnheader "文件名" [ref=e17]
          - columnheader "大小" [ref=e18]
          - columnheader "上传时间" [ref=e19]
          - columnheader "操作" [ref=e20]
      - rowgroup [ref=e21]:
        - row "test-multipart.bin 25 MB 2026-04-17 19:29 下载 复制链接" [ref=e22]:
          - cell "test-multipart.bin" [ref=e23]
          - cell "25 MB" [ref=e24]
          - cell "2026-04-17 19:29" [ref=e25]
          - cell "下载 复制链接" [ref=e26]:
            - generic [ref=e27]:
              - link "下载" [ref=e28] [cursor=pointer]:
                - /url: /api/download/mo2tsiee-d1yrpimb
              - button "复制链接" [ref=e29] [cursor=pointer]
        - row "test-small.bin 512 KB 2026-04-17 19:29 下载 复制链接" [ref=e30]:
          - cell "test-small.bin" [ref=e31]
          - cell "512 KB" [ref=e32]
          - cell "2026-04-17 19:29" [ref=e33]
          - cell "下载 复制链接" [ref=e34]:
            - generic [ref=e35]:
              - link "下载" [ref=e36] [cursor=pointer]:
                - /url: /api/download/mo2ts99o-900sadki
              - button "复制链接" [ref=e37] [cursor=pointer]
        - row "test-idempotent.bin 512 KB 2026-04-17 19:25 下载 复制链接" [ref=e38]:
          - cell "test-idempotent.bin" [ref=e39]
          - cell "512 KB" [ref=e40]
          - cell "2026-04-17 19:25" [ref=e41]
          - cell "下载 复制链接" [ref=e42]:
            - generic [ref=e43]:
              - link "下载" [ref=e44] [cursor=pointer]:
                - /url: /api/download/mo2to3gb-hbg35zia
              - button "复制链接" [ref=e45] [cursor=pointer]
        - row "test-multipart.bin 25 MB 2026-04-17 19:24 下载 复制链接" [ref=e46]:
          - cell "test-multipart.bin" [ref=e47]
          - cell "25 MB" [ref=e48]
          - cell "2026-04-17 19:24" [ref=e49]
          - cell "下载 复制链接" [ref=e50]:
            - generic [ref=e51]:
              - link "下载" [ref=e52] [cursor=pointer]:
                - /url: /api/download/mo2tmegz-ahgecod1
              - button "复制链接" [ref=e53] [cursor=pointer]
        - row "test-small.bin 512 KB 2026-04-17 19:24 下载 复制链接" [ref=e54]:
          - cell "test-small.bin" [ref=e55]
          - cell "512 KB" [ref=e56]
          - cell "2026-04-17 19:24" [ref=e57]
          - cell "下载 复制链接" [ref=e58]:
            - generic [ref=e59]:
              - link "下载" [ref=e60] [cursor=pointer]:
                - /url: /api/download/mo2tltet-bns3k56r
              - button "复制链接" [ref=e61] [cursor=pointer]
  - contentinfo [ref=e62]:
    - paragraph [ref=e63]: Powered by Cloudflare Pages & GitHub
```

# Test source

```ts
  86  |     const body = await res.json();
  87  |     expect(Array.isArray(body)).toBe(true);
  88  |   });
  89  | 
  90  |   test("GET /api/upload/status with invalid fileId should return 404", async ({ request }) => {
  91  |     const res = await request.get(`${BASE_URL}/api/upload/status?fileId=nonexistent_abc123`);
  92  |     expect(res.status()).toBe(404);
  93  |     const body = await res.json();
  94  |     expect(body.error).toBeTruthy();
  95  |   });
  96  | 
  97  |   test("GET /api/download/nonexistent should return 404", async ({ request }) => {
  98  |     const res = await request.get(`${BASE_URL}/api/download/nonexistent_abc123`);
  99  |     expect(res.status()).toBe(404);
  100 |   });
  101 | 
  102 |   test("HEAD /api/download/nonexistent should return 404", async ({ request }) => {
  103 |     const res = await request.head(`${BASE_URL}/api/download/nonexistent_abc123`);
  104 |     expect(res.status()).toBe(404);
  105 |   });
  106 | 
  107 |   test("POST /api/upload/init with missing fields should return 400", async ({ request }) => {
  108 |     const res = await request.post(`${BASE_URL}/api/upload/init`, {
  109 |       data: { fileName: "test.txt" }, // missing fileSize and fileHash
  110 |     });
  111 |     expect(res.status()).toBe(400);
  112 |     const body = await res.json();
  113 |     expect(body.error).toContain("Missing required fields");
  114 |   });
  115 | 
  116 |   test("POST /api/upload/complete with missing fileId should return 400", async ({ request }) => {
  117 |     const res = await request.post(`${BASE_URL}/api/upload/complete`, {
  118 |       data: {},
  119 |     });
  120 |     expect(res.status()).toBe(400);
  121 |     const body = await res.json();
  122 |     expect(body.error).toContain("Missing required field");
  123 |   });
  124 | });
  125 | 
  126 | // ============================================================
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
> 186 |     await expect(fileNameCell).toBeVisible();
      |                                ^ Error: expect(locator).toBeVisible() failed
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
  227 |     expect(headers["content-length"]).toBe("1000");
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
```