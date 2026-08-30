'use strict';

const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// ============================================================
// PDF MERGER SERVER v4
// Optimized for Railway
// ============================================================

// =========================
// إعدادات التطبيق
// =========================

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// الحد الأقصى للملف الواحد
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 200;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

// الحد الأقصى لعدد الملفات
const MAX_FILES = Number(process.env.MAX_FILES) || 5;

// الحد الأقصى للحجم الإجمالي
// 1000 MB يحافظ على السلوك السابق:
// 5 × 200 MB
const MAX_TOTAL_SIZE_MB =
  Number(process.env.MAX_TOTAL_SIZE_MB) || 1000;

const MAX_TOTAL_SIZE = MAX_TOTAL_SIZE_MB * 1024 * 1024;

// حد الصفحات
const MAX_PAGES = Number(process.env.MAX_PAGES) || 2000;

// مجلد الملفات المؤقتة
const TEMP_ROOT = path.join(os.tmpdir(), 'pdf-merger-v4');

// حجم الـ chunks أثناء الكتابة/القراءة
const STREAM_HIGH_WATER_MARK = 1024 * 1024;

// =========================
// معلومات التشغيل
// =========================

console.log('');
console.log('==============================================');
console.log(' PDF MERGER SERVER v4');
console.log(' Railway Optimized');
console.log('==============================================');
console.log(`📦 Max file size : ${MAX_FILE_SIZE_MB} MB`);
console.log(`📦 Max files     : ${MAX_FILES}`);
console.log(`📦 Max total     : ${MAX_TOTAL_SIZE_MB} MB`);
console.log(`📄 Max pages     : ${MAX_PAGES}`);
console.log(`💻 Node.js       : ${process.version}`);
console.log(`🖥️ Platform      : ${process.platform}`);
console.log(`🧠 CPU cores     : ${require('os').cpus().length}`);
console.log('==============================================');
console.log('');

// =========================
// إنشاء مجلد الملفات المؤقتة
// =========================

async function ensureTempRoot() {
  await fsp.mkdir(TEMP_ROOT, {
    recursive: true
  });
}

// =========================
// إعدادات Express
// =========================

app.set('trust proxy', 1);

// =========================
// Helmet
// =========================

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

// =========================
// CORS
// =========================

const allowedOrigin = process.env.FRONTEND_URL;

if (allowedOrigin) {
  app.use(
    cors({
      origin: allowedOrigin,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );
} else {
  // إذا لم يتم تحديد FRONTEND_URL
  // نسمح بالـ CORS بشكل عام.
  // يفضل تحديد FRONTEND_URL في الإنتاج.
  app.use(cors());
}

// =========================
// Compression
// =========================

// لا نضغط PDF الناتج.
// PDF مضغوط أصلًا غالبًا، والضغط الإضافي يستهلك CPU.
app.use(
  compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.path === '/merge') {
        return false;
      }

      return compression.filter(req, res);
    }
  })
);

// =========================
// Body limits
// =========================

// لا نحتاج body كبير لأن الملفات تأتي عبر multipart.
// هذه الحدود تحمي JSON / body العادي.
app.use(
  express.json({
    limit: '1mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '1mb'
  })
);

// =========================
// Rate Limit
// =========================

const mergeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  // 20 عملية دمج / 15 دقيقة لكل IP
  max: 20,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    error: 'تجاوزت عدد الطلبات المسموح بها، حاول لاحقاً'
  },

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'تجاوزت عدد الطلبات المسموح بها، حاول لاحقاً'
    });
  }
});

app.use('/merge', mergeLimiter);

// =========================
// Static files
// =========================

app.use(express.static(path.join(process.cwd(), 'public')));

// ============================================================
// وظائف مساعدة
// ============================================================

// ------------------------------------------------------------
// إنشاء مجلد مؤقت خاص بكل طلب
// ------------------------------------------------------------

async function createRequestTempDir() {
  await ensureTempRoot();

  const requestId = crypto.randomUUID();

  const requestDir = path.join(
    TEMP_ROOT,
    requestId
  );

  await fsp.mkdir(requestDir, {
    recursive: true
  });

  return {
    requestId,
    requestDir
  };
}

// ------------------------------------------------------------
// حذف مجلد بشكل آمن
// ------------------------------------------------------------

async function removeDirectorySafe(dir) {
  if (!dir) return;

  try {
    await fsp.rm(dir, {
      recursive: true,
      force: true
    });
  } catch (error) {
    console.error(
      '⚠️ فشل تنظيف المجلد المؤقت:',
      error.message
    );
  }
}

// ------------------------------------------------------------
// الحصول على حجم ملف
// ------------------------------------------------------------

async function getFileSize(filePath) {
  const stat = await fsp.stat(filePath);
  return stat.size;
}

// ------------------------------------------------------------
// التحقق من PDF Signature
//
// PDF الحقيقي يبدأ عادةً بـ:
// %PDF-
// ------------------------------------------------------------

async function isValidPdfSignature(filePath) {
  const handle = await fsp.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(5);

    const { bytesRead } = await handle.read(
      buffer,
      0,
      5,
      0
    );

    if (bytesRead < 5) {
      return false;
    }

    return buffer.toString('ascii') === '%PDF-';
  } finally {
    await handle.close();
  }
}

// ------------------------------------------------------------
// تنظيف اسم الملف
// ------------------------------------------------------------

function sanitizeFilename(filename) {
  return String(filename || 'file.pdf')
    .replace(/[^\w.\-() ]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

// ------------------------------------------------------------
// حساب الذاكرة
// ------------------------------------------------------------

function getMemoryInfo() {
  const mem = process.memoryUsage();

  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
    arrayBuffers: Math.round(mem.arrayBuffers / 1024 / 1024)
  };
}

// ------------------------------------------------------------
// هل الطلب تم إلغاؤه؟
// ------------------------------------------------------------

function isRequestAborted(req) {
  return (
    req.aborted === true ||
    req.destroyed === true ||
    req.complete === false && req.destroyed === true
  );
}

// ============================================================
// Multer
// ============================================================

// استخدام diskStorage بدل memoryStorage.
//
// النتيجة:
// الملفات لا تبقى كلها في RAM.
// يتم تخزينها مؤقتًا على /tmp.
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!req._pdfTempDir) {
        const temp = await createRequestTempDir();

        req._pdfTempDir = temp.requestDir;
        req._pdfRequestId = temp.requestId;
      }

      cb(null, req._pdfTempDir);
    } catch (error) {
      cb(error);
    }
  },

  filename: (req, file, cb) => {
    const safeName = sanitizeFilename(
      file.originalname
    );

    const uniqueName =
      `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${safeName}`;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  },

  fileFilter: (req, file, cb) => {
    const originalName =
      String(file.originalname || '').toLowerCase();

    const mimetype =
      String(file.mimetype || '').toLowerCase();

    const looksLikePdf =
      mimetype === 'application/pdf' ||
      mimetype === 'application/x-pdf' ||
      originalName.endsWith('.pdf');

    if (!looksLikePdf) {
      return cb(
        new Error('فقط ملفات PDF مسموح بها')
      );
    }

    cb(null, true);
  }
});

// ============================================================
// MERGE API
// ============================================================

app.post(
  '/merge',
  upload.array('pdfs', MAX_FILES),

  async (req, res) => {
    const startTime = Date.now();

    const requestId =
      req._pdfRequestId ||
      crypto.randomUUID();

    let tempDir = req._pdfTempDir || null;

    let outputPath = null;
    let responseStarted = false;

    console.log('');
    console.log('----------------------------------------------');
    console.log(`📥 طلب جديد: ${requestId}`);
    console.log(`🌐 IP: ${req.ip}`);

    try {
      // ------------------------------------------------------
      // التحقق من الملفات
      // ------------------------------------------------------

      if (
        !req.files ||
        !Array.isArray(req.files) ||
        req.files.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: 'الرجاء رفع ملفات PDF للدمج'
        });
      }

      if (req.files.length > MAX_FILES) {
        return res.status(413).json({
          success: false,
          error:
            `الحد الأقصى هو ${MAX_FILES} ملفات`
        });
      }

      // ------------------------------------------------------
      // حساب الحجم الإجمالي
      // ------------------------------------------------------

      let totalSize = 0;

      for (const file of req.files) {
        totalSize += Number(file.size || 0);
      }

      console.log(
        `📦 الملفات: ${req.files.length}`
      );

      console.log(
        `📦 الحجم الإجمالي: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
      );

      if (totalSize > MAX_TOTAL_SIZE) {
        return res.status(413).json({
          success: false,
          error:
            `الحجم الإجمالي يتجاوز الحد المسموح (${MAX_TOTAL_SIZE_MB} MB)`
        });
      }

      // ------------------------------------------------------
      // التأكد من وجود مجلد مؤقت
      // ------------------------------------------------------

      tempDir =
        req._pdfTempDir ||
        tempDir ||
        path.dirname(req.files[0].path);

      // ------------------------------------------------------
      // إنشاء PDF الناتج
      // ------------------------------------------------------

      const mergedPdf =
        await PDFDocument.create();

      let pageCount = 0;

      // ------------------------------------------------------
      // معالجة الملفات واحدًا تلو الآخر
      // ------------------------------------------------------

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        // التحقق من إلغاء الطلب
        if (isRequestAborted(req)) {
          throw new Error(
            'تم إلغاء الطلب من قبل العميل'
          );
        }

        const fileSizeMB =
          Number(file.size || 0) /
          1024 /
          1024;

        console.log(
          `📄 [${i + 1}/${req.files.length}] ${file.originalname} (${fileSizeMB.toFixed(2)} MB)`
        );

        // ----------------------------------------------------
        // فحص Signature
        // ----------------------------------------------------

        const validSignature =
          await isValidPdfSignature(file.path);

        if (!validSignature) {
          throw new Error(
            `الملف ليس PDF صالحًا: ${file.originalname}`
          );
        }

        // ----------------------------------------------------
        // قراءة ملف واحد فقط إلى الذاكرة
        // ----------------------------------------------------

        const pdfBytes =
          await fsp.readFile(file.path);

        console.log(
          `   💾 تمت قراءة الملف - الذاكرة: ${getMemoryInfo().rss} MB RSS`
        );

        // ----------------------------------------------------
        // تحميل PDF
        // ----------------------------------------------------

        let pdf;

        try {
          pdf = await PDFDocument.load(
            pdfBytes,
            {
              ignoreEncryption: false,
              updateMetadata: false,
              parseSpeed: 1
            }
          );
        } catch (error) {
          throw new Error(
            `تعذر قراءة PDF "${file.originalname}": ${error.message}`
          );
        }

        // ----------------------------------------------------
        // حساب الصفحات
        // ----------------------------------------------------

        const pageIndices =
          pdf.getPageIndices();

        const filePageCount =
          pageIndices.length;

        console.log(
          `   📑 الصفحات: ${filePageCount}`
        );

        if (
          pageCount + filePageCount >
          MAX_PAGES
        ) {
          throw new Error(
            `عدد الصفحات يتجاوز الحد المسموح (${MAX_PAGES} صفحة)`
          );
        }

        // ----------------------------------------------------
        // نسخ الصفحات
        // ----------------------------------------------------

        const copiedPages =
          await mergedPdf.copyPages(
            pdf,
            pageIndices
          );

        for (const page of copiedPages) {
          mergedPdf.addPage(page);
        }

        pageCount += filePageCount;

        // ----------------------------------------------------
        // تحرير مرجع PDF الحالي
        // ----------------------------------------------------

        pdf = null;

        // حذف الملف المؤقت فور الانتهاء منه.
        //
        // هذا مهم جدًا:
        // لا نريد الاحتفاظ بكل الملفات على /tmp
        // طوال فترة الطلب.
        try {
          await fsp.unlink(file.path);
        } catch (error) {
          console.warn(
            `⚠️ تعذر حذف الملف المؤقت: ${error.message}`
          );
        }

        // تحرير المرجع إلى Buffer.
        // لا نستخدم pdfBytes.length = 0.
        //
        // JavaScript GC سيتولى الذاكرة عندما يحتاجها.
        //
        // eslint-disable-next-line no-unused-vars
        // pdfBytes يخرج من scope بعد انتهاء الدورة.

        console.log(
          `   ✅ اكتمل الملف - الذاكرة: ${getMemoryInfo().rss} MB RSS`
        );
      }

      // ------------------------------------------------------
      // التحقق من عدد الصفحات
      // ------------------------------------------------------

      if (pageCount === 0) {
        throw new Error(
          'لم يتم العثور على صفحات في الملفات'
        );
      }

      console.log(
        `📄 إجمالي الصفحات: ${pageCount}`
      );

      // ------------------------------------------------------
      // حفظ PDF الناتج
      // ------------------------------------------------------

      console.log(
        '💾 إنشاء الملف النهائي...'
      );

      const mergedBytes =
        await mergedPdf.save({
          useObjectStreams: false,
          addDefaultPage: false,
          objectsPerTick: 30,
          updateFieldAppearances: false
        });

      console.log(
        `📦 حجم الناتج: ${(mergedBytes.length / 1024 / 1024).toFixed(2)} MB`
      );

      // ------------------------------------------------------
      // كتابة الناتج إلى /tmp
      // ------------------------------------------------------

      outputPath = path.join(
        tempDir,
        `merged_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.pdf`
      );

      await fsp.writeFile(
        outputPath,
        mergedBytes
      );

      // بعد الكتابة، لا نحتاج mergedBytes.
      //
      // لا نستخدم:
      // mergedBytes.length = 0
      //
      // لأن Buffer ليس بهذه الطريقة يتم تحريره.

      console.log(
        `💾 الملف النهائي محفوظ مؤقتًا`
      );

      // ------------------------------------------------------
      // معلومات قبل الإرسال
      // ------------------------------------------------------

      const processingTime =
        (Date.now() - startTime) / 1000;

      const outputStat =
        await fsp.stat(outputPath);

      const outputSize =
        outputStat.size;

      // ------------------------------------------------------
      // Headers
      // ------------------------------------------------------

      res.statusCode = 200;

      res.setHeader(
        'Content-Type',
        'application/pdf'
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="merged_${Date.now()}.pdf"`
      );

      res.setHeader(
        'Content-Length',
        outputSize
      );

      res.setHeader(
        'X-Processing-Time',
        processingTime.toFixed(2)
      );

      res.setHeader(
        'X-Page-Count',
        String(pageCount)
      );

      res.setHeader(
        'X-Files-Merged',
        String(req.files.length)
      );

      res.setHeader(
        'X-Request-ID',
        requestId
      );

      responseStarted = true;

      console.log(
        `🚀 إرسال الملف - ${outputSize / 1024 / 1024} MB`
      );

      // ------------------------------------------------------
      // إرسال الملف كـ stream
      // ------------------------------------------------------

      const readStream = fs.createReadStream(
        outputPath,
        {
          highWaterMark:
            STREAM_HIGH_WATER_MARK
        }
      );

      req.on('aborted', () => {
        console.warn(
          `⚠️ العميل ألغى الطلب: ${requestId}`
        );

        readStream.destroy();
      });

      try {
        await pipeline(
          readStream,
          res
        );
      } catch (error) {
        // إذا أغلق العميل الاتصال فلا نحاول
        // إرسال JSON بعد بدء الاستجابة.
        console.warn(
          `⚠️ انقطع إرسال الملف: ${error.message}`
        );
      }

      const totalTime =
        (Date.now() - startTime) / 1000;

      console.log(
        `✅ اكتمل الطلب ${requestId} خلال ${totalTime.toFixed(2)} ثانية`
      );

    } catch (error) {
      console.error('');
      console.error(
        `❌ خطأ في الطلب ${requestId}:`
      );
      console.error(error);

      if (!responseStarted && !res.headersSent) {
        const status =
          error.message &&
          (
            error.message.includes('ليس PDF') ||
            error.message.includes('تعذر قراءة') ||
            error.message.includes('الصفحات')
          )
            ? 400
            : 500;

        return res.status(status).json({
          success: false,
          error:
            status === 400
              ? error.message
              : 'حدث خطأ أثناء دمج الملفات',
          requestId
        });
      }

    } finally {
      // ------------------------------------------------------
      // تنظيف نهائي
      // ------------------------------------------------------

      await removeDirectorySafe(tempDir);

      console.log(
        `🧹 تم تنظيف الملفات المؤقتة: ${requestId}`
      );

      console.log(
        `🧠 الذاكرة الحالية: ${getMemoryInfo().rss} MB RSS`
      );

      console.log(
        '----------------------------------------------'
      );
    }
  }
);

// ============================================================
// Health Check
// ============================================================

app.get('/health', async (req, res) => {
  const mem = getMemoryInfo();

  let tempRootExists = false;

  try {
    await fsp.access(TEMP_ROOT);
    tempRootExists = true;
  } catch {
    tempRootExists = false;
  }

  res.json({
    status: 'ok',

    timestamp:
      new Date().toISOString(),

    uptime:
      Math.round(process.uptime()),

    node:
      process.version,

    memory: {
      rss: `${mem.rss} MB`,
      heapTotal: `${mem.heapTotal} MB`,
      heapUsed: `${mem.heapUsed} MB`,
      external: `${mem.external} MB`,
      arrayBuffers: `${mem.arrayBuffers} MB`
    },

    limits: {
      maxFileSize:
        `${MAX_FILE_SIZE_MB} MB`,

      maxFiles:
        MAX_FILES,

      maxTotalSize:
        `${MAX_TOTAL_SIZE_MB} MB`,

      maxPages:
        MAX_PAGES
    },

    tempStorage: {
      available:
        tempRootExists
    }
  });
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  if (req.path === '/merge') {
    return res.status(405).json({
      success: false,
      error: 'طريقة الطلب غير مسموحة'
    });
  }

  res.status(404).json({
    success: false,
    error: 'المسار غير موجود'
  });
});

// ============================================================
// Error Handler
// ============================================================

app.use(
  async (err, req, res, next) => {
    console.error(
      '🔥 Error Handler:',
      err
    );

    // تنظيف الملفات في حالة فشل Multer
    if (req._pdfTempDir) {
      await removeDirectorySafe(
        req._pdfTempDir
      );
    }

    if (err instanceof multer.MulterError) {
      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          return res.status(413).json({
            success: false,
            error:
              `حجم الملف كبير جدًا. الحد الأقصى ${MAX_FILE_SIZE_MB} MB`
          });

        case 'LIMIT_FILE_COUNT':
          return res.status(413).json({
            success: false,
            error:
              `عدد الملفات تجاوز الحد الأقصى (${MAX_FILES})`
          });

        case 'LIMIT_UNEXPECTED_FILE':
          return res.status(413).json({
            success: false,
            error:
              `عدد الملفات أو اسم حقل الملفات غير صحيح. الحد الأقصى ${MAX_FILES} ملفات، والحقل يجب أن يكون pdfs`
          });

        case 'LIMIT_PART_COUNT':
          return res.status(413).json({
            success: false,
            error:
              'عدد أجزاء الطلب كبير جدًا'
          });

        case 'LIMIT_FIELD_KEY':
        case 'LIMIT_FIELD_VALUE':
        case 'LIMIT_FIELD_COUNT':
          return res.status(400).json({
            success: false,
            error:
              'بيانات الطلب غير صالحة'
          });

        default:
          return res.status(400).json({
            success: false,
            error:
              'خطأ أثناء رفع الملفات',
            details: err.message
          });
      }
    }

    // خطأ fileFilter
    if (
      err &&
      err.message ===
        'فقط ملفات PDF مسموح بها'
    ) {
      return res.status(400).json({
        success: false,
        error: err.message
      });
    }

    // خطأ عام
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error:
          'حدث خطأ داخلي في الخادم',
        details:
          process.env.NODE_ENV === 'production'
            ? undefined
            : err.message
      });
    }

    next(err);
  }
);

// ============================================================
// تشغيل الخادم
// ============================================================

async function startServer() {
  try {
    await ensureTempRoot();

    const server =
      app.listen(PORT, () => {
        const mem = getMemoryInfo();

        console.log('');
        console.log(
          '╔══════════════════════════════════════════════╗'
        );
        console.log(
          '║       🚀 PDF MERGER SERVER v4              ║'
        );
        console.log(
          '║       Railway Optimized                    ║'
        );
        console.log(
          '╠══════════════════════════════════════════════╣'
        );
        console.log(
          `║ 📡 Port: ${String(PORT).padEnd(33)}║`
        );
        console.log(
          `║ 💾 RSS: ${String(mem.rss + ' MB').padEnd(35)}║`
        );
        console.log(
          `║ 📦 Max files: ${String(MAX_FILES).padEnd(29)}║`
        );
        console.log(
          `║ 📄 Max file: ${String(MAX_FILE_SIZE_MB + ' MB').padEnd(30)}║`
        );
        console.log(
          `║ 📦 Max total: ${String(MAX_TOTAL_SIZE_MB + ' MB').padEnd(29)}║`
        );
        console.log(
          `║ 📑 Max pages: ${String(MAX_PAGES).padEnd(29)}║`
        );
        console.log(
          '╚══════════════════════════════════════════════╝'
        );
        console.log('');
      });

    // --------------------------------------------------------
    // Graceful shutdown
    // --------------------------------------------------------

    const shutdown = (signal) => {
      console.log(
        `🛑 استقبال ${signal}... إيقاف الخادم`
      );

      server.close(() => {
        console.log(
          '✅ تم إيقاف الخادم بأمان'
        );

        process.exit(0);
      });

      // إذا بقي شيء مفتوحًا أكثر من 10 ثوانٍ
      setTimeout(() => {
        console.error(
          '⚠️ Forced shutdown'
        );

        process.exit(1);
      }, 10000).unref();
    };

    process.on(
      'SIGTERM',
      () => shutdown('SIGTERM')
    );

    process.on(
      'SIGINT',
      () => shutdown('SIGINT')
    );

  } catch (error) {
    console.error(
      '❌ فشل تشغيل الخادم:',
      error
    );

    process.exit(1);
  }
}

startServer();

// ============================================================
// تنظيف دوري لمجلد TEMP
//
// في الظروف الطبيعية كل طلب ينظف مجلده في finally.
// هذا مجرد safety net في حالة crash أو انقطاع مفاجئ.
// ============================================================

setInterval(
  async () => {
    try {
      await ensureTempRoot();

      const entries =
        await fsp.readdir(
          TEMP_ROOT,
          {
            withFileTypes: true
          }
        );

      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const dir =
          path.join(
            TEMP_ROOT,
            entry.name
          );

        try {
          const stat =
            await fsp.stat(dir);

          // حذف المجلدات الأقدم من ساعة
          if (
            now - stat.mtimeMs >
            60 * 60 * 1000
          ) {
            await removeDirectorySafe(
              dir
            );

            console.log(
              `🧹 حذف temp قديم: ${entry.name}`
            );
          }
        } catch {
          // تجاهل الملف إذا اختفى أثناء الفحص
        }
      }
    } catch (error) {
      console.warn(
        '⚠️ فشل تنظيف TEMP:',
        error.message
      );
    }
  },
  10 * 60 * 1000
).unref();
